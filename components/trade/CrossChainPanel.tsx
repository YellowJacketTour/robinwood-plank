"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronRight } from "lucide-react";
import { CHAIN, TOKEN } from "@/lib/constants";
import { formatDisplayAmount, parseTokenAmount, shortAddress } from "@/lib/trade";
import { connectWallet, getConnectedAccounts, waitForTransaction } from "@/lib/wallet";
import { getWalletChainId, sendCrossChainStepTx, switchToChain } from "@/lib/crosschain-wallet";

type SourceChainOption = { chainId: number; name: string; nativeSymbol: string };

type StatusResponse = {
  enabled: boolean;
  configured?: boolean;
  sourceChains?: SourceChainOption[];
  siteFee?: { enabled: boolean; label: string };
  disclosure?: string;
};

type QuoteState = {
  raw: Record<string, unknown>;
  amountOut: string;
  routing: string;
  sourceChainId: number;
};

type PlanStep = {
  stepIndex: number;
  stepType?: string;
  method?: string;
  status: string;
  chainId?: number;
  payload?: Record<string, unknown>;
};

type PlanState = {
  planId: string;
  steps: PlanStep[];
  sourceChainId: number;
};

const LOCAL_STORAGE_KEY = "plank_crosschain_plan";

/**
 * Self-contained "Buy from another chain" panel — a distinct entry point,
 * not a toggle inside SwapWidget. Cross-chain settlement takes minutes and
 * multiple transactions across two chains, so it gets its own affordance,
 * explicit timing expectations, and a status/tracking view instead of
 * pretending to be an instant same-chain swap.
 *
 * Drop-in: renders nothing when the feature flag is off (checked via
 * /api/crosschain/status), so it is safe to mount unconditionally on any
 * page (e.g. app/trade/page.tsx) without a separate gate.
 */
