"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { CHAIN, TOKEN } from "@/lib/constants";
import { formatDisplayAmount, parseTokenAmount, shortAddress } from "@/lib/trade";
import {
  connectWallet,
  ensureRobinhoodChain,
  getConnectedAccounts,
  getNativeBalance,
  waitForTransaction,
} from "@/lib/wallet";
import {
  getSourceChainExplorerUrl,
  getWalletChainId,
  sendCrossChainStepTx,
  switchToChain,
} from "@/lib/crosschain-wallet";

type SourceChainOption = { chainId: number; name: string; nativeSymbol: string };

type StatusResponse = {
  enabled: boolean;
  configured?: boolean;
  sourceChains?: SourceChainOption[];
  disclosure?: string;
  stepTwo?: string;
};

type BridgeQuote = {
  quoteWrapper: Record<string, unknown>;
  amountOut: string;
  estimatedFillTimeMs: number | null;
  feeNote: string;
  sourceChainId: number;
};

type Phase = "idle" | "quoted" | "sending" | "sent" | "checked";

/**
 * "Buy from another chain" panel — bridge-then-swap.
 *
 * Uniswap's CHAINED router does not currently stitch a source-chain ->
 * $PLANK hop for this pair (confirmed empirically, not $PLANK-specific —
 * see app/api/crosschain/quote for the dormant scaffolding kept for when
 * that changes upstream). What works today: bridging native currency into
 * native ETH on Robinhood Chain in one transaction (BRIDGE routing,
 * confirmed live), then swapping that ETH for $PLANK through the existing
 * same-chain widget. This panel does step one and hands off to step two —
 * it never touches SwapWidget.tsx directly.
 *
 * Self-contained: renders nothing when /api/crosschain/status reports the
 * feature flag off, so it's safe to drop into any page unconditionally.
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
  const [quote, setQuote] = useState<BridgeQuote | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [txHash, setTxHash] = useState<string | null>(null);
  const [destBalance, setDestBalance] = useState<bigint | null>(null);

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
    setPhase("idle");
    setTxHash(null);
    setDestBalance(null);

    const raw = parseTokenAmount(amountIn, 18);
    if (raw === null || raw <= BigInt(0)) {
      setError("Enter a valid amount.");
      return;
    }

    try {
      setBusy(true);
      setStatusMsg("Quoting bridge…");
      const res = await fetch("/api/crosschain/bridge/quote", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sourceChainId: source.chainId,
          amount: raw.toString(),
          swapper: account || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || data.error || "Bridge quote failed.");
      if (!data.amountOut) throw new Error("Quote missing output amount.");
      setQuote({
        quoteWrapper: data.quote,
        amountOut: data.amountOut,
        estimatedFillTimeMs: data.estimatedFillTimeMs ?? null,
        feeNote: data.fee?.note || "No plank.love fee on this bridge step.",
        sourceChainId: source.chainId,
      });
      setPhase("quoted");
      setStatusMsg(account ? "Quote ready." : "Price quote ready — connect a wallet to bridge.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Bridge quote failed.");
    } finally {
      setBusy(false);
    }
  }, [source, amountIn, account]);

  const startBridge = useCallback(async () => {
    if (!quote || !account || !source) return;
    setError(null);
    setBusy(true);
    setPhase("sending");
    try {
      setStatusMsg("Refreshing quote with your wallet…");
      const raw = parseTokenAmount(amountIn, 18);
      if (raw === null || raw <= BigInt(0)) throw new Error("Enter a valid amount.");

      const qRes = await fetch("/api/crosschain/bridge/quote", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sourceChainId: source.chainId,
          amount: raw.toString(),
          swapper: account,
        }),
      });
      const qData = await qRes.json();
      if (!qRes.ok) throw new Error(qData.message || qData.error || "Could not refresh quote.");

      setStatusMsg("Building bridge transaction…");
      const swapRes = await fetch("/api/crosschain/bridge/swap", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ quote: qData.quote }),
      });
      const swapData = await swapRes.json();
      if (!swapRes.ok) {
        throw new Error(swapData.message || swapData.error || "Could not build the bridge transaction.");
      }

      const tx = swapData.swap as {
        to: string;
        data: string;
        value?: string;
        gas?: string;
        gasLimit?: string;
        maxFeePerGas?: string;
        maxPriorityFeePerGas?: string;
      };
      if (!tx?.to || !tx?.data) throw new Error("Invalid bridge transaction from Uniswap.");

      setStatusMsg(`Switch to ${source.name}…`);
      const current = await getWalletChainId();
      if (current !== source.chainId) {
        await switchToChain(source.chainId);
      }

      setStatusMsg("Confirm in wallet…");
      const hash = await sendCrossChainStepTx(source.chainId, account, tx);
      setTxHash(hash);
      setPhase("sent");
      setStatusMsg("Waiting for the origin transaction to confirm…");
      await waitForTransaction(hash, { label: "Bridge transaction", timeoutMs: 180_000 });
      setStatusMsg(
        "Origin transaction confirmed. The bridge fill on Robinhood Chain is now in progress — this typically takes minutes, not seconds."
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Bridge failed.");
    } finally {
      setBusy(false);
    }
  }, [quote, account, source, amountIn]);

  const checkArrival = useCallback(async () => {
    if (!account) return;
    setError(null);
    setBusy(true);
    try {
      setStatusMsg("Switching to Robinhood Chain…");
      await ensureRobinhoodChain();
      const bal = await getNativeBalance(account);
      setDestBalance(bal);
      setPhase("checked");
      setStatusMsg("Balance checked.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not check balance.");
    } finally {
      setBusy(false);
    }
  }, [account]);

  if (loadingStatus) return null;
  if (!status?.enabled) return null;

  const estimatedOut = quote ? formatDisplayAmount(quote.amountOut, 18) : "—";
  const explorerUrl = source ? getSourceChainExplorerUrl(source.chainId) : null;

  return (
    <div className="wood-ledger space-y-2.5 p-2.5 sm:p-3">
      <div>
        <h3 className="text-sm font-bold uppercase tracking-wide text-gold-300">
          Buy from another chain
        </h3>
        <p className="mt-1 text-[0.7rem] leading-snug text-foreground/60">
          Bridge ETH from another chain into Robinhood Chain, then swap it for {TOKEN.symbol} — two
          transactions, not an instant swap.
        </p>
      </div>

      {/* Owner-approved disclaimer, shown before any commitment — plain
          language, not legal boilerplate. */}
      <div className="space-y-2 rounded-xl border border-amber-400/40 bg-amber-400/10 p-3">
        <p className="text-sm font-bold text-amber-100">Before you bridge</p>
        <ul className="list-disc space-y-1 pl-4 text-[0.75rem] text-amber-50/90">
          <li>This is two transactions across two chains and takes minutes, not seconds.</li>
          <li>Don&apos;t close this tab while a step is in progress.</li>
          <li>
            Bridging is executed by a third party (Across, via Uniswap) — plank.love doesn&apos;t
            control settlement timing.
          </li>
          <li>
            If the bridge step fails after your funds leave your wallet, you may end up holding ETH
            on {CHAIN.name} instead of completing the transfer — that ETH is yours, spendable, and
            swappable, not stranded in an unfamiliar token.
          </li>
          <li>Every step below gives you a transaction hash and an explorer link.</li>
          <li>{status.stepTwo || `Step 2 (swap for ${TOKEN.symbol}) carries the normal 0.4207% fee.`}</li>
        </ul>
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
                setPhase("idle");
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
              You bridge ({source?.nativeSymbol || "native token"})
            </span>
            <input
              type="text"
              inputMode="decimal"
              placeholder="0.0"
              value={amountIn}
              onChange={(e) => {
                setAmountIn(e.target.value.replace(/[^0-9.]/g, ""));
                setQuote(null);
                setPhase("idle");
              }}
              className="mt-1 min-h-11 w-full rounded-lg border border-gold-500/30 bg-wood-900/90 px-2.5 py-2 text-lg font-semibold text-foreground outline-none placeholder:text-foreground/30 focus:border-gold-400"
            />
          </label>

          <div className="rounded-lg border border-gold-500/20 bg-wood-950/60 px-2.5 py-2 text-sm text-foreground/80">
            You receive ≈ {estimatedOut} ETH on {CHAIN.name}
          </div>

          {quote && (
            <div className="space-y-1 text-[0.65rem] text-foreground/60">
              <p>
                {quote.estimatedFillTimeMs != null
                  ? `Provider estimate: ~${Math.round(quote.estimatedFillTimeMs / 1000)}s (unguaranteed — real bridges vary).`
                  : "No timing estimate returned — expect several minutes, unguaranteed."}
              </p>
              <p>{quote.feeNote}</p>
            </div>
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
              {busy && !quote ? "Quoting…" : "Get bridge quote"}
            </button>

            {quote && account && phase !== "sent" && phase !== "checked" && (
              <button
                type="button"
                disabled={busy}
                onClick={startBridge}
                className="min-h-11 rounded-lg bg-gold-500 px-3 py-2.5 text-sm font-bold text-wood-950 shadow-[0_6px_16px_-4px_rgba(217,164,65,0.45)] transition-colors hover:bg-gold-400 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {busy ? "In progress…" : "Start bridge"}
              </button>
            )}

            {(phase === "sent" || phase === "checked") && (
              <button
                type="button"
                disabled={busy}
                onClick={checkArrival}
                className="min-h-11 rounded-lg border border-forest-600/55 bg-forest-900/40 px-3 py-2.5 text-sm font-bold text-gold-300 transition-colors hover:border-forest-500 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {busy ? "Checking…" : "Check my Robinhood Chain balance"}
              </button>
            )}
          </div>
        </>
      )}

      {txHash && (
        <div className="rounded-lg border border-gold-500/15 bg-wood-950/40 px-2.5 py-2 text-[0.7rem] text-foreground/70">
          <p className="font-bold uppercase tracking-wide text-foreground/50">Origin transaction</p>
          <p className="mt-1 break-all font-mono">
            {explorerUrl ? (
              <a
                href={`${explorerUrl}/tx/${txHash}`}
                target="_blank"
                rel="noopener noreferrer"
                className="underline hover:text-gold-300"
              >
                {shortAddress(txHash, 6)}
              </a>
            ) : (
              shortAddress(txHash, 6)
            )}
          </p>
        </div>
      )}

      {destBalance !== null && (
        <div className="rounded-lg border border-forest-600/40 bg-forest-900/30 px-2.5 py-2 text-[0.75rem] text-foreground/80">
          Current ETH balance on {CHAIN.name}: {formatDisplayAmount(destBalance, 18)} ETH
        </div>
      )}

      {(phase === "sent" || phase === "checked") && (
        <div className="rounded-xl border border-gold-500/35 bg-wood-900/90 px-3 py-2.5 text-sm">
          <p className="font-bold text-gold-300">Step 2: swap for {TOKEN.symbol}</p>
          <p className="mt-1 text-[0.75rem] text-foreground/70">
            Once your ETH shows up on {CHAIN.name}, use the trade widget to swap it for{" "}
            {TOKEN.symbol} — the normal 0.4207% fee applies there.
          </p>
          <a
            href="/trade"
            className="mt-2 inline-block text-[0.75rem] font-bold text-gold-300 underline underline-offset-2 hover:text-gold-200"
          >
            Go to the trade widget →
          </a>
        </div>
      )}

      <details className="group rounded-lg border border-gold-500/15 bg-wood-950/40 px-2.5 py-1.5 text-[0.7rem] text-foreground/55">
        <summary className="cursor-pointer font-bold uppercase tracking-wide text-foreground/50">
          If something gets stuck
        </summary>
        <div className="mt-1.5 space-y-1">
          <p>
            If the origin transaction fails or reverts, only gas was spent — your funds never left
            your wallet.
          </p>
          <p>
            If it confirms but ETH doesn&apos;t show up on {CHAIN.name} within a reasonable time,
            check the origin transaction link above to confirm it succeeded, then use &quot;Check my
            Robinhood Chain balance&quot; again — bridge fills can take longer during network
            congestion. There is no separate order ID to look up; the transaction hash above is the
            full record of what you sent.
          </p>
        </div>
      </details>

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
