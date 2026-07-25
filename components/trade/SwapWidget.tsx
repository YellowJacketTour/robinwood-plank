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
  const [slippage, setSlippage] = useState(1);

  const inputSymbol = direction === "buy" ? "ETH" : TOKEN.symbol;
  const outputSymbol = direction === "buy" ? TOKEN.symbol : "ETH";
  const inputDecimals = direction === "buy" ? 18 : TOKEN.decimals;

  const uniswapUrl = useMemo(() => {
    if (!RULES_RELAXED) return null;
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

    // Stale quote — force refresh (prices move; Uniswap quotes expire)
    if (Date.now() - quote.fetchedAt > QUOTE_MAX_AGE_MS) {
      setQuote(null);
      setError("Quote expired. Get a fresh quote and try again.");
      return;
    }

    try {
      setBusy(true);
      await ensureRobinhoodChain();

      // On-chain approval tx if Uniswap returned one (ERC-20 sell path)
      if (quote.permitTransaction?.to && quote.permitTransaction?.data) {
        setStatus("Approve token in wallet…");
        const approveHash = await sendTransaction({
          to: quote.permitTransaction.to,
          from: account,
          data: quote.permitTransaction.data,
          value: quote.permitTransaction.value,
          gasLimit: quote.permitTransaction.gasLimit || quote.permitTransaction.gas,
          maxFeePerGas: quote.permitTransaction.maxFeePerGas,
          maxPriorityFeePerGas: quote.permitTransaction.maxPriorityFeePerGas,
          gasPrice: quote.permitTransaction.gasPrice,
          chainId: quote.permitTransaction.chainId,
        });
        setStatus("Waiting for approval…");
        await waitForTransaction(approveHash);
      }

      let signature: string | undefined;
      if (quote.permitData?.domain && quote.permitData.types && quote.permitData.values) {
        setStatus("Sign Permit2…");
        signature = await signTypedData(
          account,
          quote.permitData.domain,
          quote.permitData.types,
          quote.permitData.values
        );
      }

      // Re-check age after user signed (can take a while)
      if (Date.now() - quote.fetchedAt > QUOTE_MAX_AGE_MS) {
        setQuote(null);
        throw new Error("Quote expired while waiting. Get a new quote.");
      }

      setStatus("Building swap…");
      const res = await fetch("/api/uniswap/swap", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          quote: quote.quote,
          swapper: account,
          ...(quote.permitData && signature
            ? { permitData: quote.permitData, signature }
            : {}),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.message || data.error || "Swap build failed.");
      }

      const tx = data.swap as TxFields | undefined;
      if (!tx?.to || !tx?.data || tx.data === "0x") {
        throw new Error("Invalid swap transaction from Uniswap.");
      }

      setStatus("Confirm swap in wallet…");
      const hash = await sendTransaction({
        to: tx.to,
        from: account,
        data: tx.data,
        value: tx.value,
        gasLimit: tx.gasLimit || tx.gas,
        maxFeePerGas: tx.maxFeePerGas,
        maxPriorityFeePerGas: tx.maxPriorityFeePerGas,
        gasPrice: tx.gasPrice,
        chainId: tx.chainId,
      });
      setTxHash(hash);
      setStatus("Swap submitted — waiting for confirmation…");
      try {
        await waitForTransaction(hash, { label: "Swap", timeoutMs: 180_000 });
        setStatus("Swap confirmed.");
      } catch {
        // Submitted is enough if confirmation is slow; hash still shown
        setStatus("Swap submitted (confirming on chain…).");
      }
      setQuote(null);
      setAmountIn("");
      // Widget session for Good Wood
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
  }, [unlocked, quote, account]);

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
            <strong className="text-emerald-300">Live:</strong> connect wallet · buy or sell ·
            fee {SITE_FEE.label} to treasury. Official CA only.
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
              <option value={2}>2%</option>
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

          {RULES_RELAXED && uniswapUrl && unlocked && (
            <a
              href={uniswapUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-center text-[0.65rem] text-foreground/40 underline-offset-2 hover:underline"
            >
              Optional Uniswap.app (rules relaxed) ↗
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
