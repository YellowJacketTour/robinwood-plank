"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  BUY_GAS_RESERVE_ETH,
  BUY_GAS_RESERVE_WEI,
  CHAIN,
  CONTRACT_ADDRESS,
  NATIVE_TOKEN_ADDRESS,
  RULES_RELAXED,
  SITE_FEE,
  TOKEN,
  UNIVERSAL_ROUTER_ADDRESS,
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
  getChainId,
  getConnectedAccounts,
  getEthereumProvider,
  getNativeBalance,
  getErc20Balance,
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
  /** Uniswap gas hints (often decimal strings) for RH EIP-1559 */
  maxFeePerGas?: string;
  maxPriorityFeePerGas?: string;
  gasUseEstimate?: string;
  approvalNeeded?: boolean;
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
  // Higher default — meme pool moves fast; low slip → reverts (ETH gas lost, no PLANK)
  const [slippage, setSlippage] = useState(2.5);

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

      const qInner = quoteObj as Record<string, unknown>;
      setQuote({
        quote: quoteObj,
        permitData,
        permitTransaction,
        routing: (data.routing as string) || "CLASSIC",
        amountOut,
        fetchedAt: Date.now(),
        maxFeePerGas:
          (typeof qInner.maxFeePerGas === "string" && qInner.maxFeePerGas) ||
          (typeof data.maxFeePerGas === "string" ? data.maxFeePerGas : undefined),
        maxPriorityFeePerGas:
          (typeof qInner.maxPriorityFeePerGas === "string" &&
            qInner.maxPriorityFeePerGas) ||
          (typeof data.maxPriorityFeePerGas === "string"
            ? data.maxPriorityFeePerGas
            : undefined),
        gasUseEstimate:
          typeof qInner.gasUseEstimate === "string"
            ? qInner.gasUseEstimate
            : typeof qInner.gasUseEstimate === "number"
              ? String(qInner.gasUseEstimate)
              : undefined,
        approvalNeeded: Boolean(data.isTokenApprovalApplicable),
      });
      void fetch("/api/boards/ping", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address: account, kind: "quote" }),
      });
      setStatus(
        data.isTokenApprovalApplicable
          ? "Quote ready — approve then swap."
          : "Quote ready — confirm swap."
      );
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

      const parseQuotePayload = (qData: Record<string, unknown>): QuoteState => {
        const quoteObj = (qData.quote ?? qData) as Record<string, unknown>;
        const amountOut =
          (typeof qData.amountOut === "string" && qData.amountOut) ||
          (quoteObj.output as { amount?: string } | undefined)?.amount ||
          "";
        if (!amountOut) throw new Error("Quote missing output. Retry.");
        const qInner = quoteObj as Record<string, unknown>;
        // Prefer gasEstimates[0].gasLimit when Uniswap under-reports gasUseEstimate (sells often 135k)
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
            typeof qInner.maxFeePerGas === "string"
              ? qInner.maxFeePerGas
              : typeof qInner.maxFeePerGas === "number"
                ? String(qInner.maxFeePerGas)
                : undefined,
          maxPriorityFeePerGas:
            typeof qInner.maxPriorityFeePerGas === "string"
              ? qInner.maxPriorityFeePerGas
              : typeof qInner.maxPriorityFeePerGas === "number"
                ? String(qInner.maxPriorityFeePerGas)
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
          `Wallet is on chain ${chainId}, not ${CHAIN.name} (${CHAIN.id}). Switch network. This widget never bridges ETH to Ethereum.`
        );
      }

      // Buys: leave ETH for gas so the tx is not underfunded / stuck
      if (direction === "buy") {
        const bal = await getNativeBalance(account);
        if (bal <= BUY_GAS_RESERVE_WEI) {
          throw new Error(
            `Not enough ETH for gas. Keep at least ~${BUY_GAS_RESERVE_ETH} ETH free after the buy amount.`
          );
        }
        if (raw + BUY_GAS_RESERVE_WEI > bal) {
          throw new Error(
            `Buy amount too high — leave ~${BUY_GAS_RESERVE_ETH} ETH free for gas. Your ETH stays on Robinhood Chain (this is a swap, not a bridge).`
          );
        }
      }

      // Fresh quote immediately before approve/swap
      setStatus("Refreshing quote…");
      let active = await fetchFreshQuote();
      setQuote(active);

      // --- Sell approvals: always verify Permit2 ERC-20 allowance on-chain ---
      // Uniswap may omit permitTransaction even when isTokenApprovalApplicable=true.
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
          await waitForTransaction(approveHash, {
            label: "Approval",
            timeoutMs: 120_000,
          });
          return true;
        };

        if (active.permitTransaction?.to && active.permitTransaction?.data) {
          didOnChainApprove = await tryApproveTx(
            active.permitTransaction,
            "Approve $PLANK in wallet…"
          );
        }

        if (!didOnChainApprove) {
          setStatus("Checking Permit2 approval…");
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
            message?: string;
          };
          // Uniswap uses `approval`; some shapes use `request`
          const approvalTx = apprData?.approval || apprData?.request || null;
          if (appr.ok && approvalTx) {
            didOnChainApprove = await tryApproveTx(
              approvalTx,
              "Approve $PLANK (Permit2)…"
            );
          }
        }

        // After on-chain approve, MUST re-quote — permitData/nonce becomes valid only then
        if (didOnChainApprove) {
          setStatus("Approval confirmed — refreshing quote…");
          active = await fetchFreshQuote();
          setQuote(active);
        }
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
      // Never send swap value to anything except official UR on RH
      if (tx.to.toLowerCase() !== UNIVERSAL_ROUTER_ADDRESS.toLowerCase()) {
        throw new Error(
          "Blocked: swap target is not Uniswap Universal Router. No bridge, no unknown contract."
        );
      }
      // Buy must send native ETH
      if (direction === "buy" && (!tx.value || tx.value === "0x0" || tx.value === "0")) {
        throw new Error("Swap missing ETH value. Get a fresh quote and retry.");
      }

      // gasHints from server (quote eip1559) as extra fallback
      const hints = data.gasHints as
        | {
            maxFeePerGas?: string | null;
            maxPriorityFeePerGas?: string | null;
            gasUseEstimate?: string | null;
          }
        | undefined;

      // Snapshot balances so we can prove delivery (never claim success without tokens)
      const plankBefore =
        direction === "buy"
          ? await getErc20Balance(CONTRACT_ADDRESS, account)
          : BigInt(0);
      const ethBefore =
        direction === "sell" ? await getNativeBalance(account) : BigInt(0);

      setStatus("Simulating swap on Robinhood Chain (no bridge)…");
      const hash = await sendTransaction({
        to: tx.to,
        from: account,
        data: tx.data,
        value: tx.value,
        gasLimit:
          tx.gasLimit ||
          tx.gas ||
          active.gasUseEstimate ||
          (hints?.gasUseEstimate ? String(hints.gasUseEstimate) : undefined),
        maxFeePerGas:
          (tx.maxFeePerGas && String(tx.maxFeePerGas)) ||
          active.maxFeePerGas ||
          (hints?.maxFeePerGas ? String(hints.maxFeePerGas) : undefined),
        maxPriorityFeePerGas:
          (tx.maxPriorityFeePerGas && String(tx.maxPriorityFeePerGas)) ||
          active.maxPriorityFeePerGas ||
          (hints?.maxPriorityFeePerGas
            ? String(hints.maxPriorityFeePerGas)
            : undefined),
        gasPrice: tx.gasPrice ? String(tx.gasPrice) : undefined,
        kind: "swap",
      });
      setTxHash(hash);
      setStatus("Submitted on Robinhood Chain — waiting for confirmation…");
      let delivered = false;
      try {
        await waitForTransaction(hash, {
          label: "Swap",
          timeoutMs: 120_000,
          onPending: (ms) => {
            if (ms > 30_000) {
              setStatus(
                "Still pending on Robinhood Chain… Speed Up in wallet if stuck. This is NOT a bridge to Ethereum."
              );
            } else if (ms > 10_000) {
              setStatus("Waiting for Robinhood Chain block…");
            }
          },
        });

        // Prove tokens arrived — never claim success without balance increase
        if (direction === "buy") {
          await new Promise((r) => setTimeout(r, 1500));
          const plankAfter = await getErc20Balance(CONTRACT_ADDRESS, account);
          if (plankAfter <= plankBefore) {
            setError(
              "Tx mined but $PLANK did not arrive. Import token CA in wallet. If explorer shows Failed, only gas was spent (buy ETH refunded)."
            );
            setStatus("No $PLANK increase yet — check explorer / import CA.");
          } else {
            delivered = true;
            setStatus(
              `Swap confirmed ✓ $PLANK received on ${CHAIN.name}. Import CA if wallet hides it.`
            );
          }
        } else {
          await new Promise((r) => setTimeout(r, 1500));
          const ethAfter = await getNativeBalance(account);
          if (ethAfter <= ethBefore) {
            setError(
              "Tx mined but ETH did not increase. Check explorer — if Failed, only gas spent."
            );
            setStatus("Sell mined — verify ETH on explorer.");
          } else {
            delivered = true;
            setStatus("Swap confirmed ✓ ETH received on Robinhood Chain");
          }
        }
      } catch (waitErr) {
        setError(waitErr instanceof Error ? waitErr.message : "Confirmation timed out.");
        setStatus(
          "Check explorer on Robinhood Chain. Reverted = buy ETH refunded (gas only lost). Bridge UI is unrelated."
        );
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
          <div className="mt-2.5 space-y-1.5">
            <p className="rounded-lg border border-emerald-500/30 bg-forest-900/75 px-2.5 py-2 text-[0.7rem] leading-snug text-foreground/80 sm:text-xs">
              <strong className="text-emerald-300">Live on {CHAIN.name} only:</strong> this
              is a Uniswap swap (ETH ↔ $PLANK).{" "}
              <strong className="text-foreground">Not a bridge</strong> — ETH never leaves
              to Ethereum mainnet from this button. No widget fee · full output to you.
            </p>
            <p className="rounded-lg border border-amber-500/35 bg-amber-950/40 px-2.5 py-2 text-[0.65rem] leading-snug text-amber-100/90 sm:text-[0.7rem]">
              <strong className="text-amber-200">If your wallet says “sent to Ethereum /
              processed on rollup”:</strong> that is a <em>bridge withdraw</em> (can take ~7
              days + L1 claim) — <strong>not</strong> this swap. Do not bridge while buying
              $PLANK. Leave ~{BUY_GAS_RESERVE_ETH} ETH free for gas on buys.
            </p>
          </div>
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
            {SITE_FEE.enabled ? `Fee ${SITE_FEE.label}` : "No widget fee"} · ETH/{TOKEN.symbol}
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
                  {busy
                    ? "Confirm in wallet…"
                    : SITE_FEE.enabled
                      ? `Swap · ${SITE_FEE.label} fee`
                      : "Swap — full $PLANK to you"}
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
          ETH ↔ {TOKEN.symbol} · chain {CHAIN.id} ({CHAIN.name}) only · no bridge ·{" "}
          {SITE_FEE.enabled ? `fee ${SITE_FEE.label}` : "no widget fee"} · not financial advice
        </p>
        <span className="sr-only">
          Native {NATIVE_TOKEN_ADDRESS}; PLANK {CONTRACT_ADDRESS}
        </span>
      </div>
    </div>
  );
}
