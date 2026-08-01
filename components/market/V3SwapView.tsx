"use client";

/**
 * The full V3 Instant Swap page. V3-only. Layout: a consolidated alert slot, a
 * single vault line carrying every vault stat, a hero of the focal trade card
 * (bounded band) beside a narrow rail (your position + plank art), and a
 * supporting analytics band below. Owns one snapshot poll and passes it to the
 * trade card so the whole page stays consistent. Legacy vaults never appear here.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useWallet } from "@/lib/wallet-context";
import { shortVault } from "@/lib/market/vault-registry";
import {
  getV3Snapshot,
  getV3Pending,
  getEthBalance,
  getPlankBalance,
  v3ClaimRandomRedeem,
  v3ClaimRandomRedeemFor,
  v3ForfeitExpiredRedeem,
  decodeV3Error,
  formatUnits,
  SHARE_UNIT,
  type V3Snapshot,
  type V3Pending,
} from "@/lib/market/vault-v3";
import { useLegacyPosition } from "@/lib/market/useLegacyPosition";
import { startVisibleInterval } from "@/lib/useVisibleInterval";
import { getOwnedTokenIds, getOwnedInventory } from "@/lib/market/inventory";
import { MARKET_COLLECTIONS } from "@/lib/market/collections";
import { NFT_CONTRACT_ADDRESS } from "@/lib/mint-contract";
import type { PickerToken } from "@/components/market/TokenPicker";
import V3SwapPanel, { type Action } from "@/components/market/V3SwapPanel";
import VaultPlankGrid from "@/components/market/VaultPlankGrid";

type TabKey = "price" | "odds" | "activity" | "liquidity";

const toPicker = (ids: Set<string>): PickerToken[] =>
  Array.from(ids).sort((a, b) => Number(a) - Number(b)).map((tokenId) => ({ tokenId }));

/** The vault's held planks. Prefer the image-bearing indexer route (production);
 *  fall back to on-chain enumeration (works locally / when the indexer is down,
 *  but without artwork). */
async function fetchHeld(vault?: string | null): Promise<PickerToken[]> {
  try {
    const q = vault ? `?vault=${encodeURIComponent(vault)}` : "";
    const res = await fetch(`/api/market/vault/held${q}`);
    if (res.ok) {
      const j = (await res.json()) as { tokens?: { tokenId: string; imageUrl: string | null }[] };
      if (Array.isArray(j.tokens) && j.tokens.length) {
        return j.tokens.map((t) => ({ tokenId: String(t.tokenId), imageUrl: t.imageUrl ?? undefined }));
      }
    }
  } catch {
    /* fall through to on-chain */
  }
  const ids = vault ? await getOwnedTokenIds(NFT_CONTRACT_ADDRESS, vault, { force: true }) : new Set<string>();
  return toPicker(ids);
}

/** The connected wallet's planks, with artwork where resolvable. */
async function fetchOwned(account?: string | null): Promise<PickerToken[]> {
  if (!account) return [];
  try {
    const inv = await getOwnedInventory(MARKET_COLLECTIONS, account);
    const items = inv.flatMap((g) => g.items).map((i) => ({ tokenId: String(i.tokenId), imageUrl: i.imageUrl || undefined }));
    if (items.length) return items;
  } catch {
    /* fall through to on-chain */
  }
  const ids = await getOwnedTokenIds(NFT_CONTRACT_ADDRESS, account, { force: true });
  return toPicker(ids);
}

