"use client";

import { useEffect, useMemo, useState } from "react";
import { Check, X } from "lucide-react";
import { parseTokenAmount, formatTokenAmount } from "@/lib/trade";
import { MARKETPLANK_NATIVE_LISTING_FEE_BPS } from "@/lib/constants";
import { chainDisplayName, foreignChainByChainSlug, foreignRpcUrls, FOREIGN_SEAPORT_ADDRESS } from "@/lib/market/multichain/trading/foreign-chain-registry";
import type { MarketCollection } from "@/lib/market/types";
import {
  itemKey,
  listBulkItems,
  resolveBulkPrices,
  type BulkItemStatus,
  type BulkListDeps,
  type PricingMode,
  type SelectedItem,
} from "@/lib/market/bulk-list";
import EthUsdValue from "@/components/market/EthUsdValue";
import { ensureChain } from "@/lib/wallet";
import { buildListing, type SeaportChain } from "@/lib/market/seaport";

type OwnedItem = { tokenId: string; name: string | null; imageUrl: string | null };

type Props = {
  chainSlug: string;
  currencySymbol: string;
  account: string | null;
  collection: MarketCollection;
  ownedItems: OwnedItem[];
  ownedLoading: boolean;
  onListed: () => void;
  onConnect: () => void;
  /**
   * The collection's real current floor, computed by the parent from the
   * SAME live listings array the Buy&Sell tab already fetches (see
   * MultichainCollectionView.tsx's own floorWei) -- never re-derived here,
   * so this can never drift from what a buyer actually sees as the floor.
   * Null when there are no active listings to derive a floor from yet.
   */
  floorWei: string | null;
  /** Set by My Listings' "Relist" button -- pre-selects this item and its
   * current price, one time, then the parent clears it via onRelistConsumed. */
  relistPreset: { tokenId: string; priceWei: string } | null;
  onRelistConsumed: () => void;
};

/** Real presets real bulk listers actually use (per this session's research pass: "list at floor ±X%" is the standard pricing pattern on every real competitor). */
const FLOOR_PRESETS = [
  { label: "Floor", pct: 0 },
  { label: "Floor -5%", pct: -5 },
  { label: "Floor +5%", pct: 5 },
  { label: "Floor +10%", pct: 10 },
];

const DURATIONS = [
  { label: "1 day", days: 1 },
  { label: "7 days", days: 7 },
  { label: "30 days", days: 30 },
];

const STATE_LABEL: Record<BulkItemStatus["state"], string> = {
  pending: "Waiting",
  signing: "Sign in wallet…",
  publishing: "Publishing…",
  listed: "Listed ✓",
  failed: "Failed",
  skipped: "Skipped",
};

/**
 * List owned items for sale DIRECTLY with Marketplank on a foreign EVM
 * chain -- no OpenSea, no Magic Eden, no UniSat. Same underlying mechanism
 * as Robinhood Chain's own native bulk listing (MyInventory.tsx): every
 * order is built by the SAME lib/market/seaport.ts buildListing() and
 * shares lib/market/bulk-list.ts's resolveBulkPrices/itemKey/listBulkItems
 * completely unchanged (reused, not reimplemented -- see that file's own
 * header on why bulk EIP-712 signing is deliberately not used: N items = N
 * signatures). This component ONLY supplies chain-aware `deps` closures;
 * bulk-list.ts itself has zero chain-awareness added to it, so the
 * Robinhood-chain flow it already serves carries zero risk from this file.
 *
 * Always posts MARKETPLANK_NATIVE_LISTING_FEE_BPS (1.8%), never the passed
 * -in collection.feeBps, which MultichainCollectionView.tsx deliberately
 * zeroes for foreign collections. Royalty is 0 for the same reason
 * app/api/market/multichain/native-orders/route.ts's server-side check
 * starts at 0 -- no real per-chain EIP-2981 data exists yet for a
 * collection Marketplank doesn't curate.
 */
