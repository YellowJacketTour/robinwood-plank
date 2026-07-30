"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowRight, Loader2, ShieldAlert, Zap } from "lucide-react";
import { TOKEN } from "@/lib/constants";
import { formatDisplayAmount, parseTokenAmount, shortAddress } from "@/lib/trade";
import { connectWallet, getConnectedAccounts } from "@/lib/wallet";
import { getWalletChainId, sendCrossChainStepTx, switchToChain } from "@/lib/crosschain-wallet";

type SourceChainOption = { chainId: number; name: string };

type StatusResponse = {
  enabled: boolean;
  crossChainEnabled?: boolean;
  configured?: boolean;
  sourceChains?: SourceChainOption[];
  siteFee?: { enabled: boolean; label: string };
  disclosure?: string;
};

type ZeroXCrossChainQuote = {
  liquidityAvailable: boolean;
  buyAmount: string;
  minBuyAmount?: string;
  estimatedTimeSeconds?: number;
  zeroExFeeDisclosure?: string;
  transaction: { chainType: string; to: string; data: string; value: string; gas?: string } | null;
  quoteId?: string;
};

type Lifecycle =
  | "origin_tx_pending"
  | "origin_tx_confirmed"
  | "bridge_pending"
  | "bridge_filled"
  | "bridge_failed"
  | "unknown";

type StatusPollResponse = { lifecycle: Lifecycle };

type ErrorBody = { error: string; message: string };

const LIFECYCLE_LABEL: Record<Lifecycle, string> = {
  origin_tx_pending: "Waiting for the source-chain transaction to confirm…",
  origin_tx_confirmed: "Source transaction confirmed — bridge is picking it up…",
  bridge_pending: "Bridging to Robinhood Chain…",
  bridge_filled: "Done — $PLANK delivered on Robinhood Chain.",
  bridge_failed: "Bridge leg failed — funds may need manual recovery. See disclosure below.",
  unknown: "Checking settlement status…",
};

/** Stop polling once we've reached a terminal state. */
function isTerminal(l: Lifecycle): boolean {
  return l === "bridge_filled" || l === "bridge_failed";
}

/**
 * TRUE one-step cross-chain buy into $PLANK via 0x's Cross-Chain API — a
 * single quote + single signed transaction on the SOURCE chain, no separate
 * bridge-then-swap flow. This is the feature that (if 0x's live routers find
 * liquidity for $PLANK) beats the two-step Uniswap-bridge fallback: one
 * transaction from the user's wallet instead of a multi-step plan across two
 * chains and two signatures.
 *
 * Drop-in: renders nothing when /api/zerox/status reports crossChainEnabled
 * off or the server unconfigured, so it's safe to mount unconditionally
 * (e.g. next to CrossChainPanel.tsx on app/trade/page.tsx) without a
 * separate gate. Distinct component/localStorage namespace from
 * CrossChainPanel.tsx — this is a parallel provider, not a replacement.
 */