export default function V3SwapView({ vaultAddress, active = true }: { vaultAddress?: string | null; active?: boolean }) {
  const { address, isConnected, connect } = useWallet();
  const [snap, setSnap] = useState<V3Snapshot | null>(null);
  const [ethBal, setEthBal] = useState<bigint | null>(null);
  const [plankBal, setPlankBal] = useState<number | null>(null);
  const [owned, setOwned] = useState<PickerToken[]>([]);
  const [held, setHeld] = useState<PickerToken[]>([]);
  const [pending, setPending] = useState<V3Pending | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [rescueBusy, setRescueBusy] = useState(false);
  const [rescueMsg, setRescueMsg] = useState<string | null>(null);
  // Default to Redeem odds — the only tab with real computed data on a fresh
  // vault; Price/Activity have nothing to show until there's trade volume.
  const [tab, setTab] = useState<TabKey>("odds");
  // Trade widget state, lifted here so the grid and the widget share it.
  const [action, setAction] = useState<Action>("buy");
  const [redeemMode, setRedeemMode] = useState<"random" | "specific">("random");
  const [cart, setCart] = useState<Set<string>>(new Set());
  const running = useRef(false);

  // The grid shows the vault's held planks for everything except Deposit (where
  // you pick from your OWN planks). Selecting is only on the two picked actions.
  const gridSource = action === "deposit" ? owned : held;
  const gridSelectable = action === "deposit" || (action === "redeem" && redeemMode === "specific");
  const toggleCart = useCallback((tokenId: string) => {
    setCart((prev) => {
      const next = new Set(prev);
      if (next.has(tokenId)) next.delete(tokenId);
      else next.add(tokenId);
      return next;
    });
  }, []);
  // Owned/held ids don't mix in one cart — clear it whenever the mode changes.
  const changeAction = useCallback((a: Action) => { setAction(a); setCart(new Set()); }, []);
  const changeRedeemMode = useCallback((m: "random" | "specific") => { setRedeemMode(m); setCart(new Set()); }, []);

  // Migration nudge only if the connected wallet holds a retiring vault.
  const legacy = useLegacyPosition(isConnected ? address : null, active);

  const load = useCallback(async () => {
    try {
      const [s, pend, e, p, ownedTokens, heldTokens] = await Promise.all([
        getV3Snapshot(vaultAddress, address),
        getV3Pending(vaultAddress, address),
        address ? getEthBalance(address) : Promise.resolve(null),
        address ? getPlankBalance(address) : Promise.resolve(null),
        fetchOwned(address),
        fetchHeld(vaultAddress),
      ]);
      setSnap(s);
      setPending(pend);
      setEthBal(e);
      setPlankBal(p);
      setOwned(ownedTokens);
      setHeld(heldTokens);
      setLoadError(null);
    } catch (e) {
      // Don't fail silently (the old behavior left the page stuck on "…" with
      // nothing logged). Keep the last good data, but surface a retry.
      console.error("V3 vault read failed", e);
      setLoadError(decodeV3Error(e));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  // Free the single vault-wide redeem slot: claim mine, settle another user's
  // pinned draw for them, or forfeit an expired one. All permissionless.
  const runRescue = useCallback(
    async (fn: () => Promise<unknown>) => {
      if (!address) return;
      setRescueBusy(true);
      setRescueMsg(null);
      try {
        await fn();
        await refresh();
      } catch (e) {
        setRescueMsg(decodeV3Error(e));
      } finally {
        setRescueBusy(false);
      }
    },
    [address, refresh]
  );

  const ZERO_ADDR = "0x0000000000000000000000000000000000000000";
  const hasPending = Boolean(pending && pending.requester !== ZERO_ADDR);
  const sharePrice = snap && snap.shareReserve > BigInt(0) ? (snap.ethReserve * SHARE_UNIT) / snap.shareReserve : BigInt(0);
  const lockedLp = snap ? snap.lockedLp : BigInt(0);
  const poolShare = useMemo(() => {
    if (!snap || snap.totalLpSupply === BigInt(0)) return "0.0";
    return ((Number(snap.lpBalance) / Number(snap.totalLpSupply)) * 100).toFixed(1);
  }, [snap]);

  return (
    <section data-market-shell className="space-y-4">
      {/* One consolidated alert slot — slim single-line bars so up to three
          conditionals never push the trade card below the fold. */}
      {(loadError && snap === null) || hasPending || (isConnected && legacy.hasLegacyValue) ? (
        <div className="space-y-2">
          {loadError && snap === null && (
            <div className="flex flex-wrap items-center gap-3 rounded-xl border border-rose-400/40 bg-rose-500/10 px-4 py-2 text-sm text-rose-200">
              <span className="min-w-0 flex-1">Couldn&apos;t reach the vault — {loadError}</span>
              <button type="button" onClick={() => void load()} className="min-h-[40px] flex-none rounded-lg border border-rose-400/50 px-4 text-sm font-bold text-rose-100">
                Retry
              </button>
            </div>
          )}

          {/* stuck-slot rescue — the vault has ONE redeem slot; surface it so a
              walked-away request can't silently block everyone's trades. */}
          {hasPending && pending && (
            <div className="rounded-xl border border-amber-400/40 bg-amber-500/10 px-4 py-2">
              <div className="flex flex-wrap items-center gap-3">
                <span className="h-2.5 w-2.5 flex-none animate-pulse rounded-full bg-amber-400" />
                <span className="min-w-0 flex-1 text-sm text-cream">
                  {pending.isMe ? (
                    <><b className="text-amber-200">Your random redeem is pending.</b> {pending.available ? "The draw is ready — claim your plank." : "Waiting for the drand round to land on-chain."}</>
                  ) : (
                    <><b className="text-amber-200">The redeem slot is busy</b> — another wallet is mid-redeem, so trades are paused until it clears. {pending.available ? "You can settle it for them." : "It’ll free automatically once their round lands, or can be forfeited once expired."}</>
                  )}
                </span>
                {isConnected && pending.isMe && pending.available && (
                  <button type="button" disabled={rescueBusy} onClick={() => runRescue(() => v3ClaimRandomRedeem(address!))} className="min-h-11 flex-none rounded-lg bg-gold-500 px-4 text-sm font-black text-[#261105] disabled:opacity-50">
                    Claim my plank
                  </button>
                )}
                {isConnected && !pending.isMe && (
                  <div className="flex flex-none gap-2">
                    <button type="button" disabled={rescueBusy || !pending.available} onClick={() => runRescue(() => v3ClaimRandomRedeemFor(address!, pending.requester, vaultAddress))} className="min-h-11 rounded-lg border border-line-strong bg-wood-950 px-3 text-sm font-bold text-cream disabled:opacity-40">
                      Settle for them
                    </button>
                    <button type="button" disabled={rescueBusy} onClick={() => runRescue(() => v3ForfeitExpiredRedeem(address!, pending.requester, vaultAddress))} className="min-h-11 rounded-lg border border-line-strong bg-wood-950 px-3 text-sm font-bold text-cream disabled:opacity-40">
                      Forfeit if expired
                    </button>
                  </div>
                )}
              </div>
              {rescueMsg && <p className="mt-2 text-[0.72rem] text-rose-200">{rescueMsg}</p>}
            </div>
          )}

          {/* migration nudge — least urgent, so only when nothing above shows */}
          {isConnected && legacy.hasLegacyValue && !(loadError && snap === null) && !hasPending && (
            <Link
              href="/migrate"
              className="flex flex-wrap items-center gap-3 rounded-xl border border-line-strong bg-gradient-to-r from-gold-500/15 to-transparent px-4 py-2 transition hover:border-gold-500/60"
            >
              <span className="h-2.5 w-2.5 flex-none rounded-full bg-amber-400 shadow-[0_0_8px_rgba(251,191,36,0.6)]" />
              <span className="min-w-0 flex-1 text-sm text-cream">
                <b className="text-gold-300">You hold value in a retiring vault.</b> V1/V2 are winding down — move it to V3.
              </span>
              <span className="inline-flex min-h-[40px] flex-none items-center rounded-lg bg-gold-500 px-4 text-sm font-black text-[#261105]">Migrate now →</span>
            </Link>
          )}
        </div>
      ) : null}

      {/* single V3 vault line */}
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 rounded-xl border border-line bg-panel-strong px-4 py-3">
        <span className="inline-flex items-center gap-2">
          <span className="rounded border border-emerald-400/50 bg-emerald-500/15 px-1.5 py-0.5 text-[0.56rem] font-black tracking-wide text-emerald-400">V3</span>
          <span className="text-sm font-extrabold text-cream">RobinWood Vault</span>
          <span className="font-mono text-[0.66rem] text-cream-muted">{snap ? shortVault(snap.address) : "…"}</span>
        </span>
        {snap && (
          <span className="flex flex-wrap gap-x-4 gap-y-1 text-[0.72rem] tabular-nums text-cream-muted sm:ml-auto">
            <span className={snap.poolOpen ? "text-emerald-400" : "text-amber-400"}>● {snap.poolOpen ? "Open" : "Closed"}</span>
            <span><b className="text-gold-300">{snap.held}</b> planks</span>
            <span><b className="text-gold-300">{formatUnits(snap.ethReserve, 3)} Ξ</b> liquidity</span>
            <span><b className="text-gold-300">{formatUnits(snap.shareReserve, 2)}</b> shares</span>
            <span><b className="text-gold-300">{formatUnits(sharePrice, 5)} Ξ</b>/share</span>
            <span><b className="text-gold-300">{formatUnits(snap.mintFeeWei)} Ξ</b> deposit/redeem</span>
            <span><b className="text-gold-300">{(snap.swapFeeBps / 100).toFixed(2)}%</b> swap fee</span>
          </span>
        )}
      </div>

      {/* hero: big artwork grid leads, the full trade widget docks as a rail */}
      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_360px] xl:grid-cols-[minmax(0,1fr)_400px]">
        <VaultPlankGrid
          tokens={gridSource}
          selected={cart}
          selectable={gridSelectable}
          onToggle={toggleCart}
          loading={snap === null}
          headerLabel={action === "deposit" ? "Your planks" : "In the vault"}
          emptyMessage={
            action === "deposit"
              ? isConnected ? "No planks in your wallet to deposit." : "Connect to deposit your planks."
              : "No planks in the vault yet."
          }
        />

        <div className="space-y-3 lg:sticky lg:top-4 lg:self-start">
          {/* compact position strip above the widget */}
          <div className="grid grid-cols-3 gap-2">
            <Tile label="Shares" value={snap ? formatUnits(snap.shareBalance, 2) : "—"} note="vROBIN" size="lg" tone="gold" />
            <Tile label="Planks held" value={plankBal !== null ? String(plankBal) : "—"} note="your wallet" size="lg" tone="ok" />
            <Tile label="Your LP" value={snap ? formatUnits(snap.lpBalance, 2) : "—"} note={`${poolShare}% pool`} size="lg" tone="ok" />
          </div>

          <V3SwapPanel
            snap={snap}
            ethBal={ethBal}
            address={address}
            isConnected={isConnected}
            vaultAddress={vaultAddress}
            action={action}
            onActionChange={changeAction}
            redeemMode={redeemMode}
            onRedeemModeChange={changeRedeemMode}
            cart={cart}
            redeemSlotBusy={Boolean(hasPending && pending && !pending.isMe)}
            onConnect={() => void connect()}
            onAfterTx={() => { setCart(new Set()); return refresh(); }}
          />
        </div>
      </div>

      {/* demoted stats + odds — collapsed so the grid + widget own the fold */}
      <details className="overflow-hidden rounded-xl border border-line bg-panel-strong">
        <summary className="flex flex-wrap gap-1 border-b border-line bg-wood-950/60 p-1.5 cursor-pointer list-none">
          {([["odds", "Redeem odds"], ["price", "Price"], ["activity", "Activity"], ["liquidity", "Liquidity"]] as [TabKey, string][]).map(([id, label]) => (
            <button key={id} type="button" onClick={(e) => { e.preventDefault(); setTab(id); }} aria-pressed={tab === id} className={`min-h-11 rounded-lg px-3.5 py-2 text-[0.72rem] font-black ${tab === id ? "bg-gold-500/15 text-gold-300" : "text-cream-muted hover:text-cream"}`}>{label}</button>
          ))}
          <span className="ml-auto flex items-center pr-2 text-[0.66rem] text-cream-muted">Vault stats &amp; odds</span>
        </summary>
        <div className="p-4">
          {tab === "odds" && (
            <p className="text-[0.78rem] text-cream-muted">
              A random redeem draws uniformly from the {snap?.availableCount ?? 0} available planks
              {snap && snap.pendingRedeemCount > 0 ? ` (${snap.pendingRedeemCount} reserved for an in-flight redeem)` : ""} — each currently has a{" "}
              <b className="text-cream">{snap && snap.availableCount > 0 ? (100 / snap.availableCount).toFixed(1) : "—"}%</b> chance. Rarity-tier odds populate from the rarity snapshot on mainnet.
            </p>
          )}
          {tab === "price" && (
            <div className="flex min-h-[3.5rem] items-center rounded-lg border border-line bg-wood-950 px-3 text-[0.75rem] text-cream-muted">
              Share price {snap ? `${formatUnits(sharePrice, 5)} Ξ` : "…"} — price history streams in once V3 has trade volume.
            </div>
          )}
          {tab === "activity" && (
            <div className="flex min-h-[3.5rem] items-center rounded-lg border border-line bg-wood-950 px-3 text-[0.78rem] text-cream-muted">
              Recent V3 buys, sells, deposits and redeems land here — empty until the vault sees trades.
            </div>
          )}
          {tab === "liquidity" && snap && (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              <Tile label="Total LP" value={formatUnits(snap.totalLpSupply, 3)} size="sm" tone="neutral" />
              <Tile label="Locked seed LP" value={formatUnits(lockedLp, 3)} size="sm" tone="neutral" />
              <Tile label="Your LP" value={formatUnits(snap.lpBalance, 3)} size="sm" tone="neutral" />
              <Tile label="Accrued fees" value={`${formatUnits(snap.accruedFees, 4)} Ξ`} size="sm" tone="neutral" />
              <Tile label="Pool ETH" value={`${formatUnits(snap.ethReserve, 3)} Ξ`} size="sm" tone="neutral" />
              <Tile label="Pool shares" value={formatUnits(snap.shareReserve, 2)} size="sm" tone="neutral" />
            </div>
          )}
        </div>
      </details>
    </section>
  );
}

/**
 * One "label + number" tile primitive for every stat on the page (position,
 * liquidity). `size` sets the value scale, `tone` its colour, `note` an optional
 * sub-line. Replaces the old Stat/Cell pair that used three different scales.
 */
function Tile({
  label,
  value,
  note,
  tone = "gold",
  size = "sm",
}: {
  label: string;
  value: string;
  note?: string;
  tone?: "gold" | "ok" | "neutral";
  size?: "sm" | "lg";
}) {
  const toneClass = tone === "ok" ? "text-emerald-400" : tone === "neutral" ? "text-cream" : "text-gold-300";
  return (
    <div className="rounded-lg border border-line bg-wood-950 px-2.5 py-2">
      <div className="text-[0.52rem] font-black uppercase tracking-wide text-cream-muted">{label}</div>
      <div className={`font-mono font-black tabular-nums ${size === "lg" ? "text-lg" : "mt-0.5 text-sm"} ${toneClass}`}>{value}</div>
      {note && <div className="text-[0.52rem] text-cream/50">{note}</div>}
    </div>
  );
}

