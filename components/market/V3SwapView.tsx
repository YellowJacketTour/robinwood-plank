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
import { ArrowDown, ArrowUp, ArrowLeftRight, ExternalLink } from "lucide-react";
import { useWallet } from "@/lib/wallet-context";
import { CHAIN } from "@/lib/constants";
import { shortVault } from "@/lib/market/vault-registry";
import {
  getV3Snapshot,
  getV3Pending,
  getEthBalance,
  getPlankBalance,
  v3ClaimRandomRedeem,
  v3ClaimRandomRedeemFor,
  v3ForfeitExpiredRedeem,
  getV3Activity,
  quoteRemoveLiquidity,
  decodeV3Error,
  formatUnits,
  SHARE_UNIT,
  type V3Snapshot,
  type V3Pending,
  type V3Activity,
  type V3ActivityKind,
} from "@/lib/market/vault-v3";
import { useLegacyPosition } from "@/lib/market/useLegacyPosition";
import { startVisibleInterval } from "@/lib/useVisibleInterval";
import { getOwnedTokenIds, getOwnedInventory } from "@/lib/market/inventory";
import { MARKET_COLLECTIONS } from "@/lib/market/collections";
import { robinwoodTokenUri } from "@/lib/market/robinwood-uri";
import { fetchNftMetadata, resolveIpfsUrl } from "@/lib/ipfs";
import { NFT_CONTRACT_ADDRESS } from "@/lib/mint-contract";
import type { PickerToken } from "@/components/market/TokenPicker";
import V3SwapPanel, { type Action } from "@/components/market/V3SwapPanel";
import VaultPlankGrid from "@/components/market/VaultPlankGrid";
import V3PriceChart from "@/components/market/V3PriceChart";
import { swrJson } from "@/lib/market/swr-fetch";

/** The LP-APR fields off /api/market/vault/stats — see the aprPct docstring
 *  in lib/market/vault-stats.ts. Only the two APR fields are needed here;
 *  everything else on this page already comes from the live getV3Snapshot
 *  read above, which has no history and so can't compute this itself. */
type VaultAprStats = {
  aprPct: number | null;
  aprBasisHours: number | null;
};

type TabKey = "vault" | "odds" | "price" | "activity" | "liquidity";

const toPicker = (ids: Set<string>): PickerToken[] =>
  Array.from(ids).sort((a, b) => Number(a) - Number(b)).map((tokenId) => ({ tokenId }));

const ACTIVITY_META: Record<V3ActivityKind, { label: string; cls: string; dir: "up" | "down" | "swap" }> = {
  buy: { label: "Buy", cls: "border-emerald-400/40 bg-emerald-500/10 text-emerald-300", dir: "down" },
  sell: { label: "Sell", cls: "border-rose-400/40 bg-rose-500/10 text-rose-300", dir: "up" },
  deposit: { label: "Deposit", cls: "border-sky-400/40 bg-sky-500/10 text-sky-300", dir: "down" },
  redeem: { label: "Redeem", cls: "border-gold-500/40 bg-gold-500/10 text-gold-300", dir: "up" },
  "lp-add": { label: "Add LP", cls: "border-violet-400/40 bg-violet-500/10 text-violet-300", dir: "swap" },
  "lp-remove": { label: "Remove LP", cls: "border-violet-400/40 bg-violet-500/10 text-violet-300", dir: "swap" },
};
const hasExplorer = /^https?:\/\//.test(CHAIN.blockExplorers.default.url) && !CHAIN.blockExplorers.default.url.includes("127.0.0.1");

