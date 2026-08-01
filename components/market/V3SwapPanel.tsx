"use client";

/**
 * V3 Instant Swap trade widget. Five actions in one segmented control. The
 * active action + redeem mode + the plank cart are OWNED by V3SwapView (so the
 * big artwork grid and this widget share one selection): Deposit and targeted
 * Redeem read the cart the user builds by tapping the grid; Buy/Sell/Liquidity
 * stay amount-based here. Data (snapshot, ETH balance, account) is passed in.
 */

import { useMemo, useRef, useState } from "react";
import { parseEther } from "ethers";
import {
  quoteBuy,
  quoteSell,
  quoteAddLiquidity,
  quoteRemoveLiquidity,
  v3Buy,
  v3Sell,
  v3DepositMany,
  v3RedeemTargetMany,
  v3RandomRedeem,
  v3AddLiquidity,
  v3RemoveLiquidity,
  decodeV3Error,
  formatUnits,
  SHARE_UNIT,
  type V3Snapshot,
} from "@/lib/market/vault-v3";

export type Action = "buy" | "sell" | "deposit" | "redeem" | "lp";
const ACTIONS: { id: Action; label: string }[] = [
  { id: "buy", label: "Buy" },
  { id: "sell", label: "Sell" },
  { id: "deposit", label: "Deposit" },
  { id: "redeem", label: "Redeem" },
  { id: "lp", label: "Liquidity" },
];

function toWei(s: string): bigint {
  const t = s.trim();
  if (!t || !/^\d*\.?\d*$/.test(t)) return BigInt(0);
  try {
    return parseEther(t);
  } catch {
    return BigInt(0);
  }
}

export type V3PanelProps = {
  snap: V3Snapshot | null;
  ethBal: bigint | null;
  address: string | null;
  isConnected: boolean;
  vaultAddress?: string | null;
  /** Controlled by V3SwapView — shared with the artwork grid. */
  action: Action;
  onActionChange: (a: Action) => void;
  redeemMode: "random" | "specific";
  onRedeemModeChange: (m: "random" | "specific") => void;
  /** Planks the user tapped in the grid (deposit source / targeted-redeem set). */
  cart: Set<string>;
  /** True when another wallet holds the single redeem slot — random redeem would revert. */
  redeemSlotBusy?: boolean;
  onConnect: () => void;
  onAfterTx: () => Promise<void> | void;
};

