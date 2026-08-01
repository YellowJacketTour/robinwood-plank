"use client";

/**
 * Under the floorboards — the permanent V1 bargain cellar.
 *
 * Once V3 becomes the primary vault, V1 doesn't retire: it stays on as the
 * honest floor. V1 (MARKET_VAULT_V1_KNOWN) is a pure buy/sell/deposit/redeem
 * share vault with NO contributeLiquidity / removeLiquidity path — there is no
 * LP to game or drain — so it can live forever as a zero-rarity arbitrage pool
 * where a plank is always cheaper than the listed floor: buy a cheap share,
 * redeem the exact plank you want.
 *
 * This is a *quiet* shopping surface, not a migration nag. It never tells anyone
 * to migrate; it just lets bargain hunters pull planks out of V1 directly. It
 * reuses the proven, fully address-parameterised legacy call layer
 * (lib/market/vault.ts) pointed at the V1 address, and SwapPanel's battle-tested
 * random-redeem slot subcomponents.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { formatEther } from "ethers";
import { MARKET_VAULT_V1_KNOWN } from "@/lib/constants";
import { MARKET_COLLECTIONS } from "@/lib/market/collections";
import {
  buyShares,
  decodeVaultError,
  getVaultOnChainSnapshot,
  getVaultShareBalance,
  redeemCostWei,
  redeemTarget,
  requestAndFinishRandomRedeem,
  SHARE_UNIT,
  type VaultOnChainSnapshot,
} from "@/lib/market/vault";
import { collectionFloorWei } from "@/lib/market/floors";
import { getOwnedTokenIds } from "@/lib/market/inventory";
import { NFT_CONTRACT_ADDRESS } from "@/lib/mint-contract";
import { useWallet } from "@/lib/wallet-context";
import { startVisibleInterval } from "@/lib/useVisibleInterval";
import type { PickerToken } from "@/components/market/TokenPicker";
import VaultPlankGrid from "@/components/market/VaultPlankGrid";
import { StuckRedeemRelay, PendingRedeemClaim } from "@/components/market/SwapPanel";

const V1 = MARKET_VAULT_V1_KNOWN;
const COLLECTION = MARKET_COLLECTIONS[0]; // RobinWood — the only vault collection
const BUY_SLIPPAGE_BPS = 150; // 1.5% — cellar buys are small; keeps the redeem from reverting.

/** ETH (wei) needed to buy `sharesOut` shares from a constant-product pool.
 * Inverse of MarketplankVault.buyShares: sharesOut = ethIn*R_s/(R_e+ethIn).
 * Returns null when the pool can't cover that many shares. */
function ethInForShares(sharesOut: bigint, ethReserve: bigint, shareReserve: bigint): bigint | null {
  if (sharesOut <= BigInt(0)) return BigInt(0);
  if (shareReserve <= sharesOut || ethReserve <= BigInt(0)) return null;
  // +1 wei to counter integer-division flooring so we never come up a hair short.
  return (ethReserve * sharesOut) / (shareReserve - sharesOut) + BigInt(1);
}

/** The Driftwood pool's held planks. Prefer the image-bearing indexer route
 *  (production); fall back to on-chain enumeration when the indexer is down or
 *  absent (local dev has no Blockscout, so the route errors) — the enumerable
 *  NFT lets us walk the vault's holdings directly, just without artwork. */
async function fetchHeldTokens(): Promise<PickerToken[]> {
  try {
    const res = await fetch(`/api/market/vault/held?vault=${V1}`);
    if (res.ok) {
      const j = (await res.json()) as { tokens?: { tokenId: string; imageUrl: string | null }[] };
      if (Array.isArray(j.tokens) && j.tokens.length) {
        return j.tokens.map((t) => ({ tokenId: String(t.tokenId), imageUrl: t.imageUrl ?? undefined }));
      }
    }
  } catch {
    /* fall through to on-chain */
  }
  try {
    const ids = await getOwnedTokenIds(NFT_CONTRACT_ADDRESS, V1, { force: true });
    return Array.from(ids)
      .sort((a, b) => Number(a) - Number(b))
      .map((tokenId) => ({ tokenId }));
  } catch {
    return [];
  }
}