function relativeTime(ts: number): string {
  if (!ts) return "";
  const s = Math.max(0, Math.floor(Date.now() / 1000) - ts);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/** The "item" column: the plank for deposit/redeem, else the fungible subject. */
function activityItem(a: V3Activity): string {
  if (a.tokenId) return `RobinWood #${a.tokenId}`;
  if (a.kind === "buy" || a.kind === "sell") return a.shares !== undefined ? `${formatUnits(a.shares, 2)} shares` : "shares";
  return "liquidity";
}
/** The "amount" column, in ETH. */
function activityAmount(a: V3Activity): string {
  return a.eth !== undefined ? `${formatUnits(a.eth, 4)} Ξ` : "—";
}

// Resolve real plank artwork by token id via the RobinWood metadata directory —
// the same source the marketplace/gallery cards use — so vault cards show real
// art (and stay consistent), even locally where the mock NFT has no tokenURI.
// Cached per id (module-level) so the 15s poll never re-fetches a resolved id.
const imgCache = new Map<string, string | null>();
async function resolvePlankImage(tokenId: string): Promise<string | undefined> {
  if (imgCache.has(tokenId)) return imgCache.get(tokenId) ?? undefined;
  try {
    const meta = await fetchNftMetadata(robinwoodTokenUri(tokenId));
    const img = meta?.image ? resolveIpfsUrl(meta.image) : undefined;
    imgCache.set(tokenId, img ?? null);
    return img;
  } catch {
    imgCache.set(tokenId, null);
    return undefined;
  }
}
async function enrichImages(tokens: PickerToken[]): Promise<PickerToken[]> {
  const out = [...tokens];
  const CONC = 6;
  for (let i = 0; i < out.length; i += CONC) {
    await Promise.all(
      out.slice(i, i + CONC).map(async (t, k) => {
        if (t.imageUrl) return;
        const img = await resolvePlankImage(t.tokenId);
        if (img) out[i + k] = { ...t, imageUrl: img };
      })
    );
  }
  return out;
}

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
        return enrichImages(j.tokens.map((t) => ({ tokenId: String(t.tokenId), imageUrl: t.imageUrl ?? undefined })));
      }
    }
  } catch {
    /* fall through to on-chain */
  }
  const ids = vault ? await getOwnedTokenIds(NFT_CONTRACT_ADDRESS, vault, { force: true }) : new Set<string>();
  return enrichImages(toPicker(ids));
}

