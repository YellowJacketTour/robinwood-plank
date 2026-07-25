"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  CHAIN,
  CONTRACT_ADDRESS,
  NATIVE_TOKEN_ADDRESS,
  RULES_RELAXED,
  SITE_FEE,
  TOKEN,
} from "@/lib/constants";
import {
  buildUniswapSwapUrl,
  explorerTokenUrl,
  formatTokenAmount,
  parseTokenAmount,
  QUOTE_MAX_AGE_MS,
  shortAddress,
} from "@/lib/trade";
import {
  connectWallet,
  ensureRobinhoodChain,
  getConnectedAccounts,
  getEthereumProvider,
  getNativeBalance,
  sendTransaction,
  signTypedData,
  waitForTransaction,
} from "@/lib/wallet";

type Direction = "buy" | "sell";

type Props = {
  unlocked: boolean;
};

type QuoteState = {
  quote: Record<string, unknown>;
  permitData: {
    domain: unknown;
    types: Record<string, unknown>;
    values: unknown;
  } | null;
  permitTransaction: Record<string, string> | null;
  routing: string;
  amountOut: string;
  fetchedAt: number;
};

type TxFields = {
  to: string;
  data: string;
  value?: string;
  gas?: string;
  gasLimit?: string;
  maxFeePerGas?: string;
  maxPriorityFeePerGas?: string;
  gasPrice?: string;
  chainId?: number | string;
  from?: string;
};

