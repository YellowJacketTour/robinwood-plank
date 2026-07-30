"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, ArrowLeftRight, ChevronDown, ChevronRight, RefreshCw } from "lucide-react";
import {
  BUY_GAS_RESERVE_ETH,
  BUY_GAS_RESERVE_WEI,
  CHAIN,
  CONTRACT_ADDRESS,
  GASLESS_SWAPS_ENABLED,
  NATIVE_TOKEN_ADDRESS,
  SITE_FEE,
  TOKEN,
  UNIVERSAL_ROUTER_ADDRESS,
} from "@/lib/constants";
import {
  buildUniswapSwapUrl,
  explorerTokenUrl,
  formatDisplayAmount,
  parseTokenAmount,
  shortAddress,
} from "@/lib/trade";
import { formatUsd, weiToUsd } from "@/lib/eth-price";
import { startVisibleInterval } from "@/lib/useVisibleInterval";
import {
  ensureRobinhoodChain,
  getChainId,
  getErc20Balance,
  getNativeBalance,
  sendTransaction,
  signTypedData,
  waitForTransaction,
} from "@/lib/wallet";
import { useWallet } from "@/lib/wallet-context";
import dynamic from "next/dynamic";
import TokenSelectModal from "@/components/trade/TokenSelectModal";
import TokenIcon from "@/components/trade/TokenIcon";
import GaslessToggle from "@/components/trade/GaslessToggle";
import OrderStatus from "@/components/trade/OrderStatus";

/** Routing values that mean "this is a UniswapX order — use /api/uniswap/order,
 * not /api/uniswap/swap". Mirrors lib/uniswap-server.ts's DUTCH_ROUTINGS
 * (kept as a small local copy — this file is client-only and must not import
 * the server module, which pulls in DB-backed lib/boards-store etc). */
const DUTCH_ROUTINGS = new Set(["DUTCH_V2", "DUTCH_V3", "LIMIT_ORDER", "PRIORITY"]);
function isDutchRouting(routing: string): boolean {
  return DUTCH_ROUTINGS.has(routing);
}

/** Same connect surface the market uses (WalletConnect QR + extension) —
 * loaded on demand; the WC runtime itself only loads on "Show QR". */
const ConnectWalletModal = dynamic(() => import("@/components/ConnectWalletModal"), {
  ssr: false,
});

/** Quotes go stale — this drives the countdown ring and the auto-refetch
 * cadence. Separate from lib/trade's QUOTE_MAX_AGE_MS, which gates whether
 * an EXECUTABLE quote is fresh enough to swap; this one is purely display. */
const QUOTE_TTL_MS = 30_000;

/** One route hop from the real Uniswap quote response (v3-pool / v2-pool
 * entries) — only the fields the route line actually renders. */
type RouteHop = {
  tokenIn?: { symbol?: string };
  tokenOut?: { symbol?: string };
};

type Direction = "buy" | "sell";

/** Mirror of lib/uniswap-tokenlist's CounterToken (client copy — the list
 * itself always comes from /api/uniswap/tokens, never client-authored). */
type CounterTokenEntry = {
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  logoURI?: string;
  /** True for a token imported by address (on-chain ERC20 metadata only,
   * never curated) — the pill stays flagged after selection, not just in
   * the picker, so the warning doesn't disappear once the modal closes. */
  unverified?: boolean;
};