export default function NativeForeignListForm({
  chainSlug,
  currencySymbol,
  account,
  collection,
  ownedItems,
  ownedLoading,
  onListed,
  onConnect,
  floorWei,
  relistPreset,
  onRelistConsumed,
}: Props) {
  const [selected, setSelected] = useState<Map<string, SelectedItem>>(new Map());
  const [mode, setMode] = useState<PricingMode>("same");
  const [samePrice, setSamePrice] = useState("");
  const [perItemPrices, setPerItemPrices] = useState<Record<string, string>>({});
  const [days, setDays] = useState(7);
  const [busy, setBusy] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [statuses, setStatuses] = useState<BulkItemStatus[] | null>(null);

  // One-click relist: pre-select the item + pre-fill its current price,
  // once, the moment a preset arrives -- then tell the parent to clear it
  // so switching away and back to this tab doesn't keep re-applying it.
  useEffect(() => {
    if (!relistPreset) return;
    setSelected(new Map([[`${collection.slug}:${relistPreset.tokenId}`, { collection, tokenId: relistPreset.tokenId }]]));
    setMode("same");
    setSamePrice(formatTokenAmount(relistPreset.priceWei, 18, 6));
    onRelistConsumed();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- collection/onRelistConsumed are stable for the lifetime this effect cares about; only relistPreset should re-trigger it.
  }, [relistPreset]);

  const feePct = MARKETPLANK_NATIVE_LISTING_FEE_BPS / 100;
  const selectedItems = useMemo(() => Array.from(selected.values()), [selected]);

  const toggle = (tokenId: string) => {
    if (busy) return;
    const key = `${collection.slug}:${tokenId}`;
    setSelected((prev) => {
      const next = new Map(prev);
      if (next.has(key)) next.delete(key);
      else next.set(key, { collection, tokenId });
      return next;
    });
    setStatuses(null);
    setError(null);
  };

  /** Live gross-total preview, same formula as MyInventory.tsx's totalPreview. */
  const totalWei = useMemo(() => {
    if (selectedItems.length === 0) return null;
    if (mode === "same") {
      const wei = parseTokenAmount(samePrice, 18);
      if (wei === null || wei <= 0n) return null;
      return wei * BigInt(selectedItems.length);
    }
    let sum = 0n;
    for (const item of selectedItems) {
      const wei = parseTokenAmount(perItemPrices[itemKey(item)] ?? "", 18);
      if (wei === null || wei <= 0n) return null;
      sum += wei;
    }
    return sum;
  }, [mode, samePrice, perItemPrices, selectedItems]);
  const totalFeeWei = totalWei !== null ? (totalWei * BigInt(MARKETPLANK_NATIVE_LISTING_FEE_BPS)) / 10_000n : null;
  const totalNetWei = totalWei !== null && totalFeeWei !== null ? totalWei - totalFeeWei : null;

  function seaportChain(): SeaportChain {
    const target = foreignChainByChainSlug(chainSlug);
    if (!target) throw new Error(`"${chainSlug}" is not a supported foreign chain.`);
    return {
      chainSlug,
      chainId: target.chainId,
      chainName: chainDisplayName(chainSlug),
      nativeCurrencySymbol: target.nativeCurrencySymbol,
      rpcUrl: foreignRpcUrls(chainSlug)[0],
      blockExplorerUrl: target.blockExplorerUrl,
      seaportAddress: FOREIGN_SEAPORT_ADDRESS,
    };
  }

  const submit = async () => {
    if (!account) return;
    setError(null);
    const priced = resolveBulkPrices(mode, samePrice, perItemPrices, selectedItems);
    if (!priced.ok) {
      setError(priced.error);
      return;
    }
    try {
      setBusy(true);
      const chain = seaportChain();
      // Assert chain ID once, up front, before the signing loop -- same
      // placement foreign-fulfill.ts's connectedRouter() uses. Nothing
      // between signatures below lets the wallet silently change chains
      // mid-loop (each buildListing call re-derives from the connected
      // provider, but the wallet's OWN chain doesn't change on its own
      // between prompts -- the same guarantee the Robinhood-chain bulk
      // flow already relies on here).
      await ensureChain({
        chainId: chain.chainId,
        name: chain.chainName,
        nativeCurrencySymbol: chain.nativeCurrencySymbol,
        rpcUrl: chain.rpcUrl,
        blockExplorerUrl: chain.blockExplorerUrl,
      });

      const deps: BulkListDeps = {
        // input.feeBps/royaltyBps/royaltyRecipient already come from
        // `collection` (see makeListingInput in bulk-list.ts), which this
        // component's parent always constructs with feeBps:
        // MARKETPLANK_NATIVE_LISTING_FEE_BPS and royaltyBps: 0 (see
        // MultichainCollectionView.tsx) -- chain is the only thing this
        // closure adds.
        buildListing: (acc, input) => buildListing(acc, input, chain),
        // bulk-list.ts's makeListingPostBody builds a Robinhood-shaped body
        // (collectionSlug/tokenId/maker/priceWei/expiresAt/rawOrder) meant
        // for /api/market/orders -- deliberately NOT changed, so this
        // closure reads only body.rawOrder out of it and posts the real
        // shape app/api/market/multichain/native-orders/route.ts expects.
        postOrder: async (body) => {
          const res = await fetch("/api/market/multichain/native-orders", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              chainSlug,
              kind: "listing",
              contractAddress: collection.contractAddress,
              rawOrder: body.rawOrder,
            }),
          });
          const data = (await res.json().catch(() => ({}))) as { message?: string };
          return { ok: res.ok, message: data.message };
        },
      };

      const result = await listBulkItems(account, selectedItems, priced.prices, days, deps, setStatuses);
      const listed = result.filter((s) => s.state === "listed");
      if (listed.length > 0) {
        setSelected((prev) => {
          const next = new Map(prev);
          for (const s of listed) next.delete(s.key);
          return next;
        });
        onListed();
      }
      if (listed.length === result.length) {
        setSamePrice("");
        setPerItemPrices({});
      }
    } catch (e) {
      console.error("Native foreign bulk listing failed:", e);
      setError(e instanceof Error ? e.message : "Listing failed.");
    } finally {
      setBusy(false);
    }
  };

  const openReview = () => {
    setError(null);
    if (!account) {
      onConnect();
      return;
    }
    const priced = resolveBulkPrices(mode, samePrice, perItemPrices, selectedItems);
    if (!priced.ok) {
      setError(priced.error);
      return;
    }
    setReviewOpen(true);
  };

  return (
    <div className="space-y-3">
      <div>
        <h3 className="font-display text-lg text-gold-300">List directly with Marketplank</h3>
        <p className="text-[0.65rem] text-foreground/55">
          {feePct}% Marketplank fee -- no OpenSea, no Magic Eden, no UniSat. Any buyer fulfills your order straight
          against Seaport, the same canonical contract those marketplaces use. Select as many items as you want to
          list at once -- each is still its own independently cancellable signed order (one wallet prompt per item).
        </p>
        <p className="mt-1 text-[0.6rem] text-foreground/40">
          {feePct}% is fixed and baked into every order at signing -- it can't change on you after you've listed.
        </p>
      </div>

      {ownedLoading ? (
        <p className="text-center text-xs text-foreground/45">Loading what you own on {chainDisplayName(chainSlug)}…</p>
      ) : ownedItems.length === 0 ? (
        <p className="text-center text-xs text-foreground/45">
          You don't own any {collection.name} on {chainDisplayName(chainSlug)} yet.
        </p>
      ) : (
        <ul className="grid grid-cols-[repeat(auto-fill,minmax(100px,1fr))] gap-2">
          {ownedItems.map((item) => {
            const key = `${collection.slug}:${item.tokenId}`;
            const isSelected = selected.has(key);
            return (
              <li
                key={item.tokenId}
                className={`dense-card flex flex-col overflow-hidden p-0 transition-[transform,border-color] duration-150 hover:-translate-y-0.5 hover:border-line-strong ${
                  isSelected ? "ring-2 ring-gold-400" : ""
                }`}
              >
                <button
                  type="button"
                  disabled={busy}
                  aria-pressed={isSelected}
                  aria-label={`${isSelected ? "Deselect" : "Select"} #${item.tokenId}`}
                  onClick={() => toggle(item.tokenId)}
                  title={item.name ?? `#${item.tokenId}`}
                  className="relative block aspect-square w-full cursor-pointer bg-wood-900 bg-cover bg-center outline-none transition focus-visible:ring-2 focus-visible:ring-gold-400/60"
                  style={item.imageUrl ? { backgroundImage: `url(${item.imageUrl})` } : undefined}
                >
                  {!item.imageUrl && <span className="flex h-full items-center justify-center text-[0.6rem] font-bold text-foreground/60">#{item.tokenId}</span>}
                  {isSelected && (
                    <span className="card-overlay absolute right-1.5 top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-gold-500 text-wood-950">
                      <Check size={12} strokeWidth={3} />
                    </span>
                  )}
                </button>
                <div className="flex flex-1 flex-col gap-0.5 p-1.5 leading-tight">
                  <span className="truncate text-[0.55rem] font-bold text-foreground" title={item.name ?? `#${item.tokenId}`}>
                    {item.name ?? `#${item.tokenId}`}
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {selectedItems.length > 0 && (
        <div className="wood-ledger space-y-3 rounded-xl border border-line p-3">
          {reviewOpen && (
            <div className="fixed inset-0 z-[80] flex items-end justify-center bg-black/70 sm:items-center sm:p-4" role="dialog" aria-modal="true" aria-labelledby="native-list-review-title">
              <div className="wood-ledger w-full max-w-lg rounded-t-xl border border-line-strong p-4 sm:rounded-xl">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <p className="text-[0.65rem] font-black uppercase tracking-[0.14em] text-gold-300/75">Verify before signing</p>
                    <h3 id="native-list-review-title" className="mt-1 font-display text-2xl text-gold-300">
                      Review {selectedItems.length} listing{selectedItems.length > 1 ? "s" : ""}
                    </h3>
                  </div>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => setReviewOpen(false)}
                    className="flex h-10 w-10 items-center justify-center rounded-md border border-line text-foreground/65 hover:text-gold-300 disabled:opacity-40"
                    aria-label="Close review"
                  >
                    <X size={14} strokeWidth={2.5} />
                  </button>
                </div>

                <dl className="mt-4 grid grid-cols-2 gap-2">
                  <div className="rounded-lg border border-line bg-wood-950 px-3 py-2">
                    <dt className="text-[0.57rem] font-black uppercase tracking-[0.06em] text-cream-muted">Items</dt>
                    <dd className="mt-1 text-xs font-bold text-foreground">{selectedItems.length}</dd>
                  </div>
                  <div className="rounded-lg border border-line bg-wood-950 px-3 py-2">
                    <dt className="text-[0.57rem] font-black uppercase tracking-[0.06em] text-cream-muted">Wallet signatures</dt>
                    <dd className="mt-1 text-xs font-bold text-foreground">{selectedItems.length}</dd>
                  </div>
                  <div className="rounded-lg border border-line bg-wood-950 px-3 py-2">
                    <dt className="text-[0.57rem] font-black uppercase tracking-[0.06em] text-cream-muted">Total ask</dt>
                    <dd className="mt-1 text-xs font-bold text-foreground">
                      <span className="block">{totalWei !== null ? formatTokenAmount(totalWei.toString(), 18, 5) : "—"} {currencySymbol}</span>
                      <EthUsdValue wei={totalWei} className="mt-0.5 block text-[0.65rem] text-foreground/50" />
                    </dd>
                  </div>
                  <div className="rounded-lg border border-line bg-wood-950 px-3 py-2">
                    <dt className="text-[0.57rem] font-black uppercase tracking-[0.06em] text-cream-muted">Marketplank fee</dt>
                    <dd className="mt-1 text-xs font-bold text-foreground">
                      {feePct}% · {totalFeeWei !== null ? formatTokenAmount(totalFeeWei.toString(), 18, 5) : "—"} {currencySymbol}
                    </dd>
                  </div>
                  <div className="col-span-2 rounded-lg border border-line bg-wood-950 px-3 py-2">
                    <dt className="text-[0.57rem] font-black uppercase tracking-[0.06em] text-cream-muted">You receive (total)</dt>
                    <dd className="mt-1 text-xs font-bold text-foreground">
                      {totalNetWei !== null ? formatTokenAmount(totalNetWei.toString(), 18, 5) : "—"} {currencySymbol}
                    </dd>
                  </div>
                  <div className="rounded-lg border border-line bg-wood-950 px-3 py-2">
                    <dt className="text-[0.57rem] font-black uppercase tracking-[0.06em] text-cream-muted">Creator royalty</dt>
                    <dd className="mt-1 text-xs font-bold text-foreground">
                      0% -- not yet supported for this collection
                    </dd>
                  </div>
                  <div className="rounded-lg border border-line bg-wood-950 px-3 py-2">
                    <dt className="text-[0.57rem] font-black uppercase tracking-[0.06em] text-cream-muted">Chain</dt>
                    <dd className="mt-1 text-xs font-bold text-foreground">{chainDisplayName(chainSlug)} · Seaport 1.6 · {days} days</dd>
                  </div>
                </dl>

                <p className="mt-3 text-xs leading-5 text-foreground/55">
                  Each item creates its own independently cancellable order, direct with Marketplank -- not an OpenSea
                  order. Only you can accept a buyer's transaction; Marketplank never holds your NFTs or your proceeds.
                  Price, expiry, and ownership are checked before each signature and again by the server before
                  publishing.
                </p>

                {error && (
                  <p role="alert" className="mt-3 rounded-lg border border-red-500/35 bg-red-950/25 px-3 py-2.5 text-sm text-red-100">
                    {error}
                  </p>
                )}

                <div className="mt-4 grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      setError(null);
                      setReviewOpen(false);
                    }}
                    className="min-h-11 rounded-lg border border-line text-sm text-foreground/75 hover:text-gold-300 disabled:opacity-40"
                  >
                    Back
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      setReviewOpen(false);
                      void submit();
                    }}
                    className="min-h-11 rounded-lg bg-gold-500 text-sm font-bold text-wood-950 hover:bg-gold-400 disabled:opacity-50"
                  >
                    {busy ? "Confirm in wallet…" : "Continue to wallet"}
                  </button>
                </div>
              </div>
            </div>
          )}

          <div className="flex items-center justify-between">
            <p className="text-sm font-bold text-foreground">
              List {selectedItems.length} item{selectedItems.length > 1 ? "s" : ""}
            </p>
            <div className="flex gap-1.5" role="radiogroup" aria-label="Pricing mode">
              {(
                [
                  { id: "same", label: "Same price" },
                  { id: "per-item", label: "Price each" },
                ] as const
              ).map((m) => (
                <button
                  key={m.id}
                  type="button"
                  role="radio"
                  aria-checked={mode === m.id}
                  disabled={busy}
                  onClick={() => setMode(m.id)}
                  className={`min-h-9 rounded-md border px-2.5 text-xs font-bold transition ${
                    mode === m.id ? "border-gold-400 bg-gold-500/15 text-gold-300" : "border-line text-foreground/60 hover:border-gold-400"
                  }`}
                >
                  {m.label}
                </button>
              ))}
            </div>
          </div>

          {mode === "same" ? (
            <div className="space-y-1.5">
              {floorWei && (
                <div className="flex flex-wrap gap-1.5" role="group" aria-label="Price relative to floor">
                  {FLOOR_PRESETS.map((preset) => (
                    <button
                      key={preset.label}
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        // pct as an integer bps offset avoids float drift on
                        // a real wei-precision amount -- same fixed-point
                        // discipline this session's adapters use elsewhere
                        // (e.g. alchemy-nft.ts's toWeiString).
                        const bps = 10_000 + preset.pct * 100;
                        const priced = (BigInt(floorWei) * BigInt(bps)) / 10_000n;
                        setSamePrice(formatTokenAmount(priced.toString(), 18, 6));
                      }}
                      className="min-h-8 rounded-md border border-line-strong px-2.5 text-[0.65rem] font-bold text-gold-300 transition hover:border-gold-400 disabled:opacity-40"
                    >
                      {preset.label}
                    </button>
                  ))}
                </div>
              )}
              <label className="block">
                <span className="text-[0.65rem] font-bold uppercase tracking-wider text-foreground/50">Price per item ({currencySymbol})</span>
                <input
                  type="text"
                  inputMode="decimal"
                  placeholder="0.0"
                  value={samePrice}
                  disabled={busy}
                  onChange={(e) => setSamePrice(e.target.value.replace(/[^0-9.]/g, ""))}
                  className="mt-1 min-h-11 w-full rounded-lg border border-line bg-panel px-2.5 text-foreground outline-none focus:border-gold-400"
                />
              </label>
              {floorWei && (
                <p className="text-[0.6rem] text-foreground/45">
                  Current floor: {formatTokenAmount(floorWei, 18, 5)} {currencySymbol}
                </p>
              )}
            </div>
          ) : (
            <ul className="space-y-1.5">
              {selectedItems.map((item) => {
                const key = itemKey(item);
                return (
                  <li key={key} className="flex items-center gap-2">
                    <span className="w-16 shrink-0 text-xs font-bold text-foreground">#{item.tokenId}</span>
                    <input
                      type="text"
                      inputMode="decimal"
                      placeholder="0.0"
                      aria-label={`Price for #${item.tokenId} in ${currencySymbol}`}
                      value={perItemPrices[key] ?? ""}
                      disabled={busy}
                      onChange={(e) =>
                        setPerItemPrices((prev) => ({ ...prev, [key]: e.target.value.replace(/[^0-9.]/g, "") }))
                      }
                      className="min-h-10 w-full rounded-lg border border-line bg-panel px-2.5 text-sm text-foreground outline-none focus:border-gold-400"
                    />
                  </li>
                );
              })}
            </ul>
          )}

          <div className="flex items-center gap-2">
            <label className="flex-1">
              <span className="text-[0.65rem] font-bold uppercase tracking-wider text-foreground/50">Expires</span>
              <select
                value={days}
                disabled={busy}
                onChange={(e) => setDays(Number(e.target.value))}
                className="mt-1 min-h-11 w-full rounded-lg border border-line bg-panel px-2.5 text-foreground"
              >
                {DURATIONS.map((d) => (
                  <option key={d.days} value={d.days}>
                    {d.label}
                  </option>
                ))}
              </select>
            </label>
            {totalWei !== null && (
              <p className="text-xs text-foreground/60">
                Total ask <span className="font-display text-gold-300">{formatTokenAmount(totalWei.toString(), 18, 5)} {currencySymbol}</span>
              </p>
            )}
          </div>

          <p className="text-center text-[0.6rem] text-foreground/40">
            {feePct}% Marketplank fee included in each signed order. Your wallet will ask for {selectedItems.length}{" "}
            signature{selectedItems.length > 1 ? "s" : ""}, one per item.
          </p>

          <button
            type="button"
            disabled={busy}
            onClick={openReview}
            className="min-h-12 w-full rounded-lg bg-gold-500 text-sm font-bold text-wood-950 transition hover:bg-gold-400 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy ? "Listing…" : !account ? "Connect to list" : `Review ${selectedItems.length} listing${selectedItems.length > 1 ? "s" : ""}`}
          </button>

          {error && (
            <p className="text-center text-xs text-red-300" role="alert">
              {error}
            </p>
          )}
        </div>
      )}

      {statuses && (
        <ul className="wood-ledger overflow-hidden" aria-label="Listing progress">
          {statuses.map((s) => (
            <li key={s.key} className="flex items-center justify-between gap-3 border-t border-line px-3 py-2 first:border-t-0">
              <span className="text-xs font-bold text-foreground">#{s.tokenId}</span>
              <span className={`text-xs ${s.state === "listed" ? "text-emerald-300" : s.state === "failed" ? "text-red-300" : "text-foreground/60"}`}>
                {STATE_LABEL[s.state]}
                {s.error ? ` — ${s.error}` : ""}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