export default function SwapWidget({ unlocked }: Props) {
  const [direction, setDirection] = useState<Direction>("buy");
  const [amountIn, setAmountIn] = useState("");
  const [account, setAccount] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [quote, setQuote] = useState<QuoteState | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);
  const [apiReady, setApiReady] = useState<boolean | null>(null);
  // Slightly higher default than Uniswap UI auto — meme pool moves fast
  const [slippage, setSlippage] = useState(1.5);

  const inputSymbol = direction === "buy" ? "ETH" : TOKEN.symbol;
  const outputSymbol = direction === "buy" ? TOKEN.symbol : "ETH";
  const inputDecimals = direction === "buy" ? 18 : TOKEN.decimals;

  const uniswapUrl = useMemo(() => {
    return buildUniswapSwapUrl({
      direction,
      amountEth: direction === "buy" ? amountIn : undefined,
    });
  }, [direction, amountIn]);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/trade/status")
      .then((r) => r.json())
      .then((d: { tradingApiConfigured?: boolean; isOpen?: boolean; paused?: boolean }) => {
        if (!cancelled) setApiReady(Boolean(d.tradingApiConfigured));
      })
      .catch(() => {
        if (!cancelled) setApiReady(false);
      });
    // Reconnect silent session (already authorized wallet)
    void getConnectedAccounts().then((accounts) => {
      if (!cancelled && accounts[0]) setAccount(accounts[0]);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const provider = getEthereumProvider();
    if (!provider?.on) return;
    const onAccounts = (...args: unknown[]) => {
      const accounts = args[0] as string[] | undefined;
      setAccount(accounts?.[0] ?? null);
      setQuote(null);
    };
    const onChain = () => {
      setQuote(null);
      setStatus(null);
    };
    provider.on("accountsChanged", onAccounts);
    provider.on("chainChanged", onChain);
    return () => {
      provider.removeListener?.("accountsChanged", onAccounts);
      provider.removeListener?.("chainChanged", onChain);
    };
  }, []);

  const handleConnect = useCallback(async () => {
    setError(null);
    setStatus(null);
    try {
      setBusy(true);
      setStatus("Connecting wallet…");
      const addr = await connectWallet();
      setStatus(`Switching to ${CHAIN.name}…`);
      await ensureRobinhoodChain();
      setAccount(addr);
      setStatus(`Connected · ${CHAIN.name}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to connect wallet.");
      setStatus(null);
    } finally {
      setBusy(false);
    }
  }, []);

  const flipDirection = () => {
    setDirection((d) => (d === "buy" ? "sell" : "buy"));
    setAmountIn("");
    setQuote(null);
    setTxHash(null);
    setError(null);
    setStatus(null);
  };

  const fetchQuote = useCallback(async () => {
    if (!unlocked) return;
    setError(null);
    setStatus(null);
    setTxHash(null);
    setQuote(null);

    const raw = parseTokenAmount(amountIn, inputDecimals);
    if (raw === null || raw <= BigInt(0)) {
      setError("Enter a valid amount.");
      return;
    }
    if (!account) {
      setError("Connect your wallet first.");
      return;
    }

    try {
      setBusy(true);
      setStatus("Quoting via Uniswap…");
      await ensureRobinhoodChain();

      const res = await fetch("/api/uniswap/quote", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          direction,
          amount: raw.toString(),
          swapper: account,
          slippageTolerance: slippage,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        if (res.status === 429 || data.error === "RATE_LIMIT") {
          throw new Error(
            data.message || "Too many quotes — wait a few seconds and try again."
          );
        }
        throw new Error(data.message || data.error || "Quote failed.");
      }

      const quoteObj = (data.quote ?? data) as Record<string, unknown>;
      const amountOut =
        (typeof data.amountOut === "string" && data.amountOut) ||
        (quoteObj.output as { amount?: string } | undefined)?.amount ||
        "";

      if (!amountOut) {
        throw new Error("Quote missing output amount. Pool may not be live yet.");
      }

      const permitData =
        data.permitData && typeof data.permitData === "object"
          ? (data.permitData as QuoteState["permitData"])
          : null;

      const permitTransaction =
        data.permitTransaction && typeof data.permitTransaction === "object"
          ? (data.permitTransaction as Record<string, string>)
          : null;

      setQuote({
        quote: quoteObj,
        permitData,
        permitTransaction,
        routing: (data.routing as string) || "CLASSIC",
        amountOut,
        fetchedAt: Date.now(),
      });
      // Redundant safety ping — server also records on /quote
      void fetch("/api/boards/ping", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address: account, kind: "quote" }),
      });
      setStatus("Quote ready — confirm swap.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Quote failed.");
    } finally {
      setBusy(false);
    }
  }, [unlocked, amountIn, inputDecimals, account, direction, slippage]);

  const executeSwap = useCallback(async () => {
    if (!unlocked || !quote || !account) return;
    setError(null);
    setTxHash(null);

    try {
      setBusy(true);
      await ensureRobinhoodChain();

      const raw = parseTokenAmount(amountIn, inputDecimals);
      if (raw === null || raw <= BigInt(0)) {
        throw new Error("Enter a valid amount.");
      }

      // Buys: leave ETH for gas so the tx is not underfunded / stuck
      if (direction === "buy") {
        const bal = await getNativeBalance(account);
        // Reserve ~0.002 ETH for gas on RH (conservative)
        const gasReserve = BigInt("2000000000000000");
        if (bal <= gasReserve) {
          throw new Error(
            "Not enough ETH for gas. Keep at least ~0.002 ETH free after the buy amount."
          );
        }
        if (raw + gasReserve > bal) {
          throw new Error(
            "Buy amount too high — leave ~0.002 ETH free for gas so the swap doesn't get stuck."
          );
        }
      }

      // Always re-quote immediately before build (stale quotes → stuck/reverted)
      setStatus("Refreshing quote…");
      const qRes = await fetch("/api/uniswap/quote", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          direction,
          amount: raw.toString(),
          swapper: account,
          slippageTolerance: slippage,
        }),
      });
      const qData = await qRes.json();
      if (!qRes.ok) {
        throw new Error(qData.message || "Could not refresh quote. Try again.");
      }
      const quoteObj = (qData.quote ?? qData) as Record<string, unknown>;
      const amountOut =
        (typeof qData.amountOut === "string" && qData.amountOut) ||
        (quoteObj.output as { amount?: string } | undefined)?.amount ||
        "";
      if (!amountOut) throw new Error("Quote missing output. Retry.");
      const active: QuoteState = {
        quote: quoteObj,
        permitData:
          qData.permitData && typeof qData.permitData === "object"
            ? (qData.permitData as QuoteState["permitData"])
            : null,
        permitTransaction:
          qData.permitTransaction && typeof qData.permitTransaction === "object"
            ? (qData.permitTransaction as Record<string, string>)
            : null,
        routing: (qData.routing as string) || "CLASSIC",
        amountOut,
        fetchedAt: Date.now(),
      };
      setQuote(active);

      if (active.permitTransaction?.to && active.permitTransaction?.data) {
        setStatus("Approve token in wallet…");
        const approveHash = await sendTransaction({
          to: active.permitTransaction.to,
          from: account,
          data: active.permitTransaction.data,
          value: active.permitTransaction.value,
          gasLimit:
            active.permitTransaction.gasLimit || active.permitTransaction.gas,
          kind: "approve",
        });
        setStatus("Waiting for approval…");
        await waitForTransaction(approveHash, { label: "Approval", timeoutMs: 120_000 });
      }

      let signature: string | undefined;
      if (active.permitData?.domain && active.permitData.types && active.permitData.values) {
        setStatus("Sign Permit2…");
        signature = await signTypedData(
          account,
          active.permitData.domain,
          active.permitData.types,
          active.permitData.values
        );
      }

      setStatus("Building swap…");
      const res = await fetch("/api/uniswap/swap", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          quote: active.quote,
          swapper: account,
          ...(active.permitData && signature
            ? { permitData: active.permitData, signature }
            : {}),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        if (res.status === 429 || data.error === "RATE_LIMIT") {
          throw new Error(
            data.message || "Routing busy — wait a few seconds, then try again."
          );
        }
        throw new Error(data.message || data.error || "Swap build failed.");
      }

      const tx = data.swap as TxFields | undefined;
      if (!tx?.to || !tx?.data || tx.data === "0x") {
        throw new Error("Invalid swap transaction from Uniswap.");
      }
      // Buy must send native ETH
      if (direction === "buy" && (!tx.value || tx.value === "0x0" || tx.value === "0")) {
        throw new Error("Swap missing ETH value. Get a fresh quote and retry.");
      }

      setStatus("Confirm buy/sell in wallet…");
      const hash = await sendTransaction({
        to: tx.to,
        from: account,
        data: tx.data,
        value: tx.value,
        gasLimit: tx.gasLimit || tx.gas,
        kind: "swap",
      });
      setTxHash(hash);
      setStatus("Submitted — waiting for chain…");
      try {
        await waitForTransaction(hash, {
          label: "Swap",
          timeoutMs: 120_000,
          onPending: (ms) => {
            if (ms > 30_000) {
              setStatus(
                "Still pending… If stuck, open Rabby/MetaMask → Speed Up. Keep this tab open."
              );
            } else if (ms > 10_000) {
              setStatus("Waiting for block confirmation…");
            }
          },
        });
        setStatus("Swap confirmed ✓");
      } catch (waitErr) {
        // Don't clear hash — user can track on explorer
        setError(waitErr instanceof Error ? waitErr.message : "Confirmation timed out.");
        setStatus("Tx sent — check explorer / speed up in wallet if pending.");
      }
      setQuote(null);
      setAmountIn("");
      void fetch("/api/boards/ping", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address: account, kind: "swap" }),
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Swap failed.");
    } finally {
      setBusy(false);
    }
  }, [unlocked, quote, account, amountIn, inputDecimals, direction, slippage]);

  const estimatedOut = useMemo(() => {
    if (!quote?.amountOut) return "—";
    try {
      const outDecimals = direction === "buy" ? TOKEN.decimals : 18;
      return formatTokenAmount(quote.amountOut, outDecimals);
    } catch {
      return "—";
    }
  }, [quote, direction]);

  const btnBase =
    "min-h-11 w-full rounded-lg px-3 py-2.5 text-sm font-bold transition-colors disabled:cursor-not-allowed disabled:opacity-50 sm:text-base";

  return (
    <div
      className={`relative overflow-hidden rounded-xl border border-gold-500/40 bg-wood-950/95 shadow-[0_12px_40px_-16px_rgba(0,0,0,0.75)] ${
        unlocked ? "" : "select-none"
      }`}
      aria-disabled={!unlocked}
    >
      {!unlocked && (
        <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-2 bg-wood-950/85 px-4 text-center backdrop-blur-[3px]">
          <span className="text-3xl" aria-hidden="true">
            🔒
          </span>
          <p className="font-display text-xl text-gold-300 sm:text-2xl">Widget locked</p>
          <p className="max-w-xs text-xs text-foreground/75 sm:text-sm">
            Trading is not live. Stand by — do not swap on Uniswap.app or anywhere else.
          </p>
        </div>
      )}

      <div className={`p-3.5 sm:p-5 ${unlocked ? "" : "pointer-events-none blur-[1.5px]"}`}>
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <h3 className="font-display text-xl leading-tight text-gold-300 sm:text-2xl">
              Trade $PLANK
            </h3>
            <p className="mt-0.5 truncate text-[0.7rem] text-foreground/55 sm:text-xs">
              Uniswap AMM · {CHAIN.name} · official CA
            </p>
          </div>
          <span className="shrink-0 rounded-full border border-forest-600 bg-forest-800/60 px-2 py-0.5 text-[0.6rem] font-extrabold uppercase tracking-wide text-emerald-300">
            {unlocked ? "Live" : RULES_RELAXED ? "Open" : "Official"}
          </span>
        </div>

        {unlocked && (
          <p className="mt-2.5 rounded-lg border border-emerald-500/30 bg-forest-900/75 px-2.5 py-2 text-[0.7rem] leading-snug text-foreground/80 sm:text-xs">
            <strong className="text-emerald-300">Live:</strong> connect · buy/sell · fee{" "}
            {SITE_FEE.label}. Quotes refresh before swap. Rabby/MetaMask set their own gas.
          </p>
        )}

        <div className="mt-3 flex items-center gap-2 rounded-lg border border-gold-500/25 bg-wood-900/80 px-2.5 py-2">
          <span className="shrink-0 text-[0.6rem] font-bold uppercase tracking-wider text-gold-300">
            CA
          </span>
          <code
            className="min-w-0 flex-1 truncate font-mono text-[0.7rem] text-foreground/90 sm:text-xs"
            title={CONTRACT_ADDRESS}
          >
            {CONTRACT_ADDRESS}
          </code>
          <a
            href={explorerTokenUrl()}
            target="_blank"
            rel="noopener noreferrer"
            className="shrink-0 text-[0.7rem] font-semibold text-gold-300 underline-offset-2 hover:underline sm:text-xs"
          >
            ↗
          </a>
        </div>

        <div className="mt-3 grid grid-cols-2 gap-1 rounded-lg border border-gold-500/20 bg-wood-900/50 p-1">
          {(["buy", "sell"] as const).map((d) => (
            <button
              key={d}
              type="button"
              disabled={!unlocked}
              onClick={() => {
                setDirection(d);
                setQuote(null);
                setTxHash(null);
                setError(null);
              }}
              className={`min-h-10 rounded-md text-xs font-bold uppercase tracking-wide transition-colors sm:text-sm ${
                direction === d
                  ? "bg-gold-500 text-wood-950"
                  : "text-foreground/65 hover:text-gold-300"
              }`}
            >
              {d === "buy" ? "Buy" : "Sell"}
            </button>
          ))}
        </div>

        <label className="mt-3 block">
          <span className="text-[0.65rem] font-bold uppercase tracking-wider text-foreground/50">
            You pay
          </span>
          <div className="mt-1 flex min-h-12 items-center gap-2 rounded-lg border border-gold-500/30 bg-wood-900/70 px-2.5 focus-within:border-gold-400">
            <input
              type="text"
              inputMode="decimal"
              placeholder="0.0"
              disabled={!unlocked}
              value={amountIn}
              onChange={(e) => {
                const v = e.target.value.replace(/[^0-9.]/g, "");
                setAmountIn(v);
                setQuote(null);
              }}
              className="min-w-0 flex-1 bg-transparent py-2.5 text-lg font-semibold text-foreground outline-none placeholder:text-foreground/30 sm:text-xl"
              aria-label={`Amount of ${inputSymbol}`}
            />
            <span className="shrink-0 rounded-md bg-gold-500/15 px-2 py-1 text-xs font-bold text-gold-300 sm:text-sm">
              {inputSymbol}
            </span>
          </div>
        </label>

        <div className="my-1.5 flex justify-center">
          <button
            type="button"
            disabled={!unlocked}
            onClick={flipDirection}
            className="flex h-9 w-9 items-center justify-center rounded-full border border-gold-500/40 bg-wood-900 text-gold-300 transition-transform hover:scale-105"
            aria-label="Flip swap direction"
          >
            ↕
          </button>
        </div>

        <div>
          <span className="text-[0.65rem] font-bold uppercase tracking-wider text-foreground/50">
            You receive
          </span>
          <div className="mt-1 flex min-h-12 items-center gap-2 rounded-lg border border-gold-500/20 bg-wood-900/40 px-2.5">
            <span className="min-w-0 flex-1 py-2.5 text-lg font-semibold text-foreground/90 sm:text-xl">
              {estimatedOut}
            </span>
            <span className="shrink-0 rounded-md bg-forest-800/60 px-2 py-1 text-xs font-bold text-gold-300 sm:text-sm">
              {outputSymbol}
            </span>
          </div>
        </div>

        <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2 text-[0.7rem] text-foreground/55 sm:text-xs">
          <label className="flex items-center gap-1.5">
            <span className="font-bold uppercase tracking-wide">Slip</span>
            <select
              disabled={!unlocked}
              value={slippage}
              onChange={(e) => {
                setSlippage(Number(e.target.value));
                setQuote(null);
              }}
              className="min-h-8 rounded-md border border-gold-500/30 bg-wood-950 px-1.5 py-1 text-foreground"
            >
              <option value={0.5}>0.5%</option>
              <option value={1}>1%</option>
              <option value={1.5}>1.5%</option>
              <option value={2}>2%</option>
              <option value={3}>3%</option>
              <option value={5}>5%</option>
            </select>
          </label>
          <span>
            Fee {SITE_FEE.label} · ETH/{TOKEN.symbol}
          </span>
        </div>

        <div className="mt-3 flex flex-col gap-2">
          {!account ? (
            <button
              type="button"
              disabled={!unlocked || busy}
              onClick={handleConnect}
              className={`${btnBase} bg-gold-500 text-wood-950 hover:bg-gold-400`}
            >
              {busy ? "Connecting…" : "Connect wallet"}
            </button>
          ) : (
            <div className="flex min-h-10 items-center justify-between gap-2 rounded-lg border border-forest-600/45 bg-forest-900/45 px-2.5 text-xs sm:text-sm">
              <span className="text-foreground/65">Wallet</span>
              <span className="font-mono text-gold-300" title={account}>
                {shortAddress(account)}
              </span>
              <button
                type="button"
                disabled={busy}
                onClick={handleConnect}
                className="shrink-0 text-[0.65rem] font-bold text-gold-300/80 underline-offset-2 hover:underline"
              >
                Switch
              </button>
            </div>
          )}

          {apiReady !== false && (
            <>
              <button
                type="button"
                disabled={!unlocked || busy || !account || !amountIn}
                onClick={fetchQuote}
                className={`${btnBase} border border-gold-500/55 bg-wood-900 text-gold-300 hover:border-gold-400`}
              >
                {busy && !quote ? "Quoting…" : "Get quote"}
              </button>
              {quote && (
                <button
                  type="button"
                  disabled={!unlocked || busy}
                  onClick={executeSwap}
                  className={`${btnBase} bg-gold-500 text-wood-950 shadow-[0_6px_16px_-4px_rgba(217,164,65,0.45)] hover:bg-gold-400`}
                >
                  {busy ? "Confirm in wallet…" : `Swap · ${SITE_FEE.label} fee`}
                </button>
              )}
            </>
          )}

          {apiReady === false && unlocked && (
            <p className="rounded-lg border border-gold-500/30 bg-wood-900/80 px-2.5 py-2 text-center text-[0.7rem] text-foreground/70">
              Routing offline. <strong className="text-gold-300">Do not swap elsewhere</strong> —
              wait for this widget.
            </p>
          )}

          {uniswapUrl && unlocked && (
            <a
              href={uniswapUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="rounded-lg border border-gold-500/35 bg-wood-900/60 px-2.5 py-2 text-center text-[0.7rem] font-bold text-gold-300 underline-offset-2 hover:bg-gold-500/10 hover:underline"
            >
              Open this pair on official Uniswap ↗
            </a>
          )}
        </div>

        {(status || error || txHash) && (
          <div className="mt-2.5 space-y-1 text-center text-xs">
            {status && (
              <p className="text-forest-600" role="status">
                {status}
              </p>
            )}
            {error && (
              <p className="text-red-300" role="alert">
                {error}
              </p>
            )}
            {txHash && (
              <p className="break-all text-gold-300">
                Tx{" "}
                <a
                  href={`${CHAIN.blockExplorers.default.url}/tx/${txHash}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline"
                >
                  {shortAddress(txHash, 6)}
                </a>
                <span className="mt-1 block text-[0.65rem] text-foreground/50">
                  Pending long? Use Speed Up in your wallet, or open the explorer link.
                </span>
              </p>
            )}
          </div>
        )}

        <p className="mt-3 text-center text-[0.65rem] leading-snug text-foreground/40">
          ETH ↔ {TOKEN.symbol} on chain {CHAIN.id} · fee {SITE_FEE.label} · not financial advice
        </p>
        <span className="sr-only">
          Native {NATIVE_TOKEN_ADDRESS}; PLANK {CONTRACT_ADDRESS}
        </span>
      </div>
    </div>
  );
}