export default function V3SwapPanel({
  snap,
  ethBal,
  address,
  isConnected,
  vaultAddress,
  action,
  onActionChange,
  redeemMode,
  onRedeemModeChange,
  cart,
  redeemSlotBusy,
  onConnect,
  onAfterTx,
}: V3PanelProps) {
  const [amount, setAmount] = useState("");
  const [lpMode, setLpMode] = useState<"add" | "remove">("add");
  const [slipBps, setSlipBps] = useState(100); // 1.00% default
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const running = useRef(false);

  const run = async (fn: () => Promise<unknown>) => {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setError(null);
    setStatus("Confirm in your wallet…");
    try {
      await fn();
      setAmount("");
      await onAfterTx();
    } catch (e) {
      setError(decodeV3Error(e));
    } finally {
      setBusy(false);
      setStatus(null);
      running.current = false;
    }
  };

  const amtWei = toWei(amount);
  const cartIds = useMemo(() => [...cart], [cart]);

  const quote = useMemo(() => {
    if (!snap) return null;
    if (action === "buy") return { out: quoteBuy(amtWei, snap), unit: "shares" };
    if (action === "sell") return { out: quoteSell(amtWei, snap), unit: "ETH" };
    if (action === "lp" && lpMode === "add") {
      const { sharesUsed, lpMinted } = quoteAddLiquidity(amtWei, snap);
      return { out: lpMinted, unit: "LP", sharesUsed };
    }
    if (action === "lp" && lpMode === "remove") {
      const { ethOut, sharesOut } = quoteRemoveLiquidity(amtWei, snap);
      return { out: ethOut, unit: "ETH", sharesOut };
    }
    return null;
  }, [snap, action, amtWei, lpMode]);

  // Per-plank + total cost of the cart for the picked actions.
  const feeEach = snap
    ? action === "deposit"
      ? snap.mintFeeWei
      : snap.redeemFeeWei + snap.targetPremiumWei
    : BigInt(0);
  const cartTotal = feeEach * BigInt(cart.size);

  const submit = () => {
    if (!snap || !address) return;
    if (action === "buy") return run(() => v3Buy(address, amtWei, snap, slipBps));
    if (action === "sell") return run(() => v3Sell(address, amtWei, snap, slipBps));
    if (action === "deposit") return run(() => v3DepositMany(address, cartIds, snap, vaultAddress));
    if (action === "redeem") {
      if (redeemMode === "random") return run(() => v3RandomRedeem(address, snap, vaultAddress, setStatus));
      return run(() => v3RedeemTargetMany(address, cartIds, snap, vaultAddress));
    }
    if (action === "lp" && lpMode === "add") return run(() => v3AddLiquidity(address, amtWei, snap, slipBps));
    if (action === "lp" && lpMode === "remove") return run(() => v3RemoveLiquidity(address, amtWei, snap, slipBps));
  };

  const isAmmTab = action === "buy" || action === "sell" || action === "lp";
  const usesCart = action === "deposit" || (action === "redeem" && redeemMode === "specific");
  const tradingPaused = Boolean(snap && !snap.poolOpen && isAmmTab);
  const minReceived = useMemo(() => {
    if (!quote || quote.out <= BigInt(0)) return BigInt(0);
    return (quote.out * BigInt(10000 - slipBps)) / BigInt(10000);
  }, [quote, slipBps]);
  const priceImpactPct = useMemo(() => {
    if (!snap || amtWei <= BigInt(0) || snap.ethReserve === BigInt(0) || snap.shareReserve === BigInt(0)) return null;
    if (action === "buy") {
      const mid = Number(snap.shareReserve) / Number(snap.ethReserve);
      const eff = Number(quoteBuy(amtWei, snap)) / Number(amtWei);
      return mid > 0 ? Math.max(0, (1 - eff / mid) * 100) : null;
    }
    if (action === "sell") {
      const mid = Number(snap.ethReserve) / Number(snap.shareReserve);
      const eff = Number(quoteSell(amtWei, snap)) / Number(amtWei);
      return mid > 0 ? Math.max(0, (1 - eff / mid) * 100) : null;
    }
    return null;
  }, [snap, action, amtWei]);
  const randomSlotBlocked = action === "redeem" && redeemMode === "random" && Boolean(redeemSlotBusy);
  const ctaDisabled = busy || tradingPaused || randomSlotBlocked || (usesCart && cart.size === 0) || (isAmmTab && amtWei <= BigInt(0));
  const payLabel = action === "sell" ? "You sell (shares)" : action === "lp" && lpMode === "remove" ? "Burn LP" : "You pay";
  const payToken = action === "sell" ? "shares" : action === "lp" && lpMode === "remove" ? "LP" : "◆ ETH";
  const payBal = !snap
    ? ""
    : action === "sell"
      ? `${formatUnits(snap.shareBalance, 2)} sh`
      : action === "lp" && lpMode === "remove"
        ? `${formatUnits(snap.lpBalance, 2)} LP`
        : `${ethBal !== null ? formatUnits(ethBal, 3) : "…"} Ξ`;
  const maxAmount = useMemo(() => {
    if (!snap) return null;
    if (action === "sell") return snap.shareBalance > BigInt(0) ? formatUnits(snap.shareBalance, 18) : null;
    if (action === "lp" && lpMode === "remove") return snap.lpBalance > BigInt(0) ? formatUnits(snap.lpBalance, 18) : null;
    if ((action === "buy" || (action === "lp" && lpMode === "add")) && ethBal !== null) {
      const buf = parseEther("0.001");
      const usable = ethBal > buf ? ethBal - buf : BigInt(0);
      return usable > BigInt(0) ? formatUnits(usable, 18) : null;
    }
    return null;
  }, [snap, action, lpMode, ethBal]);

  return (
    <div className="rounded-2xl border border-line bg-panel-strong p-3.5">
      <div className="grid grid-cols-3 gap-1 rounded-xl border border-line bg-wood-950 p-1 sm:grid-cols-5">
        {ACTIONS.map((a) => (
          <button
            key={a.id}
            type="button"
            onClick={() => { onActionChange(a.id); setAmount(""); setError(null); }}
            aria-pressed={action === a.id}
            className={`min-h-11 rounded-lg py-2 text-[0.72rem] font-black tracking-wide transition ${
              action === a.id ? "bg-gold-500 text-[#261105]" : "text-cream-muted hover:text-cream"
            }`}
          >
            {a.label}
          </button>
        ))}
      </div>

      {action === "lp" && (
        <div className="mt-3 flex gap-2">
          {(["add", "remove"] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => { setLpMode(m); setAmount(""); }}
              aria-pressed={lpMode === m}
              className={`min-h-11 flex-1 rounded-lg border py-1.5 text-[0.7rem] font-bold capitalize ${
                lpMode === m ? "border-emerald-400/60 bg-emerald-500/10 text-emerald-300" : "border-line text-cream-muted"
              }`}
            >
              {m} liquidity
            </button>
          ))}
        </div>
      )}

      <p className="mt-3 rounded-lg border border-sky-500/30 bg-sky-500/10 px-3 py-2 text-[0.72rem] text-sky-200">
        {action === "buy" && <><b className="text-sky-100">Buy shares</b> — pay ETH, receive fungible V3 shares. To get a plank, use Redeem.</>}
        {action === "sell" && <><b className="text-sky-100">Sell shares</b> — return shares to the pool for ETH.</>}
        {action === "deposit" && <><b className="text-sky-100">Deposit</b> — tap your planks in the grid; each mints one V3 share for a flat {snap ? formatUnits(snap.mintFeeWei) : "…"} Ξ fee.</>}
        {action === "redeem" && redeemMode === "random" && <><b className="text-sky-100">Random redeem</b> — burn one share + {snap ? formatUnits(snap.redeemFeeWei) : "…"} Ξ for a plank drawn fairly via drand. Cheapest way out.</>}
        {action === "redeem" && redeemMode === "specific" && <><b className="text-sky-100">Targeted redeem</b> — tap the exact planks in the grid. Each burns one share + {snap ? formatUnits(snap.redeemFeeWei + snap.targetPremiumWei) : "…"} Ξ.</>}
        {action === "lp" && lpMode === "add" && <><b className="text-sky-100">Add liquidity</b> — supply ETH; shares are pulled to match the ratio. Earn the 0.30% swap fee.</>}
        {action === "lp" && lpMode === "remove" && <><b className="text-sky-100">Remove liquidity</b> — burn LP for a pro-rata slice of the pool.</>}
      </p>

      {tradingPaused && (
        <p className="mt-3 rounded-lg border border-amber-400/40 bg-amber-500/10 px-3 py-2 text-[0.72rem] text-amber-200" role="status">
          <b className="text-amber-100">Trading is paused</b> — the pool isn’t open. Deposit and Redeem still work.
        </p>
      )}

      {action === "redeem" && (
        <div className="mt-3 grid grid-cols-2 gap-1 rounded-xl border border-line bg-wood-950 p-1">
          {(["random", "specific"] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => onRedeemModeChange(m)}
              aria-pressed={redeemMode === m}
              className={`min-h-11 rounded-lg text-[0.72rem] font-black tracking-wide transition ${
                redeemMode === m ? "bg-gold-500 text-[#261105]" : "text-cream-muted hover:text-cream"
              }`}
            >
              {m === "random" ? `Random · ${snap ? formatUnits(snap.redeemFeeWei, 3) : "…"} Ξ` : `Specific · ${snap ? formatUnits(snap.redeemFeeWei + snap.targetPremiumWei, 3) : "…"} Ξ`}
            </button>
          ))}
        </div>
      )}

      {/* CART summary (deposit / targeted redeem) — planks come from the grid */}
      {usesCart ? (
        <div className="mt-3 rounded-xl border border-line bg-wood-950 p-3">
          {cart.size === 0 ? (
            <p className="text-[0.72rem] text-cream-muted">
              Tap planks in the {action === "deposit" ? "grid of your planks" : "vault grid"} — your selection shows here.
            </p>
          ) : (
            <div className="space-y-1 text-[0.72rem] text-cream-muted">
              <div className="flex justify-between"><span>Selected</span><b className="tabular-nums text-cream">{cart.size} plank{cart.size === 1 ? "" : "s"}</b></div>
              <div className="flex justify-between"><span>Fee each</span><b className="tabular-nums text-cream">{formatUnits(feeEach, 4)} Ξ</b></div>
              <div className="flex justify-between"><span>Total</span><b className="tabular-nums text-gold-300">{formatUnits(cartTotal, 4)} Ξ</b></div>
            </div>
          )}
        </div>
      ) : action === "redeem" ? (
        randomSlotBlocked ? (
          <p className="mt-3 rounded-lg border border-amber-400/40 bg-amber-500/10 px-3 py-2.5 text-[0.72rem] text-amber-200">
            The vault’s single redeem slot is busy — another wallet is mid-redeem. It’ll clear shortly (see the banner above); requesting now would just revert.
          </p>
        ) : (
          <p className="mt-3 rounded-lg border border-line bg-wood-950 px-3 py-2.5 text-[0.72rem] text-cream-muted">
            You’ll sign one request; the plank is drawn by drand and delivered automatically. The vault holds{" "}
            <b className="text-gold-300">{snap?.availableCount ?? snap?.held ?? 0}</b> available planks — each equally likely.
          </p>
        )
      ) : (
        <>
          <label className="mt-3 block rounded-xl border border-line bg-wood-950 px-3.5 py-3">
            <span className="flex justify-between text-[0.66rem] font-bold text-cream-muted">
              <span>{payLabel}</span>
              {snap && (
                <span>
                  bal {payBal}
                  {maxAmount && (
                    <button type="button" onClick={() => setAmount(maxAmount)} className="ml-1.5 rounded bg-gold-500/15 px-1.5 py-0.5 text-[0.6rem] font-black text-gold-300 hover:bg-gold-500/25">
                      MAX
                    </button>
                  )}
                </span>
              )}
            </span>
            <span className="mt-1 flex items-center justify-between">
              <input
                value={amount}
                onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))}
                placeholder="0.0"
                inputMode="decimal"
                className="w-full bg-transparent text-2xl font-black text-cream outline-none placeholder:text-cream/30"
              />
              <span className="ml-2 shrink-0 rounded-full border border-line-strong bg-wood-900 px-3 py-1 text-sm font-black text-gold-300">
                {payToken}
              </span>
            </span>
          </label>

          {quote && amtWei > BigInt(0) && (
            <div className="mt-3 rounded-xl border border-line bg-wood-950 px-3.5 py-3">
              <span className="text-[0.66rem] font-bold text-cream-muted">You receive ≈</span>
              <div className="mt-0.5 font-mono text-2xl font-black tabular-nums text-cream">
                {formatUnits(quote.out, 4)} <span className="text-base text-gold-300">{quote.unit}</span>
              </div>
              {"sharesUsed" in quote && quote.sharesUsed !== undefined && (
                <p className="mt-1 text-[0.66rem] text-cream-muted">+ {formatUnits(quote.sharesUsed, 4)} shares pulled to match</p>
              )}
              {"sharesOut" in quote && quote.sharesOut !== undefined && (
                <p className="mt-1 text-[0.66rem] text-cream-muted">+ {formatUnits(quote.sharesOut, 4)} shares returned</p>
              )}
            </div>
          )}
        </>
      )}

      {/* Slippage control — the enforced floor is recomputed at submit. */}
      {isAmmTab && (
        <div className="mt-3 flex items-center justify-between gap-2">
          <span className="text-[0.66rem] font-bold uppercase tracking-wide text-cream-muted">Max slippage</span>
          <div className="flex gap-1" role="group" aria-label="Max slippage">
            {[50, 100, 200].map((bp) => (
              <button
                key={bp}
                type="button"
                onClick={() => setSlipBps(bp)}
                aria-pressed={slipBps === bp}
                className={`min-h-9 rounded-lg px-2.5 text-[0.66rem] font-black tabular-nums transition ${
                  slipBps === bp ? "bg-gold-500 text-[#261105]" : "border border-line text-cream-muted hover:text-cream"
                }`}
              >
                {(bp / 100).toFixed(bp % 100 ? 1 : 0)}%
              </button>
            ))}
          </div>
        </div>
      )}

      {snap && (
        <div className="mt-3 space-y-1 text-[0.72rem] text-cream-muted">
          {(action === "buy" || action === "sell") && (
            <div className="flex justify-between"><span>Swap fee</span><b className="tabular-nums text-emerald-400">{(snap.swapFeeBps / 100).toFixed(2)}% → LPs</b></div>
          )}
          {(action === "buy" || action === "sell") && priceImpactPct !== null && (
            <div className="flex justify-between">
              <span>Price impact</span>
              <b className={`tabular-nums ${priceImpactPct >= 3 ? "text-amber-400" : "text-cream"}`}>{priceImpactPct < 0.01 ? "<0.01" : priceImpactPct.toFixed(2)}%</b>
            </div>
          )}
          {isAmmTab && quote && amtWei > BigInt(0) && (
            <div className="flex justify-between">
              <span>Minimum received ({(slipBps / 100).toFixed(slipBps % 100 ? 1 : 0)}% slip.)</span>
              <b className="tabular-nums text-cream">{formatUnits(minReceived, 4)} {quote.unit}</b>
            </div>
          )}
          <div className="flex justify-between"><span>Share price</span><b className="tabular-nums text-cream">{formatUnits(snap.shareReserve > BigInt(0) ? (snap.ethReserve * SHARE_UNIT) / snap.shareReserve : BigInt(0), 6)} Ξ</b></div>
        </div>
      )}

      {status && <p className="mt-3 rounded-lg border border-gold-500/40 bg-gold-500/10 px-3 py-2 text-[0.75rem] text-cream"><span className="mr-2 inline-block h-2 w-2 animate-pulse rounded-full bg-gold-400 align-middle" />{status}</p>}
      {error && <p className="mt-3 break-words rounded-lg border border-rose-400/40 bg-rose-500/10 px-3 py-2 text-[0.72rem] text-rose-200">{error}</p>}

      {isConnected ? (
        <button type="button" disabled={ctaDisabled} onClick={submit} className="mt-3 min-h-[48px] w-full rounded-xl bg-gold-500 text-[0.92rem] font-black text-[#261105] disabled:opacity-50">
          {tradingPaused
            ? "Trading paused"
            : randomSlotBlocked
            ? "Redeem slot busy"
            : action === "buy"
            ? "Buy shares"
            : action === "sell"
              ? "Sell shares"
              : action === "deposit"
                ? cart.size ? `Deposit ${cart.size} plank${cart.size === 1 ? "" : "s"} · ${formatUnits(cartTotal, 4)} Ξ` : "Select planks to deposit"
                : action === "redeem"
                  ? redeemMode === "random" ? "Redeem a random plank" : cart.size ? `Redeem ${cart.size} plank${cart.size === 1 ? "" : "s"} · ${formatUnits(cartTotal, 4)} Ξ` : "Select planks to redeem"
                  : lpMode === "add" ? "Add liquidity" : "Remove liquidity"}
        </button>
      ) : (
        <button type="button" onClick={onConnect} className="mt-3 min-h-[48px] w-full rounded-xl bg-gold-500 text-[0.92rem] font-black text-[#261105]">
          Connect wallet
        </button>
      )}
    </div>
  );
}