const NATIVE_COUNTER_ENTRY: CounterTokenEntry = {
  address: NATIVE_TOKEN_ADDRESS,
  symbol: "ETH",
  name: "Ether",
  decimals: 18,
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
  maxFeePerGas?: string;
  maxPriorityFeePerGas?: string;
  gasUseEstimate?: string;
  approvalNeeded?: boolean;
  /** Priced without a wallet — display only, never executable. */
  indicative?: boolean;
  /** Present only for UniswapX/Dutch quotes — the order the client signs
   * as-is and relays to /api/uniswap/order. */
  encodedOrder?: string;
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
  // Wallet connection is shared app-wide (lib/wallet-context.tsx) so this
  // widget never contradicts the nav or the cross-chain panel — previously
  // this was its own useState populated via getConnectedAccounts(), the
  // owner-reported bug's root cause.
  const { address: account, chainId: walletChainId, connect: walletConnect, adoptAccount: walletAdoptAccount } = useWallet();
  const [direction, setDirection] = useState<Direction>("buy");
  const [amountIn, setAmountIn] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [quote, setQuote] = useState<QuoteState | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);
  const [apiReady, setApiReady] = useState<boolean | null>(null);
  const [slippage, setSlippage] = useState(2.5);
  // Phase B: opt-in gasless (UniswapX) routing. Only meaningful when the
  // server has GASLESS_SWAPS_ENABLED on — otherwise the quote route just
  // ignores this and returns the same CLASSIC quote as always.
  const [gaslessOpted, setGaslessOpted] = useState(false);
  const [orderHash, setOrderHash] = useState<string | null>(null);

  /** The non-PLANK side of the pair. Server-validated allowlist: native
   * ETH + the official Uniswap token list for this chain (tokenized
   * stocks). PLANK is always the other side; the router handles multihop. */
  const [counters, setCounters] = useState<CounterTokenEntry[]>([NATIVE_COUNTER_ENTRY]);
  const [counter, setCounter] = useState<CounterTokenEntry>(NATIVE_COUNTER_ENTRY);
  const counterIsNative = counter.address.toLowerCase() === NATIVE_TOKEN_ADDRESS.toLowerCase();

  const inputSymbol = direction === "buy" ? counter.symbol : TOKEN.symbol;
  const outputSymbol = direction === "buy" ? TOKEN.symbol : counter.symbol;
  const inputDecimals = direction === "buy" ? counter.decimals : TOKEN.decimals;

  const [tokenModalOpen, setTokenModalOpen] = useState(false);
  const [rateInverted, setRateInverted] = useState(false);
  const [ethUsd, setEthUsd] = useState(0);
  // Drives the quote-age countdown ring; ticks only while the tab is visible.
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    let cancelled = false;
    // Cheapest existing USD source — the same field VaultDashboard reads,
    // no new endpoint. Best-effort: USD lines just don't render without it.
    fetch("/api/market/vault/stats")
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { ethUsd?: number } | null) => {
        if (!cancelled && typeof d?.ethUsd === "number" && d.ethUsd > 0) setEthUsd(d.ethUsd);
      })
      .catch(() => {
        /* USD estimates just stay hidden */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    return startVisibleInterval(() => setNowMs(Date.now()), 1000);
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/uniswap/tokens")
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { counters?: CounterTokenEntry[] } | null) => {
        if (cancelled || !d?.counters?.length) return;
        setCounters(d.counters);
      })
      .catch(() => {
        /* selector stays ETH-only — the pre-feature behavior */
      });
    return () => {
      cancelled = true;
    };
  }, []);

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
    return () => {
      cancelled = true;
    };
  }, []);

  // The context already owns the single accountsChanged/chainChanged
  // subscription; this widget just reacts to the values it exposes —
  // mirrors the existing "reset on counter change" effect below.
  useEffect(() => {
    setQuote(null);
  }, [account]);

  useEffect(() => {
    setQuote(null);
    setStatus(null);
  }, [walletChainId]);

  const [connectOpen, setConnectOpen] = useState(false);

  /** Post-connect bookkeeping shared by both connect paths (injected via
   * handleConnect below, and WalletConnect via ConnectWalletModal). */
  const adoptAccount = useCallback(
    (addr: string) => {
      walletAdoptAccount(addr);
      // An indicative (wallet-less) quote can't be executed — clear it so
      // the user re-quotes as themselves.
      setQuote((q) => (q?.indicative ? null : q));
      setStatus(null);
      setError(null);
    },
    [walletAdoptAccount]
  );

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
      const addr = await walletConnect();
      adoptAccount(addr);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to connect wallet.");
    } finally {
      setBusy(false);
    }
  }, [walletConnect, adoptAccount]);

  const flipDirection = () => {
    setDirection((d) => (d === "buy" ? "sell" : "buy"));
    setAmountIn("");
    setQuote(null);
    setTxHash(null);
    setOrderHash(null);
    setError(null);
    setStatus(null);
  };

  const fetchQuote = useCallback(async () => {
    setError(null);
    setStatus(null);
    setTxHash(null);
    setOrderHash(null);
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
          counterToken: counterIsNative ? undefined : counter.address,
          ...(GASLESS_SWAPS_ENABLED && gaslessOpted ? { gasless: true } : {}),
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
        encodedOrder: typeof qInner.encodedOrder === "string" ? qInner.encodedOrder : undefined,
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
  }, [amountIn, inputDecimals, account, direction, slippage, counter, counterIsNative, gaslessOpted]);

  // Uniswap-interface behavior: typing auto-quotes (debounced) — no button
  // press needed for a price. Any change to the inputs re-quotes; clearing
  // the amount clears the quote.
  const fetchQuoteRef = useRef(fetchQuote);
  fetchQuoteRef.current = fetchQuote;
  useEffect(() => {
    const raw = parseTokenAmount(amountIn, inputDecimals);
    if (raw === null || raw <= BigInt(0)) {
      setQuote(null);
      return;
    }
    const timer = window.setTimeout(() => void fetchQuoteRef.current(), 600);
    return () => window.clearTimeout(timer);
  }, [amountIn, inputDecimals, direction, slippage, counter, account, gaslessOpted]);

  // Quote freshness: while a quote is showing, the amount is still valid, and
  // the tab is visible, silently re-quote once it crosses QUOTE_TTL_MS. Pauses
  // in background tabs via startVisibleInterval — no always-on timer.
  useEffect(() => {
    if (!quote) return;
    return startVisibleInterval(
      () => {
        const raw = parseTokenAmount(amountIn, inputDecimals);
        if (raw === null || raw <= BigInt(0)) return;
        if (Date.now() - quote.fetchedAt >= QUOTE_TTL_MS) void fetchQuoteRef.current();
      },
      1000,
      { runOnRestore: false }
    );
  }, [quote, amountIn, inputDecimals]);

  // Switching the counter token invalidates any priced quote immediately.
  useEffect(() => {
    setQuote(null);
    setStatus(null);
    setRateInverted(false);
  }, [counter]);

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
          encodedOrder: typeof qInner.encodedOrder === "string" ? qInner.encodedOrder : undefined,
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
            // MUST match the counter the user actually chose. Omitting it
            // re-prices the trade against native ETH at execution time, so a
            // buy with a non-native counter (AAPL, USDG, …) would build a
            // swap for the wrong pair entirely.
            counterToken: counterIsNative ? undefined : counter.address,
            ...(GASLESS_SWAPS_ENABLED && gaslessOpted ? { gasless: true } : {}),
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
        if (counterIsNative) {
          const bal = await getNativeBalance(account);
          if (bal <= BUY_GAS_RESERVE_WEI || raw + BUY_GAS_RESERVE_WEI > bal) {
            throw new Error(
              `Leave ~${BUY_GAS_RESERVE_ETH} ETH free for gas after the buy amount.`
            );
          }
        } else {
          // ERC-20 counter: the token balance covers the amount; gas is
          // still paid in ETH, checked separately.
          const [tokenBal, ethBal] = await Promise.all([
            getErc20Balance(counter.address, account),
            getNativeBalance(account),
          ]);
          if (raw > tokenBal) {
            throw new Error(`Not enough ${counter.symbol} for that amount.`);
          }
          if (ethBal < BUY_GAS_RESERVE_WEI) {
            throw new Error(`Keep ~${BUY_GAS_RESERVE_ETH} ETH for gas.`);
          }
        }
      }

      setStatus("Refreshing quote…");
      let active = await fetchFreshQuote();
      setQuote(active);

      let didOnChainApprove = false;
      // Approval applies whenever the INPUT side is an ERC-20: selling
      // PLANK, or buying PLANK with a non-native counter token.
      const erc20In = direction === "sell" ? CONTRACT_ADDRESS : counterIsNative ? null : counter.address;
      const erc20InSymbol = direction === "sell" ? "$PLANK" : counter.symbol;
      if (erc20In) {
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
          didOnChainApprove = await tryApproveTx(active.permitTransaction, `Approve ${erc20InSymbol}…`);
        }

        if (!didOnChainApprove) {
          setStatus("Checking approval…");
          const appr = await fetch("/api/uniswap/check-approval", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              walletAddress: account,
              token: erc20In,
              amount: raw.toString(),
            }),
          });
          const apprData = (await appr.json()) as {
            approval?: Record<string, unknown> | null;
            request?: Record<string, unknown> | null;
          };
          const approvalTx = apprData?.approval || apprData?.request || null;
          if (appr.ok && approvalTx) {
            didOnChainApprove = await tryApproveTx(approvalTx, `Approve ${erc20InSymbol}…`);
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

      // Gasless (UniswapX) path: no swap tx to build or send. The order is
      // already fully formed by /api/uniswap/quote (encodedOrder); the
      // signature above is over that same order, so submitting it is just a
      // relay — a filler broadcasts the actual fill. OrderStatus (rendered
      // below) takes over from here and polls until Filled/Expired/etc.
      if (isDutchRouting(active.routing)) {
        if (!active.encodedOrder) {
          throw new Error("Gasless order missing encoded order data. Get a fresh quote and retry.");
        }
        if (!signature) {
          throw new Error("Gasless order requires a signature. Get a fresh quote and retry.");
        }
        setStatus("Submitting gasless order…");
        const orderRes = await fetch("/api/uniswap/order", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            quote: active.quote,
            encodedOrder: active.encodedOrder,
            signature,
            swapper: account,
          }),
        });
        const orderData = await orderRes.json();
        if (!orderRes.ok) {
          throw new Error(orderData.message || orderData.error || "Gasless order submission failed.");
        }
        if (!orderData.orderHash) {
          throw new Error("Order submitted but no order hash returned — cannot track status.");
        }
        setOrderHash(orderData.orderHash);
        setStatus("Order submitted — a filler settles it, no gas from you.");
        void fetch("/api/boards/ping", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ address: account, kind: "swap" }),
        });
        return;
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
  }, [quote, account, amountIn, inputDecimals, direction, slippage, counter, counterIsNative, gaslessOpted]);

  const estimatedOut = useMemo(() => {
    if (!quote?.amountOut) return "—";
    try {
      const outDecimals = direction === "buy" ? TOKEN.decimals : counter.decimals;
      return formatDisplayAmount(quote.amountOut, outDecimals);
    } catch {
      return "—";
    }
  }, [quote, direction, counter]);

  const outputDecimals = direction === "buy" ? TOKEN.decimals : counter.decimals;

  // Quote-age ring: 0 = just fetched, 1 = at/after QUOTE_TTL_MS.
  const quoteAgeFrac = quote ? Math.max(0, Math.min(1, (nowMs - quote.fetchedAt) / QUOTE_TTL_MS)) : 0;

  // "1 inputSymbol = X outputSymbol" (and its invert) computed from the
  // quote's raw base-unit amounts with bigint mul/div at full precision —
  // only the final display value goes through formatDisplayAmount.
  const rate = useMemo(() => {
    if (!quote?.amountOut) return null;
    const inRaw = parseTokenAmount(amountIn, inputDecimals);
    if (inRaw === null || inRaw <= BigInt(0)) return null;
    let outRaw: bigint;
    try {
      outRaw = BigInt(quote.amountOut);
    } catch {
      return null;
    }
    if (outRaw <= BigInt(0)) return null;

    const PRECISION_DIGITS = 24;
    const precision = BigInt(10) ** BigInt(PRECISION_DIGITS);
    const inScale = BigInt(10) ** BigInt(inputDecimals);
    const outScale = BigInt(10) ** BigInt(outputDecimals);

    const forwardScaled = (outRaw * inScale * precision) / (inRaw * outScale);
    const inverseScaled = (inRaw * outScale * precision) / (outRaw * inScale);

    return {
      forward: formatDisplayAmount(forwardScaled, PRECISION_DIGITS),
      inverse: formatDisplayAmount(inverseScaled, PRECISION_DIGITS),
    };
  }, [quote, amountIn, inputDecimals, outputDecimals]);

  // Route line from the quote's real route array (v3-pool / v2-pool hops) —
  // the first split path is representative; never a computed/fake route.
  const routeLine = useMemo(() => {
    const q = quote?.quote as { route?: RouteHop[][] } | undefined;
    const path = q?.route?.[0];
    if (!Array.isArray(path) || path.length === 0) return null;
    const symbols: string[] = [];
    path.forEach((hop, i) => {
      const inSym = hop.tokenIn?.symbol;
      const outSym = hop.tokenOut?.symbol;
      if (i === 0 && inSym) symbols.push(inSym === "WETH" ? "ETH" : inSym);
      if (outSym) symbols.push(outSym === "WETH" ? "ETH" : outSym);
    });
    return symbols.length > 1 ? symbols.join(" → ") : null;
  }, [quote]);

  // priceImpact is a real field on the upstream quote (percent) — only
  // rendered when the API actually returns it, never computed client-side.
  const priceImpact = useMemo(() => {
    const q = quote?.quote as { priceImpact?: unknown } | undefined;
    const raw = q?.priceImpact;
    const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
    return Number.isFinite(n) ? n : null;
  }, [quote]);

  const impactColorClass =
    priceImpact == null
      ? ""
      : priceImpact < 1
        ? "text-forest-600"
        : priceImpact < 3
          ? "text-gold-300"
          : "text-red-300";

  // USD estimates: only derivable when one side is native ETH (ethUsd comes
  // from the same source VaultDashboard uses). Stock counter tokens have no
  // price source here, so both sides stay blank rather than fabricate one —
  // the opposite (PLANK) side is derived from the swap's own ratio, i.e. the
  // same trade value, once a quote actually confirms that ratio.
  const usdEstimate = useMemo(() => {
    if (!(ethUsd > 0) || !counterIsNative) return { pay: null as string | null, receive: null as string | null };
    if (direction === "buy") {
      const payWei = parseTokenAmount(amountIn, 18);
      const payUsd = payWei && payWei > BigInt(0) ? weiToUsd(payWei, ethUsd) : 0;
      const pay = payUsd > 0 ? formatUsd(payUsd) : null;
      const receive = pay && quote ? pay : null;
      return { pay, receive };
    }
    const receiveWei = quote?.amountOut ? (() => {
      try {
        return BigInt(quote.amountOut);
      } catch {
        return null;
      }
    })() : null;
    const receiveUsd = receiveWei && receiveWei > BigInt(0) ? weiToUsd(receiveWei, ethUsd) : 0;
    const receive = receiveUsd > 0 ? formatUsd(receiveUsd) : null;
    const pay = receive; // PLANK side derived from the same trade value
    return { pay, receive };
  }, [ethUsd, counterIsNative, direction, amountIn, quote]);

  const btnBase =
    "min-h-11 w-full rounded-lg px-3 py-2.5 text-sm font-bold transition-colors disabled:cursor-not-allowed disabled:opacity-50 sm:text-base";

  return (
    <div className="wood-ledger space-y-2.5 p-2.5 sm:p-3">
      <ConnectWalletModal
        open={connectOpen}
        onClose={() => setConnectOpen(false)}
        onConnected={adoptAccount}
      />
      <TokenSelectModal
        open={tokenModalOpen}
        onClose={() => setTokenModalOpen(false)}
        tokens={counters}
        selected={counter}
        onSelect={setCounter}
        account={account}
        title={direction === "buy" ? "Select token to pay with" : "Select token to receive"}
      />
      <p className="rounded-lg border border-amber-500/35 bg-amber-950/40 px-2.5 py-1.5 text-[0.65rem] leading-snug text-amber-100/90 sm:text-[0.7rem]">
        <strong className="text-amber-200">Not a bridge:</strong> swaps only go to the Uniswap
        Router on {CHAIN.name} — never Ethereum L1. Keep ~{BUY_GAS_RESERVE_ETH} ETH free for gas.
      </p>

      {counter.unverified && (
        <p className="flex items-start gap-1.5 rounded-lg border border-amber-500/40 bg-amber-950/30 px-2.5 py-1.5 text-[0.65rem] leading-snug text-amber-100/90 sm:text-[0.7rem]">
          <AlertTriangle size={13} className="mt-0.5 shrink-0 text-amber-300" />
          <span>
            <strong className="text-amber-200">Unverified token — {counter.symbol}:</strong> imported
            by address, not on the curated list. Trade at your own risk.
          </span>
        </p>
      )}

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
          {direction === "buy" ? (
            <button
              type="button"
              onClick={() => setTokenModalOpen(true)}
              aria-label="Change token to pay with"
              className="flex shrink-0 items-center gap-1.5 rounded-full bg-gold-500/15 py-1.5 pl-1.5 pr-2.5 text-xs font-bold text-gold-300 transition-colors hover:bg-gold-500/25 sm:text-sm"
            >
              <TokenIcon symbol={counter.symbol} logoURI={counter.logoURI} size={18} />
              {counter.symbol}
              {counter.unverified && (
                <AlertTriangle size={12} className="text-amber-300" aria-label="Unverified token" />
              )}
              <ChevronDown size={14} />
            </button>
          ) : (
            <span className="shrink-0 rounded-md bg-gold-500/15 px-2 py-1 text-xs font-bold text-gold-300 sm:text-sm">
              {inputSymbol}
            </span>
          )}
        </div>
        {usdEstimate.pay && (
          <p className="mt-1 text-right text-[0.65rem] text-foreground/45">≈ {usdEstimate.pay}</p>
        )}
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
          {direction === "sell" ? (
            <button
              type="button"
              onClick={() => setTokenModalOpen(true)}
              aria-label="Change token to receive"
              className="flex shrink-0 items-center gap-1.5 rounded-full bg-forest-800/60 py-1.5 pl-1.5 pr-2.5 text-xs font-bold text-gold-300 transition-colors hover:bg-forest-800 sm:text-sm"
            >
              <TokenIcon symbol={counter.symbol} logoURI={counter.logoURI} size={18} />
              {counter.symbol}
              {counter.unverified && (
                <AlertTriangle size={12} className="text-amber-300" aria-label="Unverified token" />
              )}
              <ChevronDown size={14} />
            </button>
          ) : (
            <span className="shrink-0 rounded-md bg-forest-800/60 px-2 py-1 text-xs font-bold text-gold-300 sm:text-sm">
              {outputSymbol}
            </span>
          )}
        </div>
        {usdEstimate.receive && (
          <p className="mt-1 text-right text-[0.65rem] text-foreground/45">≈ {usdEstimate.receive}</p>
        )}
      </div>

      {quote && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-gold-500/15 bg-wood-950/60 px-2.5 py-2 text-[0.7rem] text-foreground/65 sm:text-xs">
          <div className="flex min-w-0 items-center gap-1.5">
            {rate ? (
              <button
                type="button"
                onClick={() => setRateInverted((v) => !v)}
                className="flex min-w-0 items-center gap-1 truncate text-left font-semibold text-foreground/80 hover:text-gold-300"
                title="Flip the displayed rate direction"
              >
                <span className="truncate">
                  {rateInverted
                    ? `1 ${outputSymbol} = ${rate.inverse} ${inputSymbol}`
                    : `1 ${inputSymbol} = ${rate.forward} ${outputSymbol}`}
                </span>
                <ArrowLeftRight size={12} className="shrink-0" />
              </button>
            ) : (
              <span className="text-foreground/40">Rate unavailable</span>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            {quote.indicative && (
              <span className="rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[0.6rem] font-bold text-amber-200">
                Indicative
              </span>
            )}
            <button
              type="button"
              onClick={() => void fetchQuote()}
              disabled={busy}
              aria-label="Refresh quote"
              title="Refresh quote"
              className="flex h-6 w-6 items-center justify-center rounded-full text-gold-300/80 transition-colors hover:text-gold-300 disabled:opacity-40"
            >
              <RefreshCw size={13} className={busy ? "animate-spin" : ""} />
            </button>
            <svg
              width="18"
              height="18"
              viewBox="0 0 20 20"
              className="-rotate-90 shrink-0 text-gold-400"
              aria-hidden="true"
            >
              <circle cx="10" cy="10" r="8" stroke="currentColor" strokeOpacity="0.2" strokeWidth="2.5" fill="none" />
              <circle
                cx="10"
                cy="10"
                r="8"
                stroke="currentColor"
                strokeWidth="2.5"
                fill="none"
                strokeLinecap="round"
                strokeDasharray={2 * Math.PI * 8}
                strokeDashoffset={2 * Math.PI * 8 * quoteAgeFrac}
              />
            </svg>
          </div>
        </div>
      )}

      {quote && (routeLine || priceImpact != null) && (
        <details className="group rounded-lg border border-gold-500/15 bg-wood-950/40 px-2.5 py-1.5 text-[0.7rem] text-foreground/60 sm:text-xs">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-2 font-bold uppercase tracking-wide text-foreground/50">
            <span>Route &amp; impact</span>
            <ChevronRight size={13} className="shrink-0 transition-transform group-open:rotate-90" />
          </summary>
          <div className="mt-1.5 space-y-1">
            {routeLine && <p className="truncate font-mono text-foreground/70">{routeLine}</p>}
            {priceImpact != null && (
              <p className={`font-semibold ${impactColorClass}`}>
                Price impact {priceImpact >= 0 ? "" : "-"}
                {Math.abs(priceImpact).toFixed(2)}%
              </p>
            )}
          </div>
        </details>
      )}

      {GASLESS_SWAPS_ENABLED && (
        <GaslessToggle
          checked={gaslessOpted}
          disabled={busy}
          onChange={(next) => {
            setGaslessOpted(next);
            setQuote(null);
            setOrderHash(null);
          }}
        />
      )}

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

      {orderHash && account && (
        <OrderStatus
          orderHash={orderHash}
          swapper={account}
          onFilled={() => {
            setStatus("Order filled — no gas paid.");
            setQuote(null);
            setAmountIn("");
          }}
          onTerminal={(finalStatus) => {
            if (finalStatus !== "Filled") {
              setError(
                finalStatus === "Expired"
                  ? "Order expired without a fill — no funds moved. Get a fresh quote."
                  : `Order ended: ${finalStatus}. No funds moved unless filled.`
              );
            }
          }}
        />
      )}

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
