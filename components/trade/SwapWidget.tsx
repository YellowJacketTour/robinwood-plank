"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  BUY_GAS_RESERVE_ETH,
  BUY_GAS_RESERVE_WEI,
  CHAIN,
  CONTRACT_ADDRESS,
  NATIVE_TOKEN_ADDRESS,
  SITE_FEE,
  TOKEN,
  UNIVERSAL_ROUTER_ADDRESS,
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
  getChainId,
  getConnectedAccounts,
  getEthereumProvider,
  getErc20Balance,
  getNativeBalance,
  sendTransaction,
  signTypedData,
  waitForTransaction,
} from "@/lib/wallet";
import dynamic from "next/dynamic";

/** Same connect surface the market uses (WalletConnect QR + extension) —
 * loaded on demand; the WC runtime itself only loads on "Show QR". */
const ConnectWalletModal = dynamic(() => import("@/components/ConnectWalletModal"), {
  ssr: false,
});

type Direction = "buy" | "sell";

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
  maxFeePerGas?: string;
  maxPriorityFeePerGas?: string;
  gasUseEstimate?: string;
  approvalNeeded?: boolean;
  /** Priced without a wallet — display only, never executable. */
  indicative?: boolean;
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

/**
 * In-page swap. Every tx is pre-simulated (lib/wallet.ts) and hard-checked
 * to target the Uniswap Universal Router / Permit2 only — never a bridge,
 * never an unknown contract. Success is proven by a balance delta, not just
 * a receipt. See lib/wallet.ts for the enforcement, this file is UI only.
 */