export default function ZeroXCrossChainPanel() {
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [checkedStatus, setCheckedStatus] = useState(false);

  const [account, setAccount] = useState<string | null>(null);
  const [sourceChainId, setSourceChainId] = useState<number | null>(null);
  const [amountIn, setAmountIn] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);
  const [quote, setQuote] = useState<ZeroXCrossChainQuote | null>(null);
  const [lifecycle, setLifecycle] = useState<Lifecycle | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/zerox/status")
      .then((r) => r.json())
      .then((d: StatusResponse) => {
        if (cancelled) return;
        setStatus(d);
        if (d.sourceChains?.[0]) setSourceChainId(d.sourceChains[0].chainId);
      })
      .catch(() => {
        if (!cancelled) setStatus({ enabled: false, crossChainEnabled: false });
      })
      .finally(() => {
        if (!cancelled) setCheckedStatus(true);
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

  const handleGetQuote = useCallback(async () => {
    if (!account || !sourceChainId) return;
    setError(null);
    setTxHash(null);
    setQuote(null);
    const base = parseTokenAmount(amountIn, 18);
    if (!base || base <= BigInt(0)) {
      setError("Enter an amount greater than zero.");
      return;
    }
    setBusy(true);
    try {
      const res = await fetch("/api/zerox/crosschain/quote", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sourceChainId,
          amount: base.toString(),
          recipient: account,
        }),
      });
      const body = (await res.json().catch(() => ({}))) as ZeroXCrossChainQuote | ErrorBody;
      if (!res.ok || "error" in body) {
        setError((body as ErrorBody).message || "0x could not build a cross-chain quote.");
        return;
      }
      setQuote(body as ZeroXCrossChainQuote);
    } catch {
      setError("Could not reach 0x cross-chain quoting.");
    } finally {
      setBusy(false);
    }
  }, [account, sourceChainId, amountIn]);

  const handleSend = useCallback(async () => {
    if (!account || !sourceChainId || !quote?.transaction) return;
    setError(null);
    setBusy(true);
    try {
      const current = await getWalletChainId();
      if (current !== sourceChainId) {
        await switchToChain(sourceChainId);
      }
      const hash = await sendCrossChainStepTx(sourceChainId, account, {
        to: quote.transaction.to,
        data: quote.transaction.data,
        value: quote.transaction.value,
        gas: quote.transaction.gas,
      });
      setTxHash(hash);
      setLifecycle("origin_tx_pending");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Transaction failed.");
    } finally {
      setBusy(false);
    }
  }, [account, sourceChainId, quote]);

  // Poll settlement once the origin-chain tx is sent. This is NON-ATOMIC
  // cross-chain — the origin tx can confirm while the bridge leg fails —
  // so the UI must show real settlement state, not assume success once the
  // wallet returns a hash.
  useEffect(() => {
    if (!txHash || !sourceChainId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    async function poll() {
      try {
        const qs = new URLSearchParams({
          originChain: String(sourceChainId),
          originTxHash: txHash as string,
          ...(quote?.quoteId ? { quoteId: quote.quoteId } : {}),
        });
        const res = await fetch(`/api/zerox/crosschain/status?${qs.toString()}`);
        const body = (await res.json().catch(() => ({}))) as StatusPollResponse | ErrorBody;
        if (cancelled) return;
        if (res.ok && "lifecycle" in body) {
          setLifecycle(body.lifecycle);
          if (!isTerminal(body.lifecycle)) {
            timer = setTimeout(poll, 4000);
          }
        } else {
          timer = setTimeout(poll, 6000);
        }
      } catch {
        if (!cancelled) timer = setTimeout(poll, 6000);
      }
    }

    void poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [txHash, sourceChainId, quote?.quoteId]);

  if (!checkedStatus || !status?.crossChainEnabled) return null;

  if (!status.configured) {
    return (
      <div className="flex items-start gap-2 rounded-lg border border-gold-500/20 bg-wood-950/40 px-2.5 py-2 text-[0.7rem] text-foreground/50">
        <ShieldAlert size={13} className="mt-0.5 shrink-0" />
        <span>One-step cross-chain via 0x is not configured on the server yet.</span>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2.5 rounded-lg border border-gold-500/20 bg-wood-950/40 px-3 py-2.5 text-xs">
      <div className="flex items-center gap-1.5 font-bold uppercase tracking-wide text-foreground/70">
        <Zap size={13} className="shrink-0 text-gold-400" />
        Buy $PLANK from another chain — one step (0x)
      </div>

      {!account ? (
        <button
          type="button"
          onClick={handleConnect}
          disabled={busy}
          className="rounded-lg border border-gold-500/30 bg-wood-900/60 px-3 py-2 font-bold text-foreground/80 disabled:opacity-50"
        >
          Connect wallet
        </button>
      ) : (
        <>
          <div className="text-foreground/50">Connected: {shortAddress(account)}</div>

          <select
            value={sourceChainId ?? ""}
            onChange={(e) => {
              setSourceChainId(Number(e.target.value));
              setQuote(null);
              setTxHash(null);
            }}
            className="rounded-lg border border-gold-500/20 bg-wood-950/60 px-2 py-1.5 text-foreground/80"
          >
            {status.sourceChains?.map((c) => (
              <option key={c.chainId} value={c.chainId}>
                {c.name}
              </option>
            ))}
          </select>

          <input
            value={amountIn}
            onChange={(e) => {
              setAmountIn(e.target.value);
              setQuote(null);
              setTxHash(null);
            }}
            placeholder={`Amount of ${source?.name ?? ""} native token`}
            inputMode="decimal"
            className="rounded-lg border border-gold-500/20 bg-wood-950/60 px-2 py-1.5 text-foreground/80"
          />

          {!quote ? (
            <button
              type="button"
              onClick={handleGetQuote}
              disabled={busy || !amountIn}
              className="rounded-lg border border-gold-500/30 bg-wood-900/60 px-3 py-2 font-bold text-foreground/80 disabled:opacity-50"
            >
              {busy ? <Loader2 size={14} className="mx-auto animate-spin" /> : "Get 0x quote"}
            </button>
          ) : (
            <div className="flex flex-col gap-1.5 rounded-lg border border-gold-500/20 bg-wood-950/40 px-2.5 py-2">
              <div className="flex items-center gap-1 text-foreground/80">
                <ArrowRight size={12} className="shrink-0 text-gold-400" />
                <span>~{formatDisplayAmount(quote.buyAmount, TOKEN.decimals)} PLANK</span>
              </div>
              {typeof quote.estimatedTimeSeconds === "number" && (
                <div className="text-foreground/50">
                  Est. settlement: ~{Math.max(1, Math.round(quote.estimatedTimeSeconds))}s
                </div>
              )}
              {quote.zeroExFeeDisclosure && (
                <div className="text-[0.65rem] text-gold-300/80">{quote.zeroExFeeDisclosure}</div>
              )}
              {!txHash && (
                <div className="flex items-start gap-1.5 rounded-md border border-red-500/20 bg-red-950/20 px-2 py-1.5 text-[0.65rem] text-red-200/80">
                  <ShieldAlert size={12} className="mt-0.5 shrink-0" />
                  <span>
                    Cross-chain settlement is NOT atomic: this is two chains and a bridge, not a
                    single-chain swap. If the bridge leg fails after your {source?.name} transaction
                    confirms, your funds may come back as a different token than you sent, and not
                    automatically as $PLANK. Only proceed with an amount you can afford to have stuck
                    pending manual recovery.
                  </span>
                </div>
              )}
              <button
                type="button"
                onClick={handleSend}
                disabled={busy || !quote.transaction || Boolean(txHash)}
                className="mt-1 rounded-lg border border-forest-500/40 bg-forest-900/40 px-3 py-2 font-bold text-forest-200 disabled:opacity-50"
              >
                {busy ? <Loader2 size={14} className="mx-auto animate-spin" /> : `Send on ${source?.name}`}
              </button>
            </div>
          )}

          {txHash && (
            <div className="flex flex-col gap-1 rounded-lg border border-gold-500/20 bg-wood-950/40 px-2.5 py-2">
              <div className="text-forest-300">Submitted: {shortAddress(txHash, 6)}</div>
              <div
                className={
                  lifecycle === "bridge_failed"
                    ? "text-red-300"
                    : lifecycle === "bridge_filled"
                      ? "text-forest-300"
                      : "text-foreground/60"
                }
              >
                {LIFECYCLE_LABEL[lifecycle ?? "unknown"]}
              </div>
              {lifecycle === "bridge_failed" && (
                <div className="text-[0.65rem] text-red-200/80">
                  The bridge leg did not complete. Check {source?.name}&apos;s explorer for tx{" "}
                  {shortAddress(txHash, 6)} — any refund may be in an intermediate token, not $PLANK.
                  Contact support with this transaction hash if funds don&apos;t appear within a few
                  minutes.
                </div>
              )}
            </div>
          )}
        </>
      )}

      {error && <div className="text-red-300">{error}</div>}
    </div>
  );
}