export default function CrossChainPanel() {
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [loadingStatus, setLoadingStatus] = useState(true);

  const [account, setAccount] = useState<string | null>(null);
  const [sourceChainId, setSourceChainId] = useState<number | null>(null);
  const [amountIn, setAmountIn] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [quote, setQuote] = useState<QuoteState | null>(null);
  // Lazy initializer (not an effect) — reading localStorage here is a pure
  // sync read on first render, not a setState-in-effect cascade.
  const [plan, setPlan] = useState<PlanState | null>(() => {
    if (typeof window === "undefined") return null;
    try {
      const saved = window.localStorage.getItem(LOCAL_STORAGE_KEY);
      if (!saved) return null;
      const parsed = JSON.parse(saved) as PlanState;
      return parsed?.planId ? parsed : null;
    } catch {
      return null;
    }
  });

  useEffect(() => {
    let cancelled = false;
    fetch("/api/crosschain/status")
      .then((r) => r.json())
      .then((d: StatusResponse) => {
        if (cancelled) return;
        setStatus(d);
        if (d.sourceChains?.[0]) setSourceChainId(d.sourceChains[0].chainId);
      })
      .catch(() => {
        if (!cancelled) setStatus({ enabled: false });
      })
      .finally(() => {
        if (!cancelled) setLoadingStatus(false);
      });
    void getConnectedAccounts().then((accounts) => {
      if (!cancelled && accounts[0]) setAccount(accounts[0]);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const source = useMemo(
    () => status?.sourceChains?.find((c) => c.chainId === sourceChainId) ?? null,
    [status, sourceChainId]
  );

  const handleConnect = useCallback(async () => {
    setError(null);
    try {
      setBusy(true);
      const addr = await connectWallet();
      setAccount(addr);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to connect wallet.");
    } finally {
      setBusy(false);
    }
  }, []);

  const fetchQuote = useCallback(async () => {
    if (!source) return;
    setError(null);
    setStatusMsg(null);
    setQuote(null);

    const raw = parseTokenAmount(amountIn, 18);
    if (raw === null || raw <= BigInt(0)) {
      setError("Enter a valid amount.");
      return;
    }

    try {
      setBusy(true);
      setStatusMsg("Quoting…");
      const res = await fetch("/api/crosschain/quote", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sourceChainId: source.chainId,
          amount: raw.toString(),
          swapper: account || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || data.error || "Quote failed.");
      if (!data.amountOut) throw new Error("Quote missing output amount.");
      setQuote({
        raw: data,
        amountOut: data.amountOut,
        routing: data.routing,
        sourceChainId: source.chainId,
      });
      setStatusMsg(
        data.indicative
          ? "Price quote ready — connect a wallet to start the transfer."
          : `Quote ready (${data.routing === "CHAINED" ? "bridge + swap" : "bridge"}).`
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Quote failed.");
    } finally {
      setBusy(false);
    }
  }, [source, amountIn, account]);

  const savePlan = useCallback((next: PlanState | null) => {
    setPlan(next);
    try {
      if (next) window.localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(next));
      else window.localStorage.removeItem(LOCAL_STORAGE_KEY);
    } catch {
      /* best-effort only — tracking still works in-session without it */
    }
  }, []);

  const pollPlan = useCallback(async (planId: string, srcChainId: number): Promise<PlanStep[]> => {
    const res = await fetch(
      `/api/crosschain/plan?planId=${encodeURIComponent(planId)}&sourceChainId=${srcChainId}&forceRefresh=true`
    );
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || data.error || "Could not fetch plan status.");
    return (data.steps || []) as PlanStep[];
  }, []);

  const runStep = useCallback(
    async (planId: string, step: PlanStep, addr: string) => {
      const chainId = step.chainId;
      const payload = step.payload;
      if (!chainId || !payload || typeof payload.to !== "string" || typeof payload.data !== "string") {
        throw new Error("This step isn't a transaction we can execute automatically. Check the explorer.");
      }
      const current = await getWalletChainId();
      if (current !== chainId) {
        setStatusMsg(`Switch network to chain ${chainId}…`);
        await switchToChain(chainId);
      }
      setStatusMsg(`Confirm transaction in wallet (chain ${chainId})…`);
      const hash = await sendCrossChainStepTx(chainId, addr, {
        to: payload.to,
        data: payload.data,
        value: typeof payload.value === "string" ? payload.value : undefined,
        gas: typeof payload.gas === "string" ? payload.gas : undefined,
        gasLimit: typeof payload.gasLimit === "string" ? payload.gasLimit : undefined,
      });
      setStatusMsg("Waiting for confirmation — this leg can take a few minutes…");
      await waitForTransaction(hash, { label: "Cross-chain step", timeoutMs: 300_000 });

      setStatusMsg("Reporting completed step…");
      const res = await fetch("/api/crosschain/plan/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ planId, stepIndex: step.stepIndex, txHash: hash, chainId }),
      });
      const data = await res.json();
      if (!res.ok && !data.retryable) {
        throw new Error(data.message || data.error || "Step was rejected.");
      }
    },
    []
  );

  const startTransfer = useCallback(async () => {
    if (!quote || !account || !source) return;
    setError(null);
    setBusy(true);
    try {
      setStatusMsg("Refreshing quote…");
      const qRes = await fetch("/api/crosschain/quote", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sourceChainId: source.chainId,
          amount: parseTokenAmount(amountIn, 18)?.toString(),
          swapper: account,
        }),
      });
      const qData = await qRes.json();
      if (!qRes.ok) throw new Error(qData.message || qData.error || "Could not refresh quote.");

      setStatusMsg("Building transfer plan…");
      const planRes = await fetch("/api/crosschain/plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          quote: qData.quote ?? qData,
          routing: qData.routing,
          sourceChainId: source.chainId,
        }),
      });
      const planData = await planRes.json();
      if (!planRes.ok) throw new Error(planData.message || planData.error || "Could not build plan.");

      let steps = (planData.steps || []) as PlanStep[];
      let current: PlanState = { planId: planData.planId, steps, sourceChainId: source.chainId };
      savePlan(current);

      // Walk steps until every one is COMPLETE or one hits STEP_ERROR.
      for (;;) {
        const next = steps.find((s) => s.status === "AWAITING_ACTION" || s.status === "NOT_READY");
        if (!next) break;
        if (next.status === "NOT_READY") {
          setStatusMsg("Waiting on a prior step to finish…");
          await new Promise((r) => setTimeout(r, 5000));
          steps = await pollPlan(current.planId, source.chainId);
          current = { ...current, steps };
          savePlan(current);
          continue;
        }
        await runStep(current.planId, next, account);
        steps = await pollPlan(current.planId, source.chainId);
        current = { ...current, steps };
        savePlan(current);
        const errored = steps.find((s) => s.status === "STEP_ERROR");
        if (errored) {
          throw new Error(
            "A step failed on-chain. You may be holding an intermediate token instead of $PLANK — check the tracker below and the explorer before retrying."
          );
        }
      }

      setStatusMsg("Transfer complete — check your $PLANK balance on Robinhood Chain.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Transfer failed.");
    } finally {
      setBusy(false);
    }
  }, [quote, account, source, amountIn, savePlan, pollPlan, runStep]);

  const refreshTrackedPlan = useCallback(async () => {
    if (!plan) return;
    setBusy(true);
    setError(null);
    try {
      const steps = await pollPlan(plan.planId, plan.sourceChainId);
      savePlan({ ...plan, steps });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not refresh status.");
    } finally {
      setBusy(false);
    }
  }, [plan, pollPlan, savePlan]);

  if (loadingStatus) return null;
  if (!status?.enabled) return null;

  const estimatedOut = quote ? formatDisplayAmount(quote.amountOut, TOKEN.decimals) : "—";

  return (
    <div className="wood-ledger space-y-2.5 p-2.5 sm:p-3">
      <div>
        <h3 className="text-sm font-bold uppercase tracking-wide text-gold-300">
          Buy from another chain
        </h3>
        <p className="mt-1 text-[0.7rem] leading-snug text-foreground/60">
          {status.disclosure ||
            `Bridges into official $PLANK on ${CHAIN.name}. This takes several minutes and multiple wallet confirmations across two chains — not an instant swap.`}
        </p>
      </div>

      {status.configured === false && (
        <p className="rounded-lg border border-gold-500/30 bg-wood-900/90 px-2.5 py-2 text-center text-[0.7rem] text-foreground/70">
          Cross-chain routing is offline right now.
        </p>
      )}

      {status.configured !== false && (
        <>
          <label className="block">
            <span className="text-[0.65rem] font-bold uppercase tracking-wider text-foreground/50">
              From chain
            </span>
            <select
              value={sourceChainId ?? ""}
              onChange={(e) => {
                setSourceChainId(Number(e.target.value));
                setQuote(null);
              }}
              className="mt-1 min-h-10 w-full rounded-lg border border-gold-500/30 bg-wood-950 px-2.5 py-2 text-sm text-foreground"
            >
              {status.sourceChains?.map((c) => (
                <option key={c.chainId} value={c.chainId}>
                  {c.name} ({c.nativeSymbol})
                </option>
              ))}
            </select>
          </label>

          <label className="block">
            <span className="text-[0.65rem] font-bold uppercase tracking-wider text-foreground/50">
              You pay ({source?.nativeSymbol || "native token"})
            </span>
            <input
              type="text"
              inputMode="decimal"
              placeholder="0.0"
              value={amountIn}
              onChange={(e) => {
                setAmountIn(e.target.value.replace(/[^0-9.]/g, ""));
                setQuote(null);
              }}
              className="mt-1 min-h-11 w-full rounded-lg border border-gold-500/30 bg-wood-900/90 px-2.5 py-2 text-lg font-semibold text-foreground outline-none placeholder:text-foreground/30 focus:border-gold-400"
            />
          </label>

          <div className="rounded-lg border border-gold-500/20 bg-wood-950/60 px-2.5 py-2 text-sm text-foreground/80">
            You receive ≈ {estimatedOut} {TOKEN.symbol}
          </div>

          {quote && (
            <p className="text-[0.65rem] text-amber-200/90">
              Route: {quote.routing === "CHAINED" ? "bridge + destination swap" : "bridge"}. If the
              final step fails after the bridge completes, you may end up holding an intermediate
              token on {CHAIN.name} instead of {TOKEN.symbol} — use the tracker below to resume or
              check the explorer.
            </p>
          )}

          <div className="flex flex-col gap-2">
            {!account ? (
              <button
                type="button"
                disabled={busy}
                onClick={handleConnect}
                className="min-h-11 rounded-lg bg-gold-500 px-3 py-2.5 text-sm font-bold text-wood-950 transition-colors hover:bg-gold-400 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {busy ? "Connecting…" : "Connect wallet"}
              </button>
            ) : (
              <p className="text-xs text-gold-300" title={account}>
                {shortAddress(account)}
              </p>
            )}

            <button
              type="button"
              disabled={busy || !amountIn || !source}
              onClick={fetchQuote}
              className="min-h-11 rounded-lg border border-gold-500/55 bg-wood-900 px-3 py-2.5 text-sm font-bold text-gold-300 transition-colors hover:border-gold-400 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy && !quote ? "Quoting…" : "Get quote"}
            </button>

            {quote && account && (
              <button
                type="button"
                disabled={busy}
                onClick={startTransfer}
                className="min-h-11 rounded-lg bg-gold-500 px-3 py-2.5 text-sm font-bold text-wood-950 shadow-[0_6px_16px_-4px_rgba(217,164,65,0.45)] transition-colors hover:bg-gold-400 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {busy ? "In progress…" : "Start transfer"}
              </button>
            )}
          </div>
        </>
      )}

      {plan && (
        <details className="group rounded-lg border border-gold-500/15 bg-wood-950/40 px-2.5 py-1.5 text-[0.7rem] text-foreground/60" open>
          <summary className="flex cursor-pointer list-none items-center justify-between gap-2 font-bold uppercase tracking-wide text-foreground/50">
            <span>Track this transfer</span>
            <ChevronRight size={13} className="shrink-0 transition-transform group-open:rotate-90" />
          </summary>
          <div className="mt-1.5 space-y-1">
            <p className="font-mono text-foreground/70">Plan {shortAddress(plan.planId, 6)}</p>
            {plan.steps.map((s, i) => (
              <p key={i}>
                Step {s.stepIndex ?? i}: {s.stepType || "step"} — {s.status}
              </p>
            ))}
            <button
              type="button"
              disabled={busy}
              onClick={refreshTrackedPlan}
              className="mt-1 rounded-md border border-gold-500/40 px-2 py-1 text-[0.65rem] font-bold text-gold-300 hover:border-gold-400 disabled:opacity-50"
            >
              Refresh status
            </button>
          </div>
        </details>
      )}

      {(statusMsg || error) && (
        <div className="space-y-1 text-center text-xs">
          {statusMsg && (
            <p className="text-forest-600" role="status">
              {statusMsg}
            </p>
          )}
          {error && (
            <p className="text-red-300" role="alert">
              {error}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
