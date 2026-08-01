"use client";

/**
 * V3 Instant Swap — the trade card from docs/mockups/swap-redesign. Five actions
 * in one segmented control, wired to lib/market/vault-v3.ts. Data (snapshot, ETH
 * balance, account) is owned by V3SwapView and passed in, so the whole page polls
 * once and stays consistent.
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
  v3Deposit,
  v3RedeemTarget,
  v3RandomRedeem,
  v3AddLiquidity,
  v3RemoveLiquidity,
  formatUnits,
  SHARE_UNIT,
  type V3Snapshot,
} from "@/lib/market/vault-v3";
import TokenPicker, { type PickerToken } from "@/components/market/TokenPicker";

type Action = "buy" | "sell" | "deposit" | "redeem" | "lp";
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
  /** Planks in the connected wallet (for Deposit) and in the vault (for Redeem). */
  ownedTokens: PickerToken[];
  heldTokens: PickerToken[];
  invLoading?: boolean;
  onConnect: () => void;
  onAfterTx: () => Promise<void> | void;
};

export default function V3SwapPanel({
  snap,
  ethBal,
  address,
  isConnected,
  vaultAddress,
  ownedTokens,
  heldTokens,
  invLoading,
  onConnect,
  onAfterTx,
}: V3PanelProps) {
  const [tab, setTab] = useState<Action>("buy");
  const [amount, setAmount] = useState("");
  const [tokenId, setTokenId] = useState("");
  const [redeemMode, setRedeemMode] = useState<"random" | "specific">("random");
  const [lpMode, setLpMode] = useState<"add" | "remove">("add");
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
      setTokenId("");
      await onAfterTx();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      setStatus(null);
      running.current = false;
    }
  };

  const amtWei = toWei(amount);

  const quote = useMemo(() => {
    if (!snap) return null;
    if (tab === "buy") return { out: quoteBuy(amtWei, snap), unit: "shares" };
    if (tab === "sell") return { out: quoteSell(amtWei, snap), unit: "ETH" };
    if (tab === "lp" && lpMode === "add") {
      const { sharesUsed, lpMinted } = quoteAddLiquidity(amtWei, snap);
      return { out: lpMinted, unit: "LP", sharesUsed };
    }
    if (tab === "lp" && lpMode === "remove") {
      const { ethOut, sharesOut } = quoteRemoveLiquidity(amtWei, snap);
      return { out: ethOut, unit: "ETH", sharesOut };
    }
    return null;
  }, [snap, tab, amtWei, lpMode]);

  const submit = () => {
    if (!snap || !address) return;
    if (tab === "buy") return run(() => v3Buy(address, amtWei, snap));
    if (tab === "sell") return run(() => v3Sell(address, amtWei, snap));
    if (tab === "deposit") return run(() => v3Deposit(address, tokenId.trim(), snap, vaultAddress));
    if (tab === "redeem") {
      if (redeemMode === "random") return run(() => v3RandomRedeem(address, snap, vaultAddress, setStatus));
      return run(() => v3RedeemTarget(address, tokenId.trim(), snap));
    }
    if (tab === "lp" && lpMode === "add") return run(() => v3AddLiquidity(address, amtWei, snap));
    if (tab === "lp" && lpMode === "remove") return run(() => v3RemoveLiquidity(address, amtWei, snap));
  };

  // Actions that need a picked plank rather than an ETH/share amount.
  const isNftTab = tab === "deposit" || tab === "redeem";
  const redeemFeeWei = snap ? (redeemMode === "random" ? snap.redeemFeeWei : snap.redeemFeeWei + snap.targetPremiumWei) : BigInt(0);
  // Disable the CTA when the required plank hasn't been chosen.
  const needsPick = (tab === "deposit") || (tab === "redeem" && redeemMode === "specific");
  const ctaDisabled = busy || (needsPick && !tokenId);
  const payLabel =
    tab === "sell" ? "You sell (shares)" : tab === "lp" && lpMode === "remove" ? "Burn LP" : "You pay";
  const payToken = tab === "sell" ? "shares" : tab === "lp" && lpMode === "remove" ? "LP" : "◆ ETH";
  const payBal = !snap
    ? ""
    : tab === "sell"
      ? `${formatUnits(snap.shareBalance, 2)} sh`
      : tab === "lp" && lpMode === "remove"
        ? `${formatUnits(snap.lpBalance, 2)} LP`
        : `${ethBal !== null ? formatUnits(ethBal, 3) : "…"} Ξ`;

  return (
    <div className="rounded-2xl border border-line bg-panel-strong p-3.5">
      <div className="grid grid-cols-5 gap-1 rounded-xl border border-line bg-wood-950 p-1">
        {ACTIONS.map((a) => (
          <button
            key={a.id}
            type="button"
            onClick={() => { setTab(a.id); setAmount(""); setTokenId(""); setError(null); }}
            className={`rounded-lg py-2 text-[0.72rem] font-black tracking-wide transition ${
              tab === a.id ? "bg-gold-500 text-[#261105]" : "text-cream-muted hover:text-cream"
            }`}
          >
            {a.label}
          </button>
        ))}
      </div>

      {tab === "lp" && (
        <div className="mt-3 flex gap-2">
          {(["add", "remove"] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => { setLpMode(m); setAmount(""); }}
              className={`flex-1 rounded-lg border py-1.5 text-[0.7rem] font-bold capitalize ${
                lpMode === m ? "border-emerald-400/60 bg-emerald-500/10 text-emerald-300" : "border-line text-cream-muted"
              }`}
            >
              {m} liquidity
            </button>
          ))}
        </div>
      )}

      <p className="mt-3 rounded-lg border border-sky-500/30 bg-sky-500/10 px-3 py-2 text-[0.72rem] text-sky-200">
        {tab === "buy" && <><b className="text-sky-100">Buy shares</b> — pay ETH, receive fungible V3 shares. To get a plank, use Redeem.</>}
        {tab === "sell" && <><b className="text-sky-100">Sell shares</b> — return shares to the pool for ETH.</>}
        {tab === "deposit" && <><b className="text-sky-100">Deposit</b> a plank you own → exactly one V3 share, for a flat {snap ? formatUnits(snap.mintFeeWei) : "…"} Ξ fee.</>}
        {tab === "redeem" && redeemMode === "random" && <><b className="text-sky-100">Random redeem</b> — burn one share + {snap ? formatUnits(snap.redeemFeeWei) : "…"} Ξ for a plank drawn fairly via drand. Cheapest way out.</>}
        {tab === "redeem" && redeemMode === "specific" && <><b className="text-sky-100">Targeted redeem</b> — pick the exact plank. Burns one share + {snap ? formatUnits(snap.redeemFeeWei + snap.targetPremiumWei) : "…"} Ξ (a {snap ? formatUnits(snap.targetPremiumWei) : "…"} Ξ premium over random).</>}
        {tab === "lp" && lpMode === "add" && <><b className="text-sky-100">Add liquidity</b> — supply ETH; shares are pulled to match the ratio. Earn the 0.30% swap fee.</>}
        {tab === "lp" && lpMode === "remove" && <><b className="text-sky-100">Remove liquidity</b> — burn LP for a pro-rata slice of the pool.</>}
      </p>

      {tab === "deposit" ? (
        <div className="mt-3 space-y-2">
          <p className="text-[0.62rem] font-bold uppercase tracking-wide text-cream-muted">Choose a plank to deposit</p>
          <TokenPicker
            tokens={ownedTokens}
            loading={invLoading}
            selected={tokenId || null}
            onSelect={setTokenId}
            emptyMessage={address ? "No eligible planks in this wallet." : "Connect a wallet to see your planks."}
          />
        </div>
      ) : tab === "redeem" ? (
        <div className="mt-3 space-y-2">
          <div className="grid grid-cols-2 gap-1 rounded-xl border border-line bg-wood-950 p-1">
            {(["random", "specific"] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => { setRedeemMode(m); setTokenId(""); setError(null); }}
                className={`min-h-9 rounded-lg text-[0.72rem] font-black tracking-wide transition ${
                  redeemMode === m ? "bg-gold-500 text-[#261105]" : "text-cream-muted hover:text-cream"
                }`}
              >
                {m === "random" ? `Random · ${snap ? formatUnits(snap.redeemFeeWei, 3) : "…"} Ξ` : `Specific · ${snap ? formatUnits(snap.redeemFeeWei + snap.targetPremiumWei, 3) : "…"} Ξ`}
              </button>
            ))}
          </div>
          {redeemMode === "specific" && (
            <>
              <p className="text-[0.62rem] font-bold uppercase tracking-wide text-cream-muted">Pick the plank to redeem</p>
              <TokenPicker
                tokens={heldTokens}
                loading={invLoading}
                selected={tokenId || null}
                onSelect={setTokenId}
                emptyMessage="The vault isn't holding any planks right now."
              />
            </>
          )}
          {redeemMode === "random" && (
            <p className="rounded-lg border border-line bg-wood-950 px-3 py-2.5 text-[0.72rem] text-cream-muted">
              You’ll sign one request; the plank is drawn by drand and delivered automatically. The vault holds{" "}
              <b className="text-gold-300">{snap?.held ?? 0}</b> planks — each equally likely.
            </p>
          )}
        </div>
      ) : (
        <>
          <label className="mt-3 block rounded-xl border border-line bg-wood-950 px-3.5 py-3">
            <span className="flex justify-between text-[0.66rem] font-bold text-cream-muted">
              <span>{payLabel}</span>
              {snap && <span>bal {payBal}</span>}
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
              <div className="mt-0.5 text-2xl font-black text-cream">
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

      {snap && (
        <div className="mt-3 space-y-1 text-[0.72rem] text-cream-muted">
          {(tab === "buy" || tab === "sell") && (
            <div className="flex justify-between"><span>Swap fee</span><b className="text-emerald-400">{(snap.swapFeeBps / 100).toFixed(2)}% → LPs</b></div>
          )}
          {tab === "deposit" && (
            <div className="flex justify-between"><span>Deposit fee</span><b className="text-cream">{formatUnits(snap.mintFeeWei, 4)} Ξ → treasury</b></div>
          )}
          {tab === "redeem" && (
            <div className="flex justify-between"><span>Redeem fee</span><b className="text-cream">{formatUnits(redeemFeeWei, 4)} Ξ → treasury</b></div>
          )}
          <div className="flex justify-between"><span>Share price</span><b className="text-cream">{formatUnits(snap.shareReserve > BigInt(0) ? (snap.ethReserve * SHARE_UNIT) / snap.shareReserve : BigInt(0), 6)} Ξ</b></div>
        </div>
      )}

      {status && <p className="mt-3 rounded-lg border border-gold-500/40 bg-gold-500/10 px-3 py-2 text-[0.75rem] text-cream"><span className="mr-2 inline-block h-2 w-2 animate-pulse rounded-full bg-gold-400 align-middle" />{status}</p>}
      {error && <p className="mt-3 break-words rounded-lg border border-rose-400/40 bg-rose-500/10 px-3 py-2 text-[0.72rem] text-rose-200">{error}</p>}

      {isConnected ? (
        <button type="button" disabled={ctaDisabled} onClick={submit} className="mt-3 min-h-[48px] w-full rounded-xl bg-gold-500 text-[0.92rem] font-black text-[#261105] disabled:opacity-50">
          {tab === "buy"
            ? "Review share purchase"
            : tab === "sell"
              ? "Sell shares"
              : tab === "deposit"
                ? tokenId ? `Approve & deposit #${tokenId}` : "Select a plank"
                : tab === "redeem"
                  ? redeemMode === "random" ? "Redeem a random plank" : tokenId ? `Redeem #${tokenId}` : "Select a plank"
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
