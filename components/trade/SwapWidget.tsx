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
  shortAddress,
} from "@/lib/trade";
import {
  connectWallet,
  ensureRobinhoodChain,
  getEthereumProvider,
  sendTransaction,
  signTypedData,
} from "@/lib/wallet";

type Direction = "buy" | "sell";

type Props = {
  /** When false, the entire interactive surface is disabled. */
  unlocked: boolean;
};

type QuoteState = {
  quote: Record<string, unknown>;
  permitData: {
    domain: unknown;
    types: Record<string, unknown>;
    values: unknown;
  } | null;
  routing: string;
  amountOut: string;
  raw: unknown;
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

  // External Uniswap.app links only after rules are relaxed (Phase 2+).
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
      .then((d: { tradingApiConfigured?: boolean }) => {
        if (!cancelled) setApiReady(Boolean(d.tradingApiConfigured));
      })
      .catch(() => {
        if (!cancelled) setApiReady(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Listen for account changes
  useEffect(() => {
    const provider = getEthereumProvider();
    if (!provider?.on) return;
    const onAccounts = (...args: unknown[]) => {
      const accounts = args[0] as string[] | undefined;
      setAccount(accounts?.[0] ?? null);
    };
    provider.on("accountsChanged", onAccounts);
    return () => provider.removeListener?.("accountsChanged", onAccounts);
  }, []);

  const handleConnect = useCallback(async () => {
    setError(null);
    setStatus(null);
    try {
      setBusy(true);
      const addr = await connectWallet();
      await ensureRobinhoodChain();
      setAccount(addr);
      setStatus("Wallet connected on Robinhood Chain.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to connect wallet.");
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
      setStatus("Getting Uniswap quote…");
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
      const output = quoteObj.output as { amount?: string } | undefined;
      const amountOut =
        output?.amount ||
        (typeof quoteObj.amountOut === "string" ? quoteObj.amountOut : undefined) ||
        (typeof data.amountOut === "string" ? data.amountOut : undefined) ||
        "";

      setQuote({
        quote: quoteObj,
        permitData: data.permitData ?? null,
        routing: data.routing || "CLASSIC",
        amountOut,
        raw: data,
      });
      setStatus("Quote ready. Review and confirm the swap.");
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

      let signature: string | undefined;
      if (quote.permitData) {
        setStatus("Sign Permit2 approval…");
        signature = await signTypedData(
          account,
          quote.permitData.domain,
          quote.permitData.types,
          quote.permitData.values
        );
      }

      setStatus("Building Uniswap swap transaction…");
      const res = await fetch("/api/uniswap/swap", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          quote: quote.quote,
          ...(quote.permitData && signature
            ? { permitData: quote.permitData, signature }
            : {}),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.message || data.error || "Swap build failed.");
      }

      const tx =
        (data.swap as Record<string, string> | undefined) ||
        (data.transaction as Record<string, string> | undefined) ||
        (data as Record<string, string>);

      if (!tx?.to || !tx?.data || tx.data === "0x") {
        throw new Error("Invalid swap transaction returned by Uniswap.");
      }

      setStatus("Confirm swap in your wallet…");
      const hash = await sendTransaction({
        to: tx.to,
        from: account,
        data: tx.data,
        value: tx.value,
        gasLimit: tx.gasLimit || tx.gas,
        maxFeePerGas: tx.maxFeePerGas,
        maxPriorityFeePerGas: tx.maxPriorityFeePerGas,
        gasPrice: tx.gasPrice,
      });
      setTxHash(hash);
      setStatus("Swap submitted.");
      setQuote(null);
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

  return (
    <div
      className={`relative overflow-hidden rounded-2xl border-2 border-gold-500/40 bg-wood-950/90 shadow-[0_20px_50px_-20px_rgba(0,0,0,0.8)] ${
        unlocked ? "" : "select-none"
      }`}
      aria-disabled={!unlocked}
    >
      {!unlocked && (
        <div
          className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 bg-wood-950/80 px-6 text-center backdrop-blur-sm"
          aria-hidden="false"
        >
          <span className="text-4xl" aria-hidden="true">
            🔒
          </span>
          <p className="font-display text-2xl text-gold-300">Widget locked</p>
          <p className="max-w-sm text-sm text-foreground/75">
            Official widget locked until the community countdown hits zero. Do not swap on
            Uniswap.app, bots, or anywhere else first — that&apos;s the sniper trap.
          </p>
        </div>
      )}

      <div className={`p-5 sm:p-6 ${unlocked ? "" : "pointer-events-none blur-[2px]"}`}>
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="font-display text-2xl text-gold-300">Trade $PLANK</h3>
            <p className="mt-1 text-xs text-foreground/60">
              Official plank.love widget · Uniswap routing · {CHAIN.name}
            </p>
          </div>
          <span className="rounded-full border border-forest-600 bg-forest-800/60 px-3 py-1 text-[0.65rem] font-extrabold uppercase tracking-wider text-gold-300">
            {RULES_RELAXED ? "Open trade" : "Official only"}
          </span>
        </div>

        {!RULES_RELAXED && (
          <div className="mt-4 rounded-xl border border-gold-500/40 bg-forest-900/80 px-3 py-3 text-xs leading-relaxed text-foreground/85">
            <strong className="text-gold-300">Safety rule:</strong> Until anti-sniper / limits are
            fully relaxed, <strong className="text-foreground">only swap here</strong> on the
            official plank.love widget. Swapping on Uniswap.app, aggregators, or other UIs during
            this phase is dangerous — snipers and early wallets can land on the Plank List.
          </div>
        )}

        {/* Verified contract strip */}
        <div className="mt-4 flex flex-col gap-2 rounded-xl border border-gold-500/25 bg-wood-900/80 p-3 sm:flex-row sm:items-center">
          <span className="shrink-0 text-[0.65rem] font-bold uppercase tracking-widest text-gold-300">
            Verified CA
          </span>
          <code className="min-w-0 flex-1 truncate text-xs text-foreground/90" title={CONTRACT_ADDRESS}>
            {CONTRACT_ADDRESS}
          </code>
          <a
            href={explorerTokenUrl()}
            target="_blank"
            rel="noopener noreferrer"
            className="shrink-0 text-xs font-semibold text-gold-300 underline-offset-2 hover:underline"
          >
            Explorer ↗
          </a>
        </div>

        {/* Direction toggle */}
        <div className="mt-5 flex rounded-lg border border-gold-500/20 bg-wood-900/60 p-1">
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
              className={`flex-1 rounded-md py-2 text-sm font-bold uppercase tracking-wide transition-colors ${
                direction === d
                  ? "bg-gold-500 text-wood-950"
                  : "text-foreground/70 hover:text-gold-300"
              }`}
            >
              {d === "buy" ? "Buy PLANK" : "Sell PLANK"}
            </button>
          ))}
        </div>

        {/* Amount in */}
        <label className="mt-5 block">
          <span className="text-xs font-bold uppercase tracking-widest text-foreground/50">You pay</span>
          <div className="mt-1 flex items-center gap-2 rounded-xl border border-gold-500/30 bg-wood-900/70 px-3 py-3 focus-within:border-gold-400">
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
              className="min-w-0 flex-1 bg-transparent text-xl font-semibold text-foreground outline-none placeholder:text-foreground/30"
              aria-label={`Amount of ${inputSymbol}`}
            />
            <span className="shrink-0 rounded-md bg-gold-500/15 px-2 py-1 text-sm font-bold text-gold-300">
              {inputSymbol}
            </span>
          </div>
        </label>

        <div className="my-3 flex justify-center">
          <button
            type="button"
            disabled={!unlocked}
            onClick={flipDirection}
            className="rounded-full border border-gold-500/40 bg-wood-900 p-2 text-gold-300 transition-transform hover:scale-110"
            aria-label="Flip swap direction"
          >
            ↕
          </button>
        </div>

        {/* Amount out */}
        <div>
          <span className="text-xs font-bold uppercase tracking-widest text-foreground/50">You receive</span>
          <div className="mt-1 flex items-center gap-2 rounded-xl border border-gold-500/20 bg-wood-900/40 px-3 py-3">
            <span className="min-w-0 flex-1 text-xl font-semibold text-foreground/90">{estimatedOut}</span>
            <span className="shrink-0 rounded-md bg-forest-800/60 px-2 py-1 text-sm font-bold text-gold-300">
              {outputSymbol}
            </span>
          </div>
        </div>

        {/* Slippage + site fee disclosure */}
        <div className="mt-4 flex flex-col gap-2 text-xs text-foreground/60">
          <div className="flex items-center justify-between gap-3">
            <label className="flex items-center gap-2">
              <span className="font-bold uppercase tracking-wider">Slippage</span>
              <select
                disabled={!unlocked}
                value={slippage}
                onChange={(e) => setSlippage(Number(e.target.value))}
                className="rounded-md border border-gold-500/30 bg-wood-950 px-2 py-1 text-foreground"
              >
                <option value={0.5}>0.5%</option>
                <option value={1}>1%</option>
                <option value={2}>2%</option>
                <option value={5}>5%</option>
              </select>
            </label>
            <span>Pair: ETH / {TOKEN.symbol}</span>
          </div>
          <div className="rounded-lg border border-gold-500/25 bg-wood-900/60 px-3 py-2 text-foreground/75">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span>
                <strong className="text-gold-300">plank.love fee</strong>{" "}
                <span className="font-display text-gold-300">{SITE_FEE.label}</span>
              </span>
              <span className="font-mono text-[0.65rem] text-foreground/50" title={SITE_FEE.recipient}>
                → {shortAddress(SITE_FEE.recipient, 4)}
              </span>
            </div>
            <p className="mt-1 text-[0.7rem] leading-relaxed text-foreground/50">
              Included when you swap here on plank.love (supports the project). Pool fee + gas are
              separate.
            </p>
          </div>
        </div>

        {/* Wallet + actions */}
        <div className="mt-5 flex flex-col gap-3">
          {!account ? (
            <button
              type="button"
              disabled={!unlocked || busy}
              onClick={handleConnect}
              className="w-full rounded-lg bg-gold-500 px-4 py-3 text-base font-bold text-wood-950 transition-all hover:bg-gold-400 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Connect Wallet
            </button>
          ) : (
            <div className="flex items-center justify-between rounded-lg border border-forest-600/50 bg-forest-900/50 px-3 py-2 text-sm">
              <span className="text-foreground/70">Connected</span>
              <span className="font-mono text-gold-300" title={account}>
                {shortAddress(account)}
              </span>
            </div>
          )}

          {apiReady !== false && (
            <>
              <button
                type="button"
                disabled={!unlocked || busy || !account || !amountIn}
                onClick={fetchQuote}
                className="w-full rounded-lg border-2 border-gold-500/60 bg-wood-900 px-4 py-3 text-base font-bold text-gold-300 transition-colors hover:border-gold-400 hover:text-gold-200 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {busy && !quote ? "Quoting…" : "Get quote"}
              </button>
              {quote && (
                <button
                  type="button"
                  disabled={!unlocked || busy}
                  onClick={executeSwap}
                  className="w-full rounded-lg bg-gold-500 px-4 py-3 text-base font-bold text-wood-950 shadow-[0_6px_18px_-4px_rgba(217,164,65,0.5)] transition-all hover:-translate-y-0.5 hover:bg-gold-400 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {busy
                    ? "Confirm in wallet…"
                    : `Swap via official widget · ${SITE_FEE.label} fee`}
                </button>
              )}
            </>
          )}

          {apiReady === false && unlocked && (
            <p className="rounded-lg border border-gold-500/30 bg-wood-900/80 px-3 py-3 text-center text-xs text-foreground/70">
              Official widget routing is temporarily offline.{" "}
              <strong className="text-gold-300">Do not swap elsewhere</strong> while launch rules
              are active — wait here for the plank.love widget to come back online.
            </p>
          )}

          {/* External UIs only after Phase 2 (rules relaxed) — never during launch trap */}
          {RULES_RELAXED && uniswapUrl && unlocked && (
            <p className="pt-1 text-center text-[0.7rem] text-foreground/40">
              <a
                href={uniswapUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="underline-offset-2 hover:text-foreground/60 hover:underline"
              >
                Rules relaxed — optional Uniswap.app (same CA) ↗
              </a>
            </p>
          )}
        </div>

        {status && (
          <p className="mt-3 text-center text-sm text-forest-600" role="status">
            {status}
          </p>
        )}
        {error && (
          <p className="mt-3 text-center text-sm text-red-300" role="alert">
            {error}
          </p>
        )}
        {txHash && (
          <p className="mt-3 break-all text-center text-sm text-gold-300">
            Tx:{" "}
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

        <p className="mt-4 text-center text-[0.7rem] leading-relaxed text-foreground/45">
          Official widget only routes ETH ↔ {TOKEN.symbol} on {CHAIN.name} (chain {CHAIN.id}) vs{" "}
          <span className="font-mono">{shortAddress(CONTRACT_ADDRESS, 6)}</span>. Site fee{" "}
          {SITE_FEE.label} →{" "}
          <span className="font-mono">{shortAddress(SITE_FEE.recipient, 4)}</span>.{" "}
          {!RULES_RELAXED
            ? "Do not use other swap UIs until launch rules are relaxed."
            : "Always verify the CA."}{" "}
          Not financial advice.
        </p>

        {/* Keep native address referenced so tooling/static analysis sees the pair constraint. */}
        <span className="sr-only">
          Native token {NATIVE_TOKEN_ADDRESS}; PLANK {CONTRACT_ADDRESS}
        </span>
      </div>
    </div>
  );
}
