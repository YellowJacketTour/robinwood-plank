"use client";

/**
 * The full V3 Instant Swap page, per docs/mockups/swap-redesign. V3-only:
 * a compact vault line, the focused trade card, a "Your position" +
 * "Vault at a glance" context column, and a single tabbed analytics area.
 * Owns one snapshot poll and passes it to the trade card so the whole page
 * stays consistent. Legacy vaults never appear here.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useWallet } from "@/lib/wallet-context";
import { shortVault } from "@/lib/market/vault-registry";
import {
  getV3Snapshot,
  getEthBalance,
  getPlankBalance,
  formatUnits,
  SHARE_UNIT,
  type V3Snapshot,
} from "@/lib/market/vault-v3";
import { useLegacyPosition } from "@/lib/market/useLegacyPosition";
import { startVisibleInterval } from "@/lib/useVisibleInterval";
import { getOwnedTokenIds } from "@/lib/market/inventory";
import { NFT_CONTRACT_ADDRESS } from "@/lib/mint-contract";
import type { PickerToken } from "@/components/market/TokenPicker";
import V3SwapPanel from "@/components/market/V3SwapPanel";

type TabKey = "price" | "odds" | "activity" | "liquidity";

export default function V3SwapView({ vaultAddress, active = true }: { vaultAddress?: string | null; active?: boolean }) {
  const { address, isConnected, connect } = useWallet();
  const [snap, setSnap] = useState<V3Snapshot | null>(null);
  const [ethBal, setEthBal] = useState<bigint | null>(null);
  const [plankBal, setPlankBal] = useState<number | null>(null);
  const [owned, setOwned] = useState<PickerToken[]>([]);
  const [held, setHeld] = useState<PickerToken[]>([]);
  const [tab, setTab] = useState<TabKey>("price");
  const running = useRef(false);

  // Migration nudge only if the connected wallet holds a retiring vault.
  const legacy = useLegacyPosition(isConnected ? address : null, active);

  const toPickerTokens = (ids: Set<string>): PickerToken[] =>
    Array.from(ids)
      .sort((a, b) => Number(a) - Number(b))
      .map((tokenId) => ({ tokenId }));

  const load = useCallback(async () => {
    try {
      const [s, e, p, ownedIds, heldIds] = await Promise.all([
        getV3Snapshot(vaultAddress, address),
        address ? getEthBalance(address) : Promise.resolve(null),
        address ? getPlankBalance(address) : Promise.resolve(null),
        // On-chain enumeration (no indexer): a wallet's planks, and the vault's.
        address ? getOwnedTokenIds(NFT_CONTRACT_ADDRESS, address, { force: true }) : Promise.resolve(new Set<string>()),
        vaultAddress ? getOwnedTokenIds(NFT_CONTRACT_ADDRESS, vaultAddress, { force: true }) : Promise.resolve(new Set<string>()),
      ]);
      setSnap(s);
      setEthBal(e);
      setPlankBal(p);
      setOwned(toPickerTokens(ownedIds));
      setHeld(toPickerTokens(heldIds));
    } catch {
      /* keep last */
    }
  }, [vaultAddress, address]);

  useEffect(() => {
    void load();
    const stop = active ? startVisibleInterval(() => { if (!running.current) void load(); }, 15_000) : null;
    return () => stop?.();
  }, [load, active]);

  const refresh = useCallback(async () => {
    running.current = true;
    try {
      await load();
    } finally {
      running.current = false;
    }
  }, [load]);

  const sharePrice = snap && snap.shareReserve > BigInt(0) ? (snap.ethReserve * SHARE_UNIT) / snap.shareReserve : BigInt(0);
  const lockedLp = snap && snap.totalLpSupply > BigInt(0) ? snap.totalLpSupply - snap.lpBalance : BigInt(0);
  const poolShare = useMemo(() => {
    if (!snap || snap.totalLpSupply === BigInt(0)) return "0.0";
    return ((Number(snap.lpBalance) / Number(snap.totalLpSupply)) * 100).toFixed(1);
  }, [snap]);

  return (
    <section data-market-shell className="space-y-4">
      {/* migration nudge (hidden unless the wallet holds V1/V2) */}
      {isConnected && legacy.hasValue && (
        <Link
          href="/migrate"
          className="flex flex-wrap items-center gap-3 rounded-xl border border-line-strong bg-gradient-to-r from-gold-500/15 to-transparent px-4 py-2.5 transition hover:border-gold-500/60"
        >
          <span className="h-2.5 w-2.5 flex-none rounded-full bg-amber-400 shadow-[0_0_8px_rgba(251,191,36,0.6)]" />
          <span className="min-w-0 flex-1 text-sm text-cream">
            <b className="text-gold-300">You hold planks in a retiring vault.</b> V1/V2 are winding down — move your value to V3.
          </span>
          <span className="inline-flex min-h-[40px] flex-none items-center rounded-lg bg-gold-500 px-4 text-sm font-black text-[#261105]">Migrate now →</span>
        </Link>
      )}

      {/* single V3 vault line */}
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 rounded-xl border border-line bg-panel-strong px-4 py-3">
        <span className="inline-flex items-center gap-2">
          <span className="rounded border border-emerald-400/50 bg-emerald-500/15 px-1.5 py-0.5 text-[0.56rem] font-black tracking-wide text-emerald-400">V3</span>
          <span className="text-sm font-extrabold text-cream">RobinWood Vault</span>
          <span className="font-mono text-[0.66rem] text-cream-muted">{snap ? shortVault(snap.address) : "…"}</span>
        </span>
        {snap && (
          <span className="flex flex-wrap gap-x-4 gap-y-1 text-[0.72rem] tabular-nums text-cream-muted">
            <span className={snap.poolOpen ? "text-emerald-400" : "text-amber-400"}>● {snap.poolOpen ? "Open" : "Closed"}</span>
            <span><b className="text-gold-300">{snap.held}</b> planks</span>
            <span><b className="text-gold-300">{formatUnits(snap.ethReserve, 3)} Ξ</b> liquidity</span>
            <span><b className="text-gold-300">{formatUnits(snap.shareReserve, 2)}</b> shares</span>
            <span><b className="text-gold-300">{formatUnits(sharePrice, 5)} Ξ</b>/share</span>
          </span>
        )}
      </div>

      {/* hero: trade card + context */}
      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,440px)_minmax(0,1fr)]">
        <V3SwapPanel
          snap={snap}
          ethBal={ethBal}
          address={address}
          isConnected={isConnected}
          vaultAddress={vaultAddress}
          ownedTokens={owned}
          heldTokens={held}
          invLoading={snap === null}
          onConnect={() => void connect()}
          onAfterTx={refresh}
        />

        <div className="space-y-4">
          <div className="rounded-xl border border-line bg-panel-strong p-4">
            <h3 className="flex items-center gap-2 text-[0.7rem] font-black uppercase tracking-wide text-cream">
              Your position <span className="ml-auto text-[0.6rem] font-bold text-cream-muted">on V3</span>
            </h3>
            <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
              <Stat k="Shares" v={snap ? formatUnits(snap.shareBalance, 2) : "—"} n="vROBIN" />
              <Stat k="Planks held" v={plankBal !== null ? String(plankBal) : "—"} n="in your wallet" ok />
              <Stat k="Your LP" v={snap ? formatUnits(snap.lpBalance, 2) : "—"} n={`${poolShare}% of pool`} ok />
            </div>
            {isConnected && owned.length > 0 && <PlankStrip label="Your planks" tokens={owned} />}
            {!isConnected && (
              <button type="button" onClick={() => void connect()} className="mt-3 min-h-[44px] w-full rounded-lg border border-line-strong bg-wood-950 text-sm font-bold text-cream">
                Connect to see your position
              </button>
            )}
          </div>

          <div className="rounded-xl border border-line bg-panel-strong p-4">
            <h3 className="flex items-center gap-2 text-[0.7rem] font-black uppercase tracking-wide text-cream">
              Vault at a glance <span className="ml-auto text-[0.6rem] font-bold text-cream-muted">live</span>
            </h3>
            <div className="mt-3 grid grid-cols-3 gap-2">
              <Cell k="Planks" v={snap ? String(snap.held) : "—"} />
              <Cell k="ETH liq." v={snap ? `${formatUnits(snap.ethReserve, 3)} Ξ` : "—"} />
              <Cell k="Share liq." v={snap ? formatUnits(snap.shareReserve, 2) : "—"} />
              <Cell k="Share price" v={snap ? `${formatUnits(sharePrice, 5)} Ξ` : "—"} />
              <Cell k="Deposit / redeem" v={snap ? `${formatUnits(snap.mintFeeWei)} Ξ` : "—"} />
              <Cell k="Swap fee" v={snap ? `${(snap.swapFeeBps / 100).toFixed(2)}%` : "—"} />
            </div>
            {held.length > 0 && <PlankStrip label="In the vault" tokens={held} />}
          </div>
        </div>
      </div>

      {/* one tabbed analytics area */}
      <div className="overflow-hidden rounded-xl border border-line bg-panel-strong">
        <div className="flex gap-1 border-b border-line bg-wood-950/60 p-1.5">
          {([["price", "Price"], ["odds", "Redeem odds"], ["activity", "Activity"], ["liquidity", "Liquidity"]] as [TabKey, string][]).map(([id, label]) => (
            <button key={id} type="button" onClick={() => setTab(id)} aria-pressed={tab === id} className={`min-h-11 rounded-lg px-3.5 py-2 text-[0.72rem] font-black ${tab === id ? "bg-gold-500/15 text-gold-300" : "text-cream-muted hover:text-cream"}`}>{label}</button>
          ))}
        </div>
        <div className="p-4">
          {tab === "price" && (
            <div className="flex h-32 items-center justify-center rounded-lg border border-line bg-wood-950 text-[0.75rem] text-cream-muted">
              Share price {snap ? `${formatUnits(sharePrice, 5)} Ξ` : "…"} — price history streams in once V3 has trade volume.
            </div>
          )}
          {tab === "odds" && (
            <p className="text-[0.78rem] text-cream-muted">
              A random redeem draws uniformly from the {snap?.held ?? 0} held planks — each currently has a{" "}
              <b className="text-cream">{snap && snap.held > 0 ? (100 / snap.held).toFixed(1) : "—"}%</b> chance. Rarity-tier odds populate from the rarity snapshot on mainnet.
            </p>
          )}
          {tab === "activity" && (
            <p className="text-[0.78rem] text-cream-muted">Recent V3 buys, sells, deposits and redeems land here — empty on a fresh local vault until you trade.</p>
          )}
          {tab === "liquidity" && snap && (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              <Cell k="Total LP" v={formatUnits(snap.totalLpSupply, 3)} />
              <Cell k="Locked seed LP" v={formatUnits(lockedLp, 3)} />
              <Cell k="Your LP" v={formatUnits(snap.lpBalance, 3)} />
              <Cell k="Accrued fees" v={`${formatUnits(snap.accruedFees, 4)} Ξ`} />
              <Cell k="Pool ETH" v={`${formatUnits(snap.ethReserve, 3)} Ξ`} />
              <Cell k="Pool shares" v={formatUnits(snap.shareReserve, 2)} />
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function Stat({ k, v, n, ok }: { k: string; v: string; n: string; ok?: boolean }) {
  return (
    <div className="rounded-lg border border-line bg-wood-950 px-2.5 py-2">
      <div className="text-[0.52rem] font-black uppercase tracking-wide text-cream-muted">{k}</div>
      <div className={`font-mono text-lg font-black tabular-nums ${ok ? "text-emerald-400" : "text-gold-300"}`}>{v}</div>
      <div className="text-[0.52rem] text-cream/50">{n}</div>
    </div>
  );
}

function Cell({ k, v }: { k: string; v: string }) {
  return (
    <div className="rounded-lg border border-line bg-wood-950 px-2.5 py-2">
      <div className="text-[0.5rem] font-black uppercase tracking-wide text-cream-muted">{k}</div>
      <div className="mt-0.5 font-mono text-sm font-black tabular-nums text-cream">{v}</div>
    </div>
  );
}

/**
 * A compact strip of plank artwork — the mockup's stated differentiator for the
 * context column. Shows the real NFT image when resolvable; falls back to the
 * token id on a fresh local vault whose mock art has no tokenURI.
 */
function PlankStrip({ label, tokens }: { label: string; tokens: PickerToken[] }) {
  const MAX = 8;
  const shown = tokens.slice(0, MAX);
  const extra = tokens.length - shown.length;
  return (
    <div className="mt-3">
      <div className="mb-1.5 text-[0.5rem] font-black uppercase tracking-wide text-cream-muted">{label}</div>
      <div className="flex flex-wrap gap-1.5">
        {shown.map((t) => (
          <span
            key={t.tokenId}
            title={`Plank #${t.tokenId}`}
            className="flex h-9 w-9 items-center justify-center overflow-hidden rounded-md border border-line bg-wood-900 text-[0.55rem] font-black tabular-nums text-cream/50"
          >
            {t.imageUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={t.imageUrl} alt={`Plank #${t.tokenId}`} className="h-full w-full object-cover" />
            ) : (
              <>#{t.tokenId}</>
            )}
          </span>
        ))}
        {extra > 0 && (
          <span className="flex h-9 min-w-9 items-center justify-center rounded-md border border-line bg-wood-900 px-1.5 text-[0.55rem] font-black tabular-nums text-cream-muted">
            +{extra}
          </span>
        )}
      </div>
    </div>
  );
}