export default function SwapWidget() {
  const [direction, setDirection] = useState<Direction>("buy");
  const [amountIn, setAmountIn] = useState("");
  const [account, setAccount] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [quote, setQuote] = useState<QuoteState | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);
  const [apiReady, setApiReady] = useState<boolean | null>(null);
  const [slippage, setSlippage] = useState(2.5);

  const inputSymbol = direction === "buy" ? "ETH" : TOKEN.symbol;
  const outputSymbol = direction === "buy" ? TOKEN.symbol : "ETH";
  const inputDecimals = direction === "buy" ? 18 : TOKEN.decimals;

  const uniswapUrl = useMemo(
    () =>
      buildUniswapSwapUrl({
        direction,
        amountEth: direction === "buy" ? amountIn : undefined,
      }),
    [direction, amountIn]
  );

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

  const [connectOpen, setConnectOpen] = useState(false);

  /** Post-connect bookkeeping shared by both connect paths. */
  const adoptAccount = useCallback((addr: string) => {
    setAccount(addr);
    // An indicative (wallet-less) quote can't be executed — clear it so
    // the user re-quotes as themselves.
    setQuote((q) => (q?.indicative ? null : q));
    setStatus(null);
    setError(null);
  }, []);

  const handleConnect = useCallback(async () => {
    setError(null);
    setStatus(null);
    // No injected wallet (mobile browsers, extension-less desktops): open
    // the same WalletConnect QR / extension modal the market uses instead
    // of failing with "no wallet found" — this was the dead end that read
    // as "trading not working" without an extension.
    if (typeof window === "undefined" || !window.ethereum) {
      setConnectOpen(true);
      return;
    }
    try {
      setBusy(true);
      setStatus("Connecting…");
      const addr = await connectWallet();
      await ensureRobinhoodChain();
      adoptAccount(addr);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to connect wallet.");
    } finally {
      setBusy(false);
    }
  }, [adoptAccount]);

  const flipDirection = () => {
    setDirection((d) => (d === "buy" ? "sell" : "buy"));
    setAmountIn("");
    setQuote(null);
    setTxHash(null);
    setError(null);
    setStatus(null);
  };

  const fetchQuote = useCallback(async () => {
    setError(null);
    setStatus(null);
    setTxHash(null);
    setQuote(null);

    const raw = parseTokenAmount(amountIn, inputDecimals);
    if (raw === null || raw <= BigInt(0)) {
      setError("Enter a valid amount.");
      return;
    }

    try {
      setBusy(true);
      setStatus("Quoting…");
      // Price quotes work without a wallet (indicative — priced against a
      // placeholder server-side). Only touch the wallet/chain when one is
      // actually connected; prompting here made quoting look broken to
      // anyone who hadn't connected yet.
      if (account) await ensureRobinhoodChain();

      const res = await fetch("/api/uniswap/quote", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          direction,
          amount: raw.toString(),
          swapper: account || undefined,
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

      const qInner = quoteObj as Record<string, unknown>;
      setQuote({
        quote: quoteObj,
        permitData:
          data.permitData && typeof data.permitData === "object"
            ? (data.permitData as QuoteState["permitData"])
            : null,
        permitTransaction:
          data.permitTransaction && typeof data.permitTransaction === "object"
            ? (data.permitTransaction as Record<string, string>)
            : null,
        routing: (data.routing as string) || "CLASSIC",
        amountOut,
        fetchedAt: Date.now(),
        maxFeePerGas:
          typeof qInner.maxFeePerGas === "string" ? qInner.maxFeePerGas : undefined,
        maxPriorityFeePerGas:
          typeof qInner.maxPriorityFeePerGas === "string"
            ? qInner.maxPriorityFeePerGas
            : undefined,
        gasUseEstimate:
          typeof qInner.gasUseEstimate === "string"
            ? qInner.gasUseEstimate
            : typeof qInner.gasUseEstimate === "number"
              ? String(qInner.gasUseEstimate)
              : undefined,
        approvalNeeded: Boolean(data.isTokenApprovalApplicable),
        indicative: Boolean(data.indicative),
      });
      setStatus(
        data.indicative
          ? "Price quote ready — connect a wallet to swap."
          : data.isTokenApprovalApplicable
            ? "Quote ready — approve then swap."
            : "Quote ready."
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Quote failed.");
    } finally {
      setBusy(false);
    }
  }, [amountIn, inputDecimals, account, direction, slippage]);

  const executeSwap = useCallback(async () => {
    if (!quote || !account) return;
    if (quote.indicative) {
      // Belt-and-braces: indicative quotes are cleared on connect, but an
      // executable payload must never be built from a placeholder-swapper
      // quote.
      setError("Re-fetch the quote with your wallet connected.");
      return;
    }
    setError(null);
    setTxHash(null);

    try {
      setBusy(true);
      await ensureRobinhoodChain();

      const raw = parseTokenAmount(amountIn, inputDecimals);
      if (raw === null || raw <= BigInt(0)) {
        throw new Error("Enter a valid amount.");
      }

      const parseQuotePayload = (qData: Record<string, unknown>): QuoteState => {
        const quoteObj = (qData.quote ?? qData) as Record<string, unknown>;
        const amountOut =
          (typeof qData.amountOut === "string" && qData.amountOut) ||
          (quoteObj.output as { amount?: string } | undefined)?.amount ||
          "";
        if (!amountOut) throw new Error("Quote missing output. Retry.");
        const qInner = quoteObj as Record<string, unknown>;
        let gasUse =
          typeof qInner.gasUseEstimate === "string"
            ? qInner.gasUseEstimate
            : typeof qInner.gasUseEstimate === "number"
              ? String(qInner.gasUseEstimate)
              : undefined;
        const ge = qInner.gasEstimates;
        if (Array.isArray(ge) && ge[0] && typeof ge[0] === "object") {
          const gl = (ge[0] as { gasLimit?: unknown }).gasLimit;
          if (gl != null && String(gl)) gasUse = String(gl);
        }
        return {
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
          maxFeePerGas:
            typeof qInner.maxFeePerGas === "string" ? qInner.maxFeePerGas : undefined,
          maxPriorityFeePerGas:
            typeof qInner.maxPriorityFeePerGas === "string"
              ? qInner.maxPriorityFeePerGas
              : undefined,
          gasUseEstimate: gasUse,
          approvalNeeded: Boolean(qData.isTokenApprovalApplicable),
        };
      };

      const fetchFreshQuote = async (): Promise<QuoteState> => {
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
        const qData = (await qRes.json()) as Record<string, unknown>;
        if (!qRes.ok) {
          throw new Error(
            (typeof qData.message === "string" && qData.message) ||
              "Could not refresh quote. Try again."
          );
        }
        return parseQuotePayload(qData);
      };

      // Hard chain gate — never swap / never look like a bridge to L1
      const chainId = await getChainId();
      if (chainId !== CHAIN.id) {
        throw new Error(
          `Wallet is on chain ${chainId}, not ${CHAIN.name}. Switch network — this widget never bridges to Ethereum.`
        );
      }

      if (direction === "buy") {
        const bal = await getNativeBalance(account);
        if (bal <= BUY_GAS_RESERVE_WEI || raw + BUY_GAS_RESERVE_WEI > bal) {
          throw new Error(
            `Leave ~${BUY_GAS_RESERVE_ETH} ETH free for gas after the buy amount.`
          );
        }
      }

      setStatus("Refreshing quote…");
      let active = await fetchFreshQuote();
      setQuote(active);

      let didOnChainApprove = false;
      if (direction === "sell") {
        const tryApproveTx = async (
          txLike: Record<string, unknown> | null | undefined,
          label: string
        ) => {
          if (!txLike || typeof txLike.to !== "string" || typeof txLike.data !== "string") {
            return false;
          }
          if (!txLike.data || txLike.data === "0x") return false;
          setStatus(label);
          const approveHash = await sendTransaction({
            to: String(txLike.to),
            from: account,
            data: String(txLike.data),
            value:
              txLike.value !== undefined && txLike.value !== null
                ? String(txLike.value)
                : undefined,
            gasLimit:
              (txLike.gasLimit != null && String(txLike.gasLimit)) ||
              (txLike.gas != null && String(txLike.gas)) ||
              undefined,
            kind: "approve",
          });
          setStatus("Waiting for approval…");
          await waitForTransaction(approveHash, { label: "Approval", timeoutMs: 120_000 });
          return true;
        };

        if (active.permitTransaction?.to && active.permitTransaction?.data) {
          didOnChainApprove = await tryApproveTx(active.permitTransaction, "Approve $PLANK…");
        }

        if (!didOnChainApprove) {
          setStatus("Checking approval…");
          const appr = await fetch("/api/uniswap/check-approval", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              walletAddress: account,
              token: CONTRACT_ADDRESS,
              amount: raw.toString(),
            }),
          });
          const apprData = (await appr.json()) as {
            approval?: Record<string, unknown> | null;
            request?: Record<string, unknown> | null;
          };
          const approvalTx = apprData?.approval || apprData?.request || null;
          if (appr.ok && approvalTx) {
            didOnChainApprove = await tryApproveTx(approvalTx, "Approve $PLANK…");
          }
        }

        if (didOnChainApprove) {
          setStatus("Approved — refreshing quote…");
          active = await fetchFreshQuote();
          setQuote(active);
        }
      }

      let signature: string | undefined;
      if (active.permitData?.domain && active.permitData.types && active.permitData.values) {
        setStatus("Sign in wallet…");
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
        throw new Error(data.message || data.error || "Swap build failed.");
      }

      const tx = data.swap as TxFields | undefined;
      if (!tx?.to || !tx?.data || tx.data === "0x") {
        throw new Error("Invalid swap transaction from Uniswap.");
      }
      // Never send swap value to anything except official UR on RH
      if (tx.to.toLowerCase() !== UNIVERSAL_ROUTER_ADDRESS.toLowerCase()) {
        throw new Error("Blocked: swap target is not the Uniswap Router. No bridge sent.");
      }
      if (direction === "buy" && (!tx.value || tx.value === "0x0" || tx.value === "0")) {
        throw new Error("Swap missing ETH value. Get a fresh quote and retry.");
      }

      const hints = data.gasHints as
        | { maxFeePerGas?: string | null; maxPriorityFeePerGas?: string | null; gasUseEstimate?: string | null }
        | undefined;

      // Snapshot balances so we can prove delivery, never just assume it
      const plankBefore =
        direction === "buy" ? await getErc20Balance(CONTRACT_ADDRESS, account) : BigInt(0);
      const ethBefore = direction === "sell" ? await getNativeBalance(account) : BigInt(0);

      setStatus("Confirm in wallet…");
      const hash = await sendTransaction({
        to: tx.to,
        from: account,
        data: tx.data,
        value: tx.value,
        gasLimit:
          tx.gasLimit || tx.gas || active.gasUseEstimate ||
          (hints?.gasUseEstimate ? String(hints.gasUseEstimate) : undefined),
        maxFeePerGas:
          (tx.maxFeePerGas && String(tx.maxFeePerGas)) || active.maxFeePerGas ||
          (hints?.maxFeePerGas ? String(hints.maxFeePerGas) : undefined),
        maxPriorityFeePerGas:
          (tx.maxPriorityFeePerGas && String(tx.maxPriorityFeePerGas)) || active.maxPriorityFeePerGas ||
          (hints?.maxPriorityFeePerGas ? String(hints.maxPriorityFeePerGas) : undefined),
        gasPrice: tx.gasPrice ? String(tx.gasPrice) : undefined,
        kind: "swap",
      });
      setTxHash(hash);
      setStatus("Submitted — waiting for confirmation…");
      let delivered = false;
      try {
        await waitForTransaction(hash, {
          label: "Swap",
          timeoutMs: 120_000,
          onPending: (ms) => {
            if (ms > 30_000) setStatus("Still pending — Speed Up in wallet if stuck.");
            else if (ms > 10_000) setStatus("Waiting for block confirmation…");
          },
        });

        if (direction === "buy") {
          await new Promise((r) => setTimeout(r, 1500));
          const plankAfter = await getErc20Balance(CONTRACT_ADDRESS, account);
          if (plankAfter <= plankBefore) {
            setError("Tx mined but $PLANK balance did not increase. Import the CA in your wallet.");
            setStatus("Check explorer / import CA.");
          } else {
            delivered = true;
            setStatus("Swap confirmed — $PLANK received.");
          }
        } else {
          await new Promise((r) => setTimeout(r, 1500));
          const ethAfter = await getNativeBalance(account);
          if (ethAfter <= ethBefore) {
            setError("Tx mined but ETH balance did not increase. Check the explorer.");
            setStatus("Sell mined — verify on explorer.");
          } else {
            delivered = true;
            setStatus("Swap confirmed — ETH received.");
          }
        }
      } catch (waitErr) {
        setError(waitErr instanceof Error ? waitErr.message : "Confirmation timed out.");
      }
      if (delivered) {
        setQuote(null);
        setAmountIn("");
      }
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
  }, [quote, account, amountIn, inputDecimals, direction, slippage]);

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
    <div className="wood-ledger space-y-2.5 p-2.5 sm:p-3">
      <ConnectWalletModal
        open={connectOpen}
        onClose={() => setConnectOpen(false)}
        onConnected={adoptAccount}
      />
      <p className="rounded-lg border border-amber-500/35 bg-amber-950/40 px-2.5 py-1.5 text-[0.65rem] leading-snug text-amber-100/90 sm:text-[0.7rem]">
        <strong className="text-amber-200">Not a bridge:</strong> swaps only go to the Uniswap
        Router on {CHAIN.name} — never Ethereum L1. Keep ~{BUY_GAS_RESERVE_ETH} ETH free for gas.
      </p>

      <div className="grid grid-cols-2 gap-1 rounded-lg border border-gold-500/20 bg-wood-900/90 p-1">
        {(["buy", "sell"] as const).map((d) => (
          <button
            key={d}
            type="button"
            onClick={() => {
              setDirection(d);
              setQuote(null);
              setTxHash(null);
              setError(null);
            }}
            className={`min-h-10 rounded-md text-xs font-bold uppercase tracking-wide transition-colors sm:text-sm ${
              direction === d ? "bg-gold-500 text-wood-950" : "text-foreground/65 hover:text-gold-300"
            }`}
          >
            {d === "buy" ? "Buy" : "Sell"}
          </button>
        ))}
      </div>

      <label className="block">
        <span className="text-[0.65rem] font-bold uppercase tracking-wider text-foreground/50">
          You pay
        </span>
        <div className="mt-1 flex min-h-12 items-center gap-2 rounded-lg border border-gold-500/30 bg-wood-900/90 px-2.5 focus-within:border-gold-400">
          <input
            type="text"
            inputMode="decimal"
            placeholder="0.0"
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

      <div className="flex justify-center">
        <button
          type="button"
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
        <div className="mt-1 flex min-h-12 items-center gap-2 rounded-lg border border-gold-500/20 bg-wood-900/90 px-2.5">
          <span className="min-w-0 flex-1 py-2.5 text-lg font-semibold text-foreground/90 sm:text-xl">
            {estimatedOut}
          </span>
          <span className="shrink-0 rounded-md bg-forest-800/60 px-2 py-1 text-xs font-bold text-gold-300 sm:text-sm">
            {outputSymbol}
          </span>
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 text-[0.7rem] text-foreground/55 sm:text-xs">
        <label className="flex items-center gap-1.5">
          <span className="font-bold uppercase tracking-wide">Slip</span>
          <select
            value={slippage}
            onChange={(e) => {
              setSlippage(Number(e.target.value));
              setQuote(null);
            }}
            className="min-h-8 rounded-md border border-gold-500/30 bg-wood-950 px-1.5 py-1 text-foreground"
          >
            <option value={1}>1%</option>
            <option value={1.5}>1.5%</option>
            <option value={2}>2%</option>
            <option value={2.5}>2.5%</option>
            <option value={3}>3%</option>
            <option value={5}>5%</option>
          </select>
        </label>
        <span>{SITE_FEE.enabled ? `Fee ${SITE_FEE.label}` : "No fee"}</span>
      </div>

      <div className="flex flex-col gap-2">
        {!account ? (
          <button
            type="button"
            disabled={busy}
            onClick={handleConnect}
            className={`${btnBase} bg-gold-500 text-wood-950 hover:bg-gold-400`}
          >
            {busy ? "Connecting…" : "Connect wallet"}
          </button>
        ) : (
          <div className="flex min-h-10 items-center justify-between gap-2 rounded-lg border border-forest-600/45 bg-forest-900/45 px-2.5 text-xs sm:text-sm">
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
              disabled={busy || !amountIn}
              onClick={fetchQuote}
              className={`${btnBase} border border-gold-500/55 bg-wood-900 text-gold-300 hover:border-gold-400`}
            >
              {busy && !quote ? "Quoting…" : "Get quote"}
            </button>
            {/* Swap only renders for an executable quote — an indicative
                (wallet-less) price shows the Connect button above instead
                of a Swap that would silently no-op. */}
            {quote && account && !quote.indicative && (
              <button
                type="button"
                disabled={busy}
                onClick={executeSwap}
                className={`${btnBase} bg-gold-500 text-wood-950 shadow-[0_6px_16px_-4px_rgba(217,164,65,0.45)] hover:bg-gold-400`}
              >
                {busy ? "Confirm in wallet…" : SITE_FEE.enabled ? `Swap · ${SITE_FEE.label} fee` : "Swap"}
              </button>
            )}
          </>
        )}

        {apiReady === false && (
          <p className="rounded-lg border border-gold-500/30 bg-wood-900/90 px-2.5 py-2 text-center text-[0.7rem] text-foreground/70">
            Routing offline — try again shortly, or use Uniswap directly below.
          </p>
        )}

        <a
          href={uniswapUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="rounded-lg border border-gold-500/35 bg-wood-900/90 px-2.5 py-2 text-center text-[0.7rem] font-bold text-gold-300 underline-offset-2 hover:bg-gold-500/10 hover:underline"
        >
          Open this pair on Uniswap ↗
        </a>
      </div>

      {(status || error || txHash) && (
        <div className="space-y-1 text-center text-xs">
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

      <p className="text-center text-[0.65rem] text-foreground/40">
        <a
          href={explorerTokenUrl()}
          target="_blank"
          rel="noopener noreferrer"
          className="underline underline-offset-2 hover:text-gold-300"
        >
          {CONTRACT_ADDRESS.slice(0, 6)}…{CONTRACT_ADDRESS.slice(-4)}
        </a>{" "}
        · not financial advice
      </p>
      <span className="sr-only">Native {NATIVE_TOKEN_ADDRESS}; PLANK {CONTRACT_ADDRESS}</span>
    </div>
  );
}
