"use client";

/**
 * V3 Instant Swap — the trade card from docs/mockups/swap-redesign. V3-only:
 * flat ETH fees, proportional LP. Five actions in one segmented control, wired
 * to lib/market/vault-v3.ts. Reads a live snapshot on a 15s poll; each action
 * refreshes it. Shown when the active vault is generation >= 3.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { parseEther } from "ethers";
import { useWallet } from "@/lib/wallet-context";
import {
  getV3Snapshot,
  quoteBuy,
  quoteSell,
  quoteAddLiquidity,
  quoteRemoveLiquidity,
  v3Buy,
  v3Sell,
  v3Deposit,
  v3RedeemTarget,
  v3AddLiquidity,
  v3RemoveLiquidity,
  getEthBalance,
  formatUnits,
  SHARE_UNIT,
  type V3Snapshot,
} from "@/lib/market/vault-v3";
import { startVisibleInterval } from "@/lib/useVisibleInterval";

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

export default function V3SwapPanel({ vaultAddress, active = true }: { vaultAddress?: string | null; active?: boolean }) {
  const { address, isConnected, connect } = useWallet();
  const [snap, setSnap] = useState<V3Snapshot | null>(null);
  const [ethBal, setEthBal] = useState<bigint | null>(null);
  const [tab, setTab] = useState<Action>("buy");
  const [amount, setAmount] = useState("");
  const [tokenId, setTokenId] = useState("");
  const [lpMode, setLpMode] = useState<"add" | "remove">("add");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const running = useRef(false);

  const load = useCallback(async () => {
    try {
      const [s, e] = await Promise.all([
        getV3Snapshot(vaultAddress, address),
        address ? getEthBalance(address) : Promise.resolve(null),
      ]);
      setSnap(s);
      setEthBal(e);
    } catch {
      /* keep last */
    }
  }, [vaultAddress, address]);

  useEffect(() => {
    void load();
    const stop = active ? startVisibleInterval(() => { if (!running.current) void load(); }, 15_000) : null;
    return () => stop?.();
  }, [load, active]);

  const run = useCallback(
    async (fn: () => Promise<unknown>) => {
      if (running.current) return;
      running.current = true;
      setBusy(true);
      setError(null);
      setStatus("Confirm in your wallet…");
      try {
        await fn();
        setAmount("");
        setTokenId("");
        await load();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
        setStatus(null);
        running.current = false;
      }
    },
    [load]
  );

  const amtWei = toWei(amount);

  // ── derived quote for the active action ─────────────────────────────────
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

  const sharePriceEth = snap && snap.shareReserve > BigInt(0)
    ? (snap.ethReserve * SHARE_UNIT) / snap.shareReserve
    : BigInt(0);

  const submit = () => {
    if (!snap || !address) return;
    if (tab === "buy") return run(() => v3Buy(address, amtWei, snap));
    if (tab === "sell") return run(() => v3Sell(address, amtWei, snap));
    if (tab === "deposit") return run(() => v3Deposit(address, tokenId.trim(), snap, vaultAddress));
    if (tab === "redeem") return run(() => v3RedeemTarget(address, tokenId.trim(), snap));
    if (tab === "lp" && lpMode === "add") return run(() => v3AddLiquidity(address, amtWei, snap));
    if (tab === "lp" && lpMode === "remove") return run(() => v3RemoveLiquidity(address, amtWei, snap));
  };

  const disabled = busy || !isConnected;

  return (
    <div className="rounded-2xl border border-line bg-panel-strong p-3.5">
      {/* segmented control */}
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

      {isConnected && snap && (
        <div className="mt-3 grid grid-cols-3 gap-2 text-center">
          <div className="rounded-lg border border-line bg-wood-950 py-1.5">
            <div className="text-[0.52rem] font-black uppercase tracking-wide text-cream-muted">Your shares</div>
            <div className="font-mono text-base font-black text-gold-300">{formatUnits(snap.shareBalance, 2)}</div>
          </div>
          <div className="rounded-lg border border-line bg-wood-950 py-1.5">
            <div className="text-[0.52rem] font-black uppercase tracking-wide text-cream-muted">Your LP</div>
            <div className="font-mono text-base font-black text-emerald-400">{formatUnits(snap.lpBalance, 2)}</div>
          </div>
          <div className="rounded-lg border border-line bg-wood-950 py-1.5">
            <div className="text-[0.52rem] font-black uppercase tracking-wide text-cream-muted">Your ETH</div>
            <div className="font-mono text-base font-black text-cream">{ethBal !== null ? formatUnits(ethBal, 3) : "—"}</div>
          </div>
        </div>
      )}

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
        {tab === "redeem" && <><b className="text-sky-100">Redeem</b> a specific plank by ID — burns one share + {snap ? formatUnits(snap.redeemFeeWei + snap.targetPremiumWei) : "…"} Ξ.</>}
        {tab === "lp" && lpMode === "add" && <><b className="text-sky-100">Add liquidity</b> — supply ETH; shares are pulled to match the ratio. Earn the 0.30% swap fee.</>}
        {tab === "lp" && lpMode === "remove" && <><b className="text-sky-100">Remove liquidity</b> — burn LP for a pro-rata slice of the pool.</>}
      </p>

      {/* input */}
      {tab === "deposit" || tab === "redeem" ? (
        <label className="mt-3 block rounded-xl border border-line bg-wood-950 px-3.5 py-3">
          <span className="text-[0.66rem] font-bold text-cream-muted">Plank token ID</span>
          <input
            value={tokenId}
            onChange={(e) => setTokenId(e.target.value.replace(/[^0-9]/g, ""))}
            placeholder="e.g. 9"
            inputMode="numeric"
            className="mt-1 w-full bg-transparent text-xl font-black text-cream outline-none placeholder:text-cream/30"
          />
        </label>
      ) : (
        <>
          <label className="mt-3 block rounded-xl border border-line bg-wood-950 px-3.5 py-3">
            <span className="flex justify-between text-[0.66rem] font-bold text-cream-muted">
              <span>{tab === "sell" ? "You sell (shares)" : lpMode === "remove" && tab === "lp" ? "Burn LP" : "You pay"}</span>
              {snap && (
                <span>
                  bal{" "}
                  {tab === "sell"
                    ? `${formatUnits(snap.shareBalance, 2)} sh`
                    : tab === "lp" && lpMode === "remove"
                      ? `${formatUnits(snap.lpBalance, 2)} LP`
                      : `${ethBal !== null ? formatUnits(ethBal, 3) : "…"} Ξ`}
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
                {tab === "sell" ? "shares" : tab === "lp" && lpMode === "remove" ? "LP" : "◆ ETH"}
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

      {/* summary */}
      {snap && (
        <div className="mt-3 space-y-1 text-[0.72rem] text-cream-muted">
          <div className="flex justify-between"><span>Share price</span><b className="text-cream">{formatUnits(sharePriceEth, 6)} Ξ</b></div>
          {(tab === "buy" || tab === "sell") && (
            <div className="flex justify-between"><span>Swap fee</span><b className="text-emerald-400">{(snap.swapFeeBps / 100).toFixed(2)}% → LPs</b></div>
          )}
          <div className="flex justify-between"><span>Pool</span><b className="text-cream">{formatUnits(snap.ethReserve, 3)} Ξ · {formatUnits(snap.shareReserve, 2)} sh · {snap.held} planks</b></div>
        </div>
      )}

      {status && <p className="mt-3 rounded-lg border border-gold-500/40 bg-gold-500/10 px-3 py-2 text-[0.75rem] text-cream"><span className="mr-2 inline-block h-2 w-2 animate-pulse rounded-full bg-gold-400 align-middle" />{status}</p>}
      {error && <p className="mt-3 rounded-lg border border-rose-400/40 bg-rose-500/10 px-3 py-2 text-[0.72rem] text-rose-200">{error}</p>}

      {isConnected ? (
        <button
          type="button"
          disabled={disabled}
          onClick={submit}
          className="mt-3 min-h-[48px] w-full rounded-xl bg-gold-500 text-[0.92rem] font-black text-[#261105] disabled:opacity-50"
        >
          {tab === "buy" ? "Review share purchase" : tab === "sell" ? "Sell shares" : tab === "deposit" ? "Approve & deposit" : tab === "redeem" ? "Redeem plank" : lpMode === "add" ? "Add liquidity" : "Remove liquidity"}
        </button>
      ) : (
        <button type="button" onClick={() => void connect()} className="mt-3 min-h-[48px] w-full rounded-xl bg-gold-500 text-[0.92rem] font-black text-[#261105]">
          Connect wallet
        </button>
      )}
    </div>
  );
}