/** The connected wallet's planks, with artwork where resolvable. */
async function fetchOwned(account?: string | null): Promise<PickerToken[]> {
  if (!account) return [];
  try {
    const inv = await getOwnedInventory(MARKET_COLLECTIONS, account);
    const items = inv.flatMap((g) => g.items).map((i) => ({ tokenId: String(i.tokenId), imageUrl: i.imageUrl || undefined }));
    if (items.length) return enrichImages(items);
  } catch {
    /* fall through to on-chain */
  }
  const ids = await getOwnedTokenIds(NFT_CONTRACT_ADDRESS, account, { force: true });
  return enrichImages(toPicker(ids));
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
  const [aprStats, setAprStats] = useState<VaultAprStats | null>(null);
  const [rescueBusy, setRescueBusy] = useState(false);
  const [rescueMsg, setRescueMsg] = useState<string | null>(null);
  // The unified tabbed panel leads with the plank grid ("In the vault").
  const [tab, setTab] = useState<TabKey>("vault");
  const [activity, setActivity] = useState<V3Activity[] | null>(null);
  const [activityLoading, setActivityLoading] = useState(false);
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
  // Picking Deposit / targeted Redeem surfaces the grid tab so you can select.
  const changeAction = useCallback((a: Action) => {
    setAction(a);
    setCart(new Set());
    if (a === "deposit" || a === "redeem") setTab("vault");
  }, []);
  const changeRedeemMode = useCallback((m: "random" | "specific") => {
    setRedeemMode(m);
    setCart(new Set());
    if (m === "specific") setTab("vault");
  }, []);

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

  // LP APR is a real event-replay figure (Bought/Sold swap volume over the
  // real observed window — see lib/market/vault-stats.ts), not something
  // getV3Snapshot's plain contract read can compute. Its own poll, separate
  // from the 15s snapshot cycle above: it changes slowly, and it must never
  // make a slow/failed history scan block the trade widget's core reads.
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    const fetchApr = () => {
      const url = vaultAddress
        ? `/api/market/vault/stats?vault=${encodeURIComponent(vaultAddress)}`
        : "/api/market/vault/stats";
      swrJson<VaultAprStats | null>(url, { ttlMs: 20_000 })
        .then((s) => {
          if (!cancelled) setAprStats(s ? { aprPct: s.aprPct, aprBasisHours: s.aprBasisHours } : null);
        })
        .catch(() => {
          /* keep last good value on a transient failure */
        });
    };
    fetchApr();
    const stop = startVisibleInterval(fetchApr, 30_000);
    return () => {
      cancelled = true;
      stop();
    };
  }, [vaultAddress, active]);

  // Lazy-load the activity feed the first time the tab is opened, resolving a
  // plank thumbnail for each deposit/redeem row.
  useEffect(() => {
    if (tab !== "activity" || activity !== null || activityLoading) return;
    setActivityLoading(true);
    getV3Activity(vaultAddress)
      .then(async (rows) =>
        Promise.all(
          rows.map(async (r) =>
            (r.kind === "deposit" || r.kind === "redeem") && r.tokenId
              ? { ...r, image: await resolvePlankImage(r.tokenId) }
              : r
          )
        )
      )
      .then(setActivity)
      .catch(() => setActivity([]))
      .finally(() => setActivityLoading(false));
  }, [tab, activity, activityLoading, vaultAddress]);

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
        console.error("V3 rescue action failed:", e);
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
  // Pool TVL in ETH: the ETH side plus the share side valued at the spot price.
  const tvl = snap ? snap.ethReserve + (snap.shareReserve * sharePrice) / SHARE_UNIT : BigInt(0);
  const lockedLp = snap ? snap.lockedLp : BigInt(0);
  const explorer = (kind: "address" | "tx", v: string) => `${CHAIN.blockExplorers.default.url}/${kind}/${v}`;
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
              {rescueMsg && (
                <p role="alert" className="mt-2 text-[0.72rem] text-rose-200">
                  {rescueMsg}
                </p>
              )}
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
                <b className="text-gold-300">You hold value in an older pool.</b> Driftwood &amp; WormWood are winding down — move it to Premium Plank Liquidity.
              </span>
              <span className="inline-flex min-h-[40px] flex-none items-center rounded-lg bg-gold-500 px-4 text-sm font-black text-[#261105]">Migrate now →</span>
            </Link>
          )}
        </div>
      ) : null}

      {/* header: vault identity + status */}
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="font-display text-2xl text-gold-300">RobinWood Vault</h2>
        <span className="font-mono text-[0.7rem] text-cream-muted">{snap ? shortVault(snap.address) : "…"}</span>
        {snap && (
          <span className={`text-[0.72rem] font-bold ${snap.poolOpen ? "text-emerald-400" : "text-amber-400"}`}>● {snap.poolOpen ? "Open" : "Closed"}</span>
        )}
      </div>

      {/* NFTX-style stat row */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-7">
        <BigStat label="TVL" value={snap ? `${formatUnits(tvl, 3)} Ξ` : "—"} />
        <BigStat label="Circulating supply" value={snap ? formatUnits(snap.totalSupply, 2) : "—"} sub="vROBIN" />
        <BigStat label="Swap fee" value={snap ? `${(snap.swapFeeBps / 100).toFixed(2)}%` : "—"} />
        <BigStat label="Floor / share" value={snap ? `${formatUnits(sharePrice, 5)} Ξ` : "—"} />
        <BigStat label="NFTs in vault" value={snap ? String(snap.held) : "—"} />
        <BigStat label="Available" value={snap ? String(snap.availableCount) : "—"} sub="redeemable" />
        {/* LP yield from real swap volume — never mint/redeem fee revenue,
            which pays the treasury, not LPs (see the aprPct docstring in
            lib/market/vault-stats.ts). The basis in the label is whatever
            window was actually measured, never an asserted 24h — a thin
            window (e.g. "3.1h basis") should read as thin, not as a
            steady-state rate. "—" means there isn't enough swap history
            yet, not a broken read; this is the number an LP decides on, so
            it only ever shows a real measured figure. */}
        <BigStat
          label={
            aprStats?.aprPct != null && aprStats.aprBasisHours != null
              ? `LP APR (${aprStats.aprBasisHours.toFixed(1)}h basis)`
              : "LP APR"
          }
          value={aprStats?.aprPct != null ? `${aprStats.aprPct >= 1000 ? aprStats.aprPct.toFixed(0) : aprStats.aprPct.toFixed(1)}%` : "—"}
          sub={aprStats?.aprPct != null ? "swap fees" : "not enough trading history yet"}
        />
      </div>

      {/* hero: trade widget + vault info dock left, the tabbed panel fills right */}
      <div className="grid items-start gap-4 lg:grid-cols-[360px_minmax(0,1fr)] xl:grid-cols-[400px_minmax(0,1fr)]">
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

          {/* Vault info */}
          <div className="rounded-xl border border-line bg-panel-strong p-4">
            <h3 className="text-[0.7rem] font-black uppercase tracking-wide text-cream">Vault info</h3>
            <dl className="mt-2 space-y-1.5 text-[0.72rem]">
              <InfoRow label="Token standard" value="ERC-20 shares · ERC-721 planks" />
              <InfoRow label="Vault" value={snap ? shortVault(snap.address) : "…"} href={snap && hasExplorer ? explorer("address", snap.address) : undefined} />
              <InfoRow label="Collection" value={shortVault(NFT_CONTRACT_ADDRESS)} href={hasExplorer ? explorer("address", NFT_CONTRACT_ADDRESS) : undefined} />
              <InfoRow label="Swap fee" value={snap ? `${(snap.swapFeeBps / 100).toFixed(2)}% → LPs` : "…"} />
              <InfoRow label="Deposit / redeem" value={snap ? `${formatUnits(snap.mintFeeWei)} Ξ → treasury` : "…"} />
            </dl>
          </div>
        </div>

        {/* unified tabbed panel: In the vault + Odds + Price + Activity + Liquidity */}
        <div className="overflow-hidden rounded-xl border border-line bg-panel-strong">
          <div className="flex flex-wrap gap-1 border-b border-line bg-wood-950/60 p-1.5">
            {([["vault", "In the vault"], ["odds", "Redeem odds"], ["price", "Price"], ["activity", "Activity"], ["liquidity", "Liquidity"]] as [TabKey, string][]).map(([id, label]) => (
              <button key={id} type="button" onClick={() => setTab(id)} aria-pressed={tab === id} className={`min-h-11 rounded-lg px-3.5 py-2 text-[0.72rem] font-black ${tab === id ? "bg-gold-500/15 text-gold-300" : "text-cream-muted hover:text-cream"}`}>{label}</button>
            ))}
          </div>
          <div className="p-4">
            {tab === "vault" && (
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
            )}
          {tab === "odds" && (
            <p className="text-[0.78rem] text-cream-muted">
              A random redeem draws uniformly from the {snap?.availableCount ?? 0} available planks
              {snap && snap.pendingRedeemCount > 0 ? ` (${snap.pendingRedeemCount} reserved for an in-flight redeem)` : ""} — each currently has a{" "}
              <b className="text-cream">{snap && snap.availableCount > 0 ? (100 / snap.availableCount).toFixed(1) : "—"}%</b> chance. Rarity-tier odds populate from the rarity snapshot on mainnet.
            </p>
          )}
          {tab === "price" && <V3PriceChart vaultAddress={vaultAddress} currentPrice={sharePrice} />}
          {tab === "activity" && (
            activityLoading && activity === null ? (
              <div className="flex min-h-[3.5rem] items-center rounded-lg border border-line bg-wood-950 px-3 text-[0.78rem] text-cream-muted">Loading recent activity…</div>
            ) : activity && activity.length > 0 ? (
              <div className="-mx-4 overflow-x-auto">
                <table className="w-full min-w-[560px] text-left text-[0.78rem]">
                  <thead>
                    <tr className="border-b border-line text-[0.6rem] font-black uppercase tracking-wide text-cream-muted">
                      <th className="px-4 py-2 font-black">Type</th>
                      <th className="px-2 py-2 font-black">NFT</th>
                      <th className="px-2 py-2 font-black">Amount</th>
                      <th className="px-2 py-2 font-black">From</th>
                      <th className="px-2 py-2 font-black">Time</th>
                      <th className="px-4 py-2 text-right font-black">Tx</th>
                    </tr>
                  </thead>
                  <tbody>
                    {activity.map((a) => {
                      const m = ACTIVITY_META[a.kind];
                      return (
                        <tr key={a.key} className="border-b border-line/50 last:border-0">
                          <td className="px-4 py-2">
                            <span className={`inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[0.6rem] font-black uppercase tracking-wide ${m.cls}`}>
                              {m.dir === "up" ? <ArrowUp size={11} strokeWidth={3} /> : m.dir === "down" ? <ArrowDown size={11} strokeWidth={3} /> : <ArrowLeftRight size={11} strokeWidth={3} />}
                              {m.label}
                            </span>
                          </td>
                          <td className="px-2 py-2">
                            <span className="inline-flex items-center gap-1.5">
                              {a.image && (
                                // eslint-disable-next-line @next/next/no-img-element
                                <img src={a.image} alt="" className="h-6 w-6 rounded object-cover" />
                              )}
                              <span className="text-cream">{activityItem(a)}</span>
                            </span>
                          </td>
                          <td className="px-2 py-2 tabular-nums text-cream">{activityAmount(a)}</td>
                          <td className="px-2 py-2 font-mono text-[0.72rem] text-cream-muted">{a.who}</td>
                          <td className="px-2 py-2 whitespace-nowrap text-[0.72rem] text-cream-muted">{relativeTime(a.ts) || `#${a.block}`}</td>
                          <td className="px-4 py-2 text-right">
                            {hasExplorer ? (
                              <a href={`${CHAIN.blockExplorers.default.url}/tx/${a.tx}`} target="_blank" rel="noreferrer" className="inline-flex text-cream-muted hover:text-gold-300" aria-label="View transaction">
                                <ExternalLink size={13} />
                              </a>
                            ) : (
                              <span className="font-mono text-[0.66rem] text-cream/30">{a.tx.slice(0, 6)}…</span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="flex min-h-[3.5rem] items-center rounded-lg border border-line bg-wood-950 px-3 text-[0.78rem] text-cream-muted">
                No activity yet — buys, sells, deposits and redeems show here once the vault sees trades.
              </div>
            )
          )}
          {tab === "liquidity" && snap && (() => {
            const hasLp = snap.lpBalance > BigInt(0);
            const under = quoteRemoveLiquidity(snap.lpBalance, snap);
            return (
              <div className="space-y-4">
                {/* Your liquidity position */}
                <div className="rounded-lg border border-line bg-wood-950 p-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h4 className="text-[0.72rem] font-black uppercase tracking-wide text-cream">Your liquidity</h4>
                    <button
                      type="button"
                      onClick={() => setAction("lp")}
                      className="min-h-9 rounded-lg bg-gold-500 px-3.5 text-[0.72rem] font-black text-[#261105]"
                    >
                      {hasLp ? "Add / remove →" : "Provide liquidity →"}
                    </button>
                  </div>
                  {hasLp ? (
                    <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
                      <Tile label="Your LP" value={formatUnits(snap.lpBalance, 3)} size="lg" tone="ok" />
                      <Tile label="Pool share" value={`${poolShare}%`} size="lg" tone="ok" note="of the pool" />
                      <Tile label="≈ ETH" value={`${formatUnits(under.ethOut, 4)} Ξ`} size="lg" tone="gold" note="on withdraw" />
                      <Tile label="≈ Shares" value={formatUnits(under.sharesOut, 2)} size="lg" tone="gold" note="on withdraw" />
                    </div>
                  ) : (
                    <p className="mt-2 text-[0.78rem] text-cream-muted">
                      You have no liquidity here. Provide ETH (shares are pulled to match) to earn the{" "}
                      <b className="text-emerald-300">{(snap.swapFeeBps / 100).toFixed(2)}% swap fee</b> on every buy and sell, proportional to your share.
                    </p>
                  )}
                </div>

                {/* Pool composition */}
                <div>
                  <h4 className="mb-2 text-[0.72rem] font-black uppercase tracking-wide text-cream">Pool</h4>
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                    <Tile label="TVL" value={`${formatUnits(tvl, 3)} Ξ`} size="sm" tone="neutral" />
                    <Tile label="Pool ETH" value={`${formatUnits(snap.ethReserve, 3)} Ξ`} size="sm" tone="neutral" />
                    <Tile label="Pool shares" value={formatUnits(snap.shareReserve, 2)} size="sm" tone="neutral" />
                    <Tile label="Total LP" value={formatUnits(snap.totalLpSupply, 3)} size="sm" tone="neutral" />
                    <Tile label="Locked seed LP" value={formatUnits(lockedLp, 3)} size="sm" tone="neutral" note="never withdrawable" />
                    <Tile label="Accrued fees" value={`${formatUnits(snap.accruedFees, 4)} Ξ`} size="sm" tone="neutral" note="to treasury" />
                  </div>
                </div>

                <p className="text-[0.72rem] text-cream/55">
                  LP is proportional (Uniswap-V2 style): you always withdraw your exact share of the current ETH + share
                  reserves. The {(snap.swapFeeBps / 100).toFixed(2)}% swap fee stays in the pool, growing every LP unit; the
                  locked seed position earns fees too but can never be withdrawn, so it dilutes no one.
                </p>
              </div>
            );
          })()}
          </div>
        </div>
      </div>
    </section>
  );
}

/** A prominent vault stat for the NFTX-style stat row (big value, small label). */
function BigStat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-xl border border-line bg-panel-strong px-3 py-2.5">
      <div className="text-[0.56rem] font-black uppercase tracking-wide text-cream-muted">{label}</div>
      <div className="font-mono text-xl font-black tabular-nums text-cream">{value}</div>
      {sub && <div className="text-[0.56rem] text-cream/45">{sub}</div>}
    </div>
  );
}

/** A label/value row for the Vault info panel; value links out when href given. */
function InfoRow({ label, value, href }: { label: string; value: string; href?: string }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <dt className="text-cream-muted">{label}</dt>
      {href ? (
        <a href={href} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-mono tabular-nums text-gold-300 hover:underline">
          {value}
          <ExternalLink size={11} />
        </a>
      ) : (
        <dd className="font-mono tabular-nums text-cream">{value}</dd>
      )}
    </div>
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

