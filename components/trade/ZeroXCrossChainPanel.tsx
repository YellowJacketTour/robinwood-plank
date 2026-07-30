"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronRight, Loader2, Percent, ShieldAlert, Zap } from "lucide-react";
import { TOKEN } from "@/lib/constants";
import { formatDisplayAmount, formatTokenAmount, parseTokenAmount, shortAddress } from "@/lib/trade";
import { useWallet } from "@/lib/wallet-context";
import { getWalletChainId, sendCrossChainStepTx, switchToChain } from "@/lib/crosschain-wallet";
import TokenIcon from "@/components/trade/TokenIcon";
import ChainSelectModal, { type SourceChainOption } from "@/components/trade/ChainSelectModal";

type StatusResponse = {
  enabled: boolean;
  crossChainEnabled?: boolean;
  configured?: boolean;
  sourceChains?: SourceChainOption[];
  siteFee?: { enabled: boolean; label: string; exactLabel?: string };
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
  /** Only rendered if the API actually returns these — never fabricated. */
  route?: string;
  provider?: string;
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

/** Display-only source-chain native symbol — mirrors lib/crosschain-wallet.ts's
 * CHAIN_METADATA. Never used for tx-building (that stays server/wallet-side),
 * purely so the "You pay" field can show "0.05 ETH" instead of a bare number. */
const NATIVE_SYMBOL: Record<number, string> = {
  1: "ETH",
  42161: "ETH",
  8453: "ETH",
  10: "ETH",
  137: "POL",
};

/**
 * Public read-only RPC endpoints, used ONLY to display a balance for the
 * currently-selected source chain — never for building or sending a
 * transaction (that always goes through the connected wallet's own
 * provider, via lib/crosschain-wallet.ts). A direct RPC read (rather than
 * the wallet's own eth_getBalance) is required here because the wallet's
 * provider reports whatever chain it's CURRENTLY pointed at, which can
 * differ from the source chain selected in this panel — the same ambiguity
 * SwapWidget doesn't have, since it only ever targets one chain.
 * Intentionally a local, independent copy rather than importing from
 * lib/crosschain-wallet.ts's CHAIN_METADATA (out of scope to edit here).
 */
const SOURCE_CHAIN_RPC: Record<number, string> = {
  1: "https://cloudflare-eth.com",
  42161: "https://arb1.arbitrum.io/rpc",
  8453: "https://mainnet.base.org",
  10: "https://mainnet.optimism.io",
  137: "https://polygon-rpc.com",
};

/** Conservative gas reserves per source chain for the MAX button — L1 gas
 * costs meaningfully more than L2s, so one flat reserve (as SwapWidget uses
 * for Robinhood Chain alone) would be wrong here. Display-only estimate:
 * the wallet and 0x's own quote/tx simulation remain the real gate before
 * anything is signed — this only keeps MAX from proposing an amount that
 * obviously can't also cover gas. */
const GAS_RESERVE_WEI: Record<number, bigint> = {
  1: BigInt("3000000000000000"), // ~0.003 ETH — L1
  42161: BigInt("200000000000000"), // ~0.0002 ETH — L2
  8453: BigInt("200000000000000"),
  10: BigInt("200000000000000"),
  137: BigInt("100000000000000"), // ~0.0001 POL
};

/** Direct JSON-RPC balance read for the selected source chain — display
 * only, see SOURCE_CHAIN_RPC above. Never throws; a failed/unsupported read
 * just leaves the balance/MAX affordance hidden rather than erroring the
 * whole panel. */
async function fetchSourceChainBalance(chainId: number, address: string): Promise<bigint | null> {
  const rpcUrl = SOURCE_CHAIN_RPC[chainId];
  if (!rpcUrl) return null;
  try {
    const res = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_getBalance",
        params: [address, "latest"],
      }),
    });
    const data = (await res.json().catch(() => null)) as { result?: string } | null;
    if (!data?.result) return null;
    return BigInt(data.result);
  } catch {
    return null;
  }
}

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
 * Anatomy deliberately mirrors SwapWidget.tsx — a "You pay" field (amount +
 * chain pill) and a "You receive" field (PLANK, with icon) — so this reads as
 * the same product as the same-chain widget instead of a bolted-on form.
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

  // Shared app-wide wallet state (lib/wallet-context.tsx) — this panel
  // previously kept its own useState populated once via getConnectedAccounts()
  // with NO accountsChanged listener, so a disconnect in the wallet never
  // reflected here at all. useWallet() fixes both the sharing and that gap.
  const { address: account, connect: walletConnect } = useWallet();
  const [sourceChainId, setSourceChainId] = useState<number | null>(null);
  const [chainModalOpen, setChainModalOpen] = useState(false);
  const [amountIn, setAmountIn] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);
  const [quote, setQuote] = useState<ZeroXCrossChainQuote | null>(null);
  const [lifecycle, setLifecycle] = useState<Lifecycle | null>(null);
  const [balance, setBalance] = useState<bigint | null>(null);

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
    return () => {
      cancelled = true;
    };
  }, []);

  const source = useMemo(
    () => status?.sourceChains?.find((c) => c.chainId === sourceChainId) ?? null,
    [status, sourceChainId]
  );
  const nativeSymbol = sourceChainId != null ? NATIVE_SYMBOL[sourceChainId] ?? "ETH" : "ETH";

  // Balance for the "You pay" field's MAX button — re-fetches whenever the
  // connected account or the selected source chain changes. A direct RPC
  // read (see fetchSourceChainBalance above), not the wallet's own balance,
  // so it stays correct regardless of which chain the wallet is currently on.
  useEffect(() => {
    if (!account || sourceChainId == null) {
      setBalance(null);
      return;
    }
    let cancelled = false;
    setBalance(null);
    void fetchSourceChainBalance(sourceChainId, account).then((b) => {
      if (!cancelled) setBalance(b);
    });
    return () => {
      cancelled = true;
    };
  }, [account, sourceChainId]);

  const handleMax = useCallback(() => {
    if (balance === null || sourceChainId == null) return;
    const reserve = GAS_RESERVE_WEI[sourceChainId] ?? BigInt("1000000000000000");
    const spendable = balance > reserve ? balance - reserve : BigInt(0);
    setAmountIn(formatTokenAmount(spendable, 18, 18));
    setQuote(null);
    setTxHash(null);
  }, [balance, sourceChainId]);

  const handleConnect = useCallback(async () => {
    setError(null);
    try {
      setBusy(true);
      await walletConnect();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to connect wallet.");
    } finally {
      setBusy(false);
    }
  }, [walletConnect]);

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

  // Rate: "1 native = X PLANK". Both sides are 18-decimal, so decimals
  // cancel — no scaling factors needed the way SwapWidget's cross-token rate
  // needs. Full BigInt precision, only the final string goes through
  // formatDisplayAmount.
  const rate = useMemo(() => {
    if (!quote?.buyAmount) return null;
    const inRaw = parseTokenAmount(amountIn, 18);
    if (!inRaw || inRaw <= BigInt(0)) return null;
    let outRaw: bigint;
    try {
      outRaw = BigInt(quote.buyAmount);
    } catch {
      return null;
    }
    if (outRaw <= BigInt(0)) return null;
    const PRECISION_DIGITS = 24;
    const precision = BigInt(10) ** BigInt(PRECISION_DIGITS);
    return formatDisplayAmount((outRaw * precision) / inRaw, PRECISION_DIGITS);
  }, [quote, amountIn]);

  const btnBase =
    "min-h-11 w-full rounded-lg px-3 py-2.5 text-sm font-bold transition-colors disabled:cursor-not-allowed disabled:opacity-50 sm:text-base";

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
    <div className="flex flex-col gap-2.5">
      <ChainSelectModal
        open={chainModalOpen}
        onClose={() => setChainModalOpen(false)}
        chains={status.sourceChains ?? []}
        selected={source}
        onSelect={(c) => {
          setSourceChainId(c.chainId);
          setQuote(null);
          setTxHash(null);
        }}
      />

      <div className="flex items-center gap-1.5 text-[0.65rem] font-bold uppercase tracking-wide text-foreground/50">
        <Zap size={13} className="shrink-0 text-gold-400" />
        Buy $PLANK from another chain — one step (0x)
      </div>

      {!account ? (
        <button
          type="button"
          onClick={handleConnect}
          disabled={busy}
          className={`${btnBase} bg-gold-500 text-wood-950 hover:bg-gold-400`}
        >
          {busy ? "Connecting…" : "Connect wallet"}
        </button>
      ) : (
        <>
          <div className="flex min-h-9 items-center gap-2 rounded-lg border border-forest-600/45 bg-forest-900/45 px-2.5 text-xs">
            <span aria-hidden="true" className="h-2 w-2 shrink-0 rounded-full bg-emerald-400" />
            <span className="font-bold uppercase tracking-wide text-[0.62rem] text-foreground/50">
              Connected wallet
            </span>
            <span className="ml-auto font-mono text-gold-300" title={account}>
              {shortAddress(account)}
            </span>
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
                  setTxHash(null);
                }}
                className="min-w-0 flex-1 bg-transparent py-2.5 text-lg font-semibold text-foreground outline-none placeholder:text-foreground/30 sm:text-xl"
                aria-label={`Amount of native token to pay, on ${source?.name ?? "the selected chain"}`}
              />
              <button
                type="button"
                onClick={() => setChainModalOpen(true)}
                aria-label="Change source chain"
                className="flex shrink-0 items-center gap-1.5 rounded-full bg-gold-500/15 py-1.5 pl-1.5 pr-2.5 text-xs font-bold text-gold-300 transition-colors hover:bg-gold-500/25 sm:text-sm"
              >
                <TokenIcon symbol={source?.name ?? "?"} size={18} />
                {source?.name ?? "Select chain"}
                <ChevronDown size={14} />
              </button>
            </div>
            {source && (
              <div className="mt-1 flex items-center justify-between gap-2 text-[0.65rem] text-foreground/45">
                <span>Native {nativeSymbol} on {source.name}</span>
                <span className="flex shrink-0 items-center gap-1.5">
                  {balance !== null && (
                    <span>
                      Balance: {formatDisplayAmount(balance, 18)} {nativeSymbol}
                    </span>
                  )}
                  <button
                    type="button"
                    onClick={handleMax}
                    disabled={balance === null}
                    className="font-bold text-gold-300 hover:text-gold-200 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    MAX
                  </button>
                </span>
              </div>
            )}
          </label>

          <div className="flex justify-center">
            <span className="flex h-9 w-9 items-center justify-center rounded-full border border-gold-500/40 bg-wood-900 text-gold-300">
              ↓
            </span>
          </div>

          <div>
            <span className="text-[0.65rem] font-bold uppercase tracking-wider text-foreground/50">
              You receive
            </span>
            <div className="mt-1 flex min-h-12 items-center gap-2 rounded-lg border border-gold-500/20 bg-wood-900/90 px-2.5">
              <span className="min-w-0 flex-1 py-2.5 text-lg font-semibold text-foreground/90 sm:text-xl">
                {quote ? `~${formatDisplayAmount(quote.buyAmount, TOKEN.decimals)}` : "—"}
              </span>
              <span className="flex shrink-0 items-center gap-1.5 rounded-md bg-forest-800/60 px-2 py-1 text-xs font-bold text-gold-300 sm:text-sm">
                <TokenIcon symbol={TOKEN.symbol} size={18} />
                {TOKEN.symbol}
              </span>
            </div>
          </div>

          {!quote ? (
            <button
              type="button"
              onClick={handleGetQuote}
              disabled={busy || !amountIn || !source}
              className={`${btnBase} border border-gold-500/55 bg-wood-900 text-gold-300 hover:border-gold-400`}
            >
              {busy ? <Loader2 size={16} className="mx-auto animate-spin" /> : "Get 0x quote"}
            </button>
          ) : (
            <>
              <div className="flex flex-col gap-1.5 rounded-lg border border-gold-500/15 bg-wood-950/60 px-2.5 py-2 text-[0.7rem] text-foreground/70">
                {rate && (
                  <div className="font-semibold text-foreground/80">
                    1 {nativeSymbol} = {rate} {TOKEN.symbol}
                  </div>
                )}
                {typeof quote.estimatedTimeSeconds === "number" && (
                  <div>Est. settlement: ~{Math.max(1, Math.round(quote.estimatedTimeSeconds))}s</div>
                )}
                {quote.minBuyAmount && (
                  <div>
                    Minimum received (worst case): {formatDisplayAmount(quote.minBuyAmount, TOKEN.decimals)}{" "}
                    {TOKEN.symbol}
                  </div>
                )}
                {/* Provider alone ("0x") isn't useful on its own — the user
                    already knows they're using 0x, it's labeled above this
                    block. Only render this row, labeled, when there's an
                    actual route to show; never a bare unlabeled token. */}
                {quote.route && (
                  <div className="truncate font-mono text-foreground/60">
                    Route: {[quote.provider, quote.route].filter(Boolean).join(" · ")}
                  </div>
                )}
              </div>

              {/* Same border/radius/padding language as CrossChainDisclaimer
                  above this panel, and the risk callout right below — one
                  visual "risk & fees" family, not three unrelated cards. */}
              <details className="group rounded-lg border border-gold-500/20 bg-wood-950/40 px-3 py-2 text-[0.7rem] text-foreground/70">
                <summary className="flex cursor-pointer list-none items-center justify-between gap-2 font-bold uppercase tracking-wide text-gold-300">
                  <span className="flex items-center gap-1.5">
                    <Percent size={13} className="shrink-0 text-gold-400" />
                    Fees
                  </span>
                  <ChevronRight size={14} className="shrink-0 text-foreground/50 transition-transform group-open:rotate-90" />
                </summary>
                <div className="mt-2 space-y-1.5">
                  {status.siteFee?.enabled && (
                    <p>plank.love fee: {status.siteFee.exactLabel || status.siteFee.label}</p>
                  )}
                  {quote.zeroExFeeDisclosure && <p>{quote.zeroExFeeDisclosure}</p>}
                  {status.disclosure && <p className="text-foreground/50">{status.disclosure}</p>}
                </div>
              </details>

              {!txHash && (
                <div className="flex items-start gap-1.5 rounded-lg border border-red-500/30 bg-red-950/20 px-3 py-2 text-[0.68rem] leading-snug text-red-100/90">
                  <ShieldAlert size={13} className="mt-0.5 shrink-0" />
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
                className={`${btnBase} bg-gold-500 text-wood-950 shadow-[0_6px_16px_-4px_rgba(217,164,65,0.45)] hover:bg-gold-400`}
              >
                {busy ? "Confirm in wallet…" : `Send on ${source?.name}`}
              </button>
            </>
          )}

          {txHash && (
            <div className="flex flex-col gap-1 rounded-lg border border-gold-500/20 bg-wood-950/40 px-2.5 py-2 text-xs">
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

      {error && (
        <p className="text-xs text-red-300" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