function fmtEth(wei: bigint | null | undefined, dp = 4): string {
  if (wei == null) return "—";
  const n = Number(formatEther(wei));
  if (!Number.isFinite(n)) return "—";
  return n.toLocaleString(undefined, { minimumFractionDigits: dp, maximumFractionDigits: dp });
}

function BigStat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-xl border border-line bg-panel-strong px-3 py-2.5">
      <div className="text-[0.56rem] font-black uppercase tracking-wide text-cream-muted">{label}</div>
      <div className="font-mono text-xl font-black tabular-nums text-cream">{value}</div>
      {sub && <div className="text-[0.56rem] text-cream/45">{sub}</div>}
    </div>
  );
}

export default function FloorboardsView() {
  const { address, isConnected, connect } = useWallet();

  const [snap, setSnap] = useState<VaultOnChainSnapshot | null>(null);
  const [held, setHeld] = useState<PickerToken[]>([]);
  const [floorWei, setFloorWei] = useState<bigint | null>(null);
  const [shareBal, setShareBal] = useState<bigint>(BigInt(0));
  const [loading, setLoading] = useState(true);

  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadPublic = useCallback(async () => {
    try {
      const [s, heldTokens, ordersRes] = await Promise.all([
        getVaultOnChainSnapshot(V1).catch(() => null),
        fetchHeldTokens(),
        fetch(`/api/market/orders?collection=${COLLECTION.slug}&kind=listing`)
          .then((r) => (r.ok ? r.json() : null))
          .catch(() => null),
      ]);
      if (s) setSnap(s);
      setHeld(heldTokens);
      if (ordersRes?.items) setFloorWei(collectionFloorWei(ordersRes.items));
    } finally {
      setLoading(false);
    }
  }, []);

  // Read the connected address through a ref so loadShares keeps a stable
  // ([]-dep) identity — same shape as loadPublic, which the compiler already
  // accepts as async-safe. The effect below still re-runs on address change for
  // an immediate refresh on connect/disconnect.
  const addressRef = useRef<string | null>(address);

  const loadShares = useCallback(async () => {
    const a = addressRef.current;
    const bal = await (a ? getVaultShareBalance(a, V1) : Promise.resolve<bigint | null>(null)).catch(() => null);
    if (bal != null) setShareBal(bal);
  }, []);

  useEffect(() => {
    void loadPublic();
    const stop = startVisibleInterval(() => void loadPublic(), 20_000);
    return stop;
  }, [loadPublic]);

  useEffect(() => {
    addressRef.current = address;
    void loadShares();
    const stop = startVisibleInterval(() => void loadShares(), 20_000);
    return stop;
  }, [address, loadShares]);

  // When the wallet is disconnected, show zero without a synchronous effect
  // setState — the stored balance is simply ignored until reconnect.
  const displayShares = isConnected ? shareBal : BigInt(0);

  // Cost of a plank, in shares and in ETH-to-acquire-from-scratch (the headline
  // arbitrage number). Targeted = picking a specific plank (adds the premium).
  const costTargeted = useMemo(
    () => (snap ? redeemCostWei(snap.redeemFeeBps, snap.targetPremiumBps, true) : null),
    [snap]
  );
  const costRandom = useMemo(
    () => (snap ? redeemCostWei(snap.redeemFeeBps, snap.targetPremiumBps, false) : null),
    [snap]
  );
  const acquireTargetedWei = useMemo(
    () => (snap && costTargeted ? ethInForShares(costTargeted, snap.ethReserve, snap.shareReserve) : null),
    [snap, costTargeted]
  );
  const sharePriceWei = useMemo(() => {
    if (!snap || snap.shareReserve <= BigInt(0)) return null;
    return (snap.ethReserve * SHARE_UNIT) / snap.shareReserve;
  }, [snap]);

  const underFloorPct = useMemo(() => {
    if (!floorWei || floorWei <= BigInt(0) || acquireTargetedWei == null) return null;
    // positive = acquire cost is BELOW floor (the good case).
    return Number(((floorWei - acquireTargetedWei) * BigInt(10_000)) / floorWei) / 100;
  }, [floorWei, acquireTargetedWei]);

  const enoughForTargeted = costTargeted != null && displayShares >= costTargeted;

  const refreshAfterTx = useCallback(async () => {
    await Promise.all([loadPublic(), loadShares()]);
  }, [loadPublic, loadShares]);

  /** Ensure the wallet holds at least `need` shares, buying the deficit from the
   * pool first when short. Returns the fresh balance. */
  const ensureShares = useCallback(
    async (need: bigint): Promise<bigint> => {
      if (!address || !snap) throw new Error("Connect your wallet first.");
      let bal = await getVaultShareBalance(address, V1);
      if (bal >= need) return bal;
      const deficit = need - bal;
      const ethIn = ethInForShares(deficit, snap.ethReserve, snap.shareReserve);
      if (ethIn == null) throw new Error("The floorboards are too thin right now — not enough pool depth to buy in.");
      const withBuffer = ethIn + ethIn / BigInt(20); // +5% cushion for price drift between buy and redeem
      setStatus("Buying the shares you need…");
      await buyShares(address, formatEther(withBuffer), BUY_SLIPPAGE_BPS, undefined, V1);
      bal = await getVaultShareBalance(address, V1);
      return bal;
    },
    [address, snap]
  );

  const shopSpecific = useCallback(async () => {
    if (!isConnected || !address) {
      connect();
      return;
    }
    if (!selected || costTargeted == null) return;
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      const bal = await ensureShares(costTargeted);
      if (bal < costTargeted) throw new Error("Bought shares but still came up short — try again.");
      setStatus("Pulling your plank off the floorboards…");
      await redeemTarget(address, selected, undefined, V1);
      setStatus(`Done — plank #${selected} is in your wallet.`);
      setSelected(null);
      await refreshAfterTx();
    } catch (e) {
      setError(decodeVaultError(e));
      setStatus(null);
    } finally {
      setBusy(false);
    }
  }, [isConnected, address, connect, selected, costTargeted, ensureShares, refreshAfterTx]);

  const shopRandom = useCallback(async () => {
    if (!isConnected || !address) {
      connect();
      return;
    }
    if (costRandom == null) return;
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      const bal = await ensureShares(costRandom);
      if (bal < costRandom) throw new Error("Bought shares but still came up short — try again.");
      setStatus("Drawing a random plank…");
      await requestAndFinishRandomRedeem(address, V1, {
        onProgress: (msg: string) => setStatus(msg),
      });
      setStatus("Done — a random plank is on its way to your wallet.");
      await refreshAfterTx();
    } catch (e) {
      setError(decodeVaultError(e));
      setStatus(null);
    } finally {
      setBusy(false);
    }
  }, [isConnected, address, connect, costRandom, ensureShares, refreshAfterTx]);

  const empty = !loading && held.length === 0;
  const primaryLabel = !isConnected
    ? "Connect wallet"
    : !selected
      ? "Pick a plank above"
      : enoughForTargeted
        ? `Redeem #${selected}`
        : `Buy shares & redeem #${selected}`;

  return (
    <div data-market-shell className="mx-auto flex w-full max-w-[1440px] flex-col gap-5">
      {/* Cellar hero */}
      <header className="rounded-2xl border border-line bg-panel-strong p-5 sm:p-6">
        <p className="text-[0.62rem] font-black uppercase tracking-[0.18em] text-gold-300/80">Driftwood · the honest floor</p>
        <h1 className="mt-1 font-display text-2xl text-gold-300 sm:text-3xl">Under the floorboards</h1>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-cream-muted">
          Planks here live below the listed floor. Buy a share, pull the exact plank you want — no pool fees to game,
          no LP to drain. A permanent, honest arbitrage pool that keeps the collection floor efficient.
        </p>
      </header>

      {/* Arbitrage stat row */}
      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
        <BigStat
          label="≈ per plank"
          value={`${fmtEth(acquireTargetedWei, 4)} Ξ`}
          sub={underFloorPct != null ? (underFloorPct >= 0 ? `~${underFloorPct.toFixed(0)}% under floor` : `~${Math.abs(underFloorPct).toFixed(0)}% over floor`) : "vs listed floor"}
        />
        <BigStat label="Listed floor" value={floorWei != null ? `${fmtEth(floorWei, 4)} Ξ` : "—"} sub="cheapest listing" />
        <BigStat label="Planks available" value={loading && !snap ? "…" : String(snap?.held ?? held.length)} sub="on the floorboards" />
        <BigStat label="Share price" value={`${fmtEth(sharePriceWei, 5)} Ξ`} sub="per 1.0 share" />
      </div>

      {/* Hero: grid (star) + lean trade card */}
      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
        {/* Grid */}
        <div className="rounded-2xl border border-line bg-panel-strong p-3 sm:p-4">
          <VaultPlankGrid
            tokens={held}
            selected={selected ? new Set([selected]) : new Set()}
            selectable={!busy}
            onToggle={(id) => setSelected((cur) => (cur === id ? null : id))}
            loading={loading && held.length === 0}
            headerLabel="On the floorboards"
            emptyMessage="The floorboards are empty right now — nothing to pull. Check back after the next deposits."
          />
        </div>

        {/* Trade card */}
        <aside className="flex flex-col gap-3 lg:sticky lg:top-4 lg:self-start">
          <div className="rounded-2xl border border-line bg-panel-strong p-4">
            <h2 className="text-[0.72rem] font-black uppercase tracking-[0.06em] text-cream">Pull a plank</h2>

            <dl className="mt-3 space-y-1.5 text-xs">
              <div className="flex items-center justify-between gap-2">
                <dt className="text-cream-muted">Picked</dt>
                <dd className="font-mono tabular-nums text-cream">{selected ? `#${selected}` : "—"}</dd>
              </div>
              <div className="flex items-center justify-between gap-2">
                <dt className="text-cream-muted">Cost (specific)</dt>
                <dd className="font-mono tabular-nums text-cream">
                  {costTargeted != null ? `${fmtEth(costTargeted, 4)} sh` : "—"}
                </dd>
              </div>
              <div className="flex items-center justify-between gap-2">
                <dt className="text-cream-muted">Your Driftwood shares</dt>
                <dd className="font-mono tabular-nums text-cream">{fmtEth(displayShares, 4)} sh</dd>
              </div>
            </dl>

            <button
              type="button"
              onClick={() => void shopSpecific()}
              disabled={busy || empty || (isConnected && !selected)}
              className="mt-3 min-h-11 w-full rounded-xl bg-gold-500 px-3 text-sm font-black uppercase tracking-wide text-[#261105] transition hover:bg-gold-400 disabled:cursor-not-allowed disabled:opacity-45"
            >
              {busy ? "Working…" : primaryLabel}
            </button>

            <button
              type="button"
              onClick={() => void shopRandom()}
              disabled={busy || empty || !isConnected}
              className="mt-2 min-h-11 w-full rounded-xl border border-line-strong px-3 text-xs font-bold uppercase tracking-wide text-cream transition hover:border-gold-400/60 disabled:cursor-not-allowed disabled:opacity-45"
            >
              Surprise me — random plank
            </button>

            {!enoughForTargeted && selected && isConnected && (
              <p className="mt-2 text-[0.68rem] leading-4 text-cream/50">
                You&apos;re short on shares — one tap buys exactly what&apos;s needed, then redeems.
              </p>
            )}
            {status && <p className="mt-2 text-[0.72rem] leading-4 text-emerald-300">{status}</p>}
            {error && <p className="mt-2 text-[0.72rem] leading-4 text-rose-300">{error}</p>}
          </div>

          {/* Shared vault-wide random-redeem slot lifecycle (proven, reused). */}
          {isConnected && (
            <>
              <PendingRedeemClaim account={address} vaultAddress={V1} active />
              <StuckRedeemRelay account={address} vaultAddress={V1} active />
            </>
          )}

          <p className="px-1 text-[0.62rem] leading-4 text-cream/40">
            Shopping the Driftwood pool. Looking to move value out of an older pool instead?{" "}
            <Link href="/migrate" className="text-gold-300/80 underline hover:text-gold-300">
              Go to migrate
            </Link>
            .
          </p>
        </aside>
      </div>
    </div>
  );
}
