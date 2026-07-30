"use client";

import Image from "next/image";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  itemKey,
  listBulkItems,
  resolveBulkPrices,
  defaultPostOrder,
  type BulkItemStatus,
  type PricingMode,
  type SelectedItem,
} from "@/lib/market/bulk-list";
import { getOwnedInventory, type OwnedInventory } from "@/lib/market/inventory";
import { buildListing } from "@/lib/market/seaport";
import { formatTokenAmount, parseTokenAmount } from "@/lib/trade";
import {
  getRarityMap,
  tierAnimationClass,
  tierCardStyle,
  tierColor,
  tierGlow,
} from "@/lib/market/rarityClient";
import type { RarityLookup } from "@/lib/market/rarityClient";
import type { MarketCollection } from "@/lib/market/types";
import { withImageWidth } from "@/lib/ipfs";

type Props = {
  account: string;
  collections: MarketCollection[];
  /** `${slug}:${tokenId}` keys already listed by this wallet — shown as
   * "Listed" and not selectable, so you can't double-list a plank. */
  alreadyListed: Set<string>;
  onListed: () => void;
};

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
 * Browse the connected wallet's NFTs, tap to select, list one or many.
 * Grouped by collection (a real grouping, not a no-op — see
 * lib/market/collections.ts's rollout plan for collection #2). Every order is
 * signed individually and built through the SAME path as the single ListForm
 * — see lib/market/bulk-list.ts for why bulk EIP-712 signing is not used.
 */
export default function MyInventory({ account, collections, alreadyListed, onListed }: Props) {
  const [inventory, setInventory] = useState<OwnedInventory[] | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Map<string, SelectedItem>>(new Map());
  const [mode, setMode] = useState<PricingMode>("same");
  const [samePrice, setSamePrice] = useState("");
  const [perItemPrices, setPerItemPrices] = useState<Record<string, string>>({});
  const [durationDays, setDurationDays] = useState(7);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [statuses, setStatuses] = useState<BulkItemStatus[] | null>(null);
  const [rarity, setRarity] = useState<Map<string, RarityLookup>>(new Map());

  const refresh = useCallback(() => {
    setRefreshing(true);
    setLoadError(null);
    void getOwnedInventory(collections, account)
      .then(setInventory)
      .catch(() => setLoadError("Could not load your planks — try again."))
      .finally(() => setRefreshing(false));
  }, [account, collections]);

  useEffect(() => {
    let cancelled = false;
    const frame = window.requestAnimationFrame(() => {
      setRefreshing(true);
      setLoadError(null);
      void getOwnedInventory(collections, account)
        .then((nextInventory) => {
          if (!cancelled) setInventory(nextInventory);
        })
        .catch(() => {
          if (!cancelled) setLoadError("Could not load your planks — try again.");
        })
        .finally(() => {
          if (!cancelled) setRefreshing(false);
        });
    });
    return () => {
      cancelled = true;
      window.cancelAnimationFrame(frame);
    };
  }, [account, collections]);

  // Same shared, module-cached fetch every other grid on the page uses —
  // your own planks get the identical tier colors as the marketplace grid.
  useEffect(() => {
    let cancelled = false;
    void getRarityMap().then((map) => {
      if (!cancelled) setRarity(map);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const selectedItems = useMemo(() => Array.from(selected.values()), [selected]);

  const toggle = useCallback(
    (collection: MarketCollection, tokenId: string) => {
      if (busy) return;
      const key = `${collection.slug}:${tokenId}`;
      if (alreadyListed.has(key)) return;
      setSelected((prev) => {
        const next = new Map(prev);
        if (next.has(key)) next.delete(key);
        else next.set(key, { collection, tokenId });
        return next;
      });
      setStatuses(null);
      setError(null);
    },
    [busy, alreadyListed]
  );

  const submit = useCallback(async () => {
    setError(null);
    const priced = resolveBulkPrices(mode, samePrice, perItemPrices, selectedItems);
    if (!priced.ok) {
      setError(priced.error);
      return;
    }
    try {
      setBusy(true);
      const result = await listBulkItems(
        account,
        selectedItems,
        priced.prices,
        durationDays,
        { buildListing, postOrder: defaultPostOrder },
        setStatuses
      );
      const listed = result.filter((s) => s.state === "listed");
      if (listed.length > 0) {
        // Clear only what actually listed; failures stay selected for retry.
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
    } finally {
      setBusy(false);
    }
  }, [account, mode, samePrice, perItemPrices, selectedItems, durationDays, onListed]);

  /** Live net-total preview for the "same price" mode. */
  const totalPreview = useMemo(() => {
    if (selectedItems.length === 0) return null;
    if (mode === "same") {
      const wei = parseTokenAmount(samePrice, 18);
      if (wei === null || wei <= BigInt(0)) return null;
      return formatTokenAmount(wei * BigInt(selectedItems.length), 18, 6);
    }
    let sum = BigInt(0);
    for (const item of selectedItems) {
      const wei = parseTokenAmount(perItemPrices[itemKey(item)] ?? "", 18);
      if (wei === null || wei <= BigInt(0)) return null;
      sum += wei;
    }
    return formatTokenAmount(sum, 18, 6);
  }, [mode, samePrice, perItemPrices, selectedItems]);

  const openReview = () => {
    setError(null);
    const priced = resolveBulkPrices(mode, samePrice, perItemPrices, selectedItems);
    if (!priced.ok) {
      setError(priced.error);
      return;
    }
    setReviewOpen(true);
  };

  if (loadError && inventory === null) {
    return (
      <div className="rounded-lg border border-dashed border-red-500/30 px-4 py-6 text-center" role="alert">
        <p className="text-sm text-red-300">{loadError}</p>
        <button
          type="button"
          onClick={refresh}
          className="mt-3 min-h-10 rounded-md border border-red-500/35 px-3 text-xs text-red-200"
        >
          Retry inventory
        </button>
      </div>
    );
  }
  if (inventory === null) {
    return (
      <p className="rounded-lg border border-dashed border-line bg-panel px-4 py-8 text-center text-sm text-foreground/60">
        Reading your planks from chain…
      </p>
    );
  }

  const totalOwned = inventory.reduce((n, g) => n + g.items.length, 0);
  if (totalOwned === 0) {
    return (
      <p className="rounded-lg border border-dashed border-line bg-panel px-4 py-8 text-center text-sm text-foreground/60">
        This wallet holds no planks yet.
      </p>
    );
  }

  const groups = inventory.filter((g) => g.items.length > 0);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h3 className="font-display text-xl text-gold-300">List from your wallet</h3>
          <p className="text-xs text-foreground/55">
            {totalOwned} owned · {selectedItems.length} selected
          </p>
        </div>
        <button
          type="button"
          onClick={refresh}
          disabled={refreshing}
          className="min-h-10 rounded-md border border-line px-3 text-xs text-gold-300 disabled:opacity-50"
        >
          {refreshing ? "Reloading…" : "Reload"}
        </button>
      </div>
      {loadError && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-red-500/30 bg-red-950/20 px-3 py-2 text-xs text-red-200" role="alert">
          <span>{loadError}</span>
          <button type="button" onClick={refresh} className="min-h-9 underline">
            Retry
          </button>
        </div>
      )}
      {groups.map((group) => (
        <section key={group.collection.slug} className="space-y-2">
          <h3 className="text-xs font-bold uppercase tracking-wider text-foreground/50">
            {group.collection.name} · {group.items.length} owned
          </h3>
          <ul className="grid grid-cols-[repeat(auto-fill,minmax(140px,1fr))] gap-2">
            {group.items.map((item) => {
              const key = `${group.collection.slug}:${item.tokenId}`;
              const isSelected = selected.has(key);
              const isListed = alreadyListed.has(key);
              const r = rarity.get(item.tokenId);
              return (
                <li
                  key={key}
                  className={`dense-card overflow-hidden p-0 ${r ? tierAnimationClass(r.tier) : ""}`}
                  style={r ? { boxShadow: tierGlow(r.tier), ...tierCardStyle(r.tier) } : undefined}
                >
                  {/* holo-card scoped to the artwork button only, not the
                      whole tile — inherits --holo-intensity from the <li>. */}
                  <button
                    type="button"
                    disabled={isListed || busy}
                    aria-pressed={isSelected}
                    aria-label={`${isSelected ? "Deselect" : "Select"} #${item.tokenId}`}
                    onClick={() => toggle(group.collection, item.tokenId)}
                    className={`relative block aspect-square w-full bg-wood-900 outline-none transition ${
                      r ? "holo-card" : ""
                    } ${isSelected ? "ring-2 ring-inset ring-gold-400" : ""} ${isListed ? "cursor-not-allowed opacity-50" : "cursor-pointer focus-visible:ring-2 focus-visible:ring-gold-400/60"}`}
                  >
                    <Image
                      src={withImageWidth(item.imageUrl, 256) || group.collection.image}
                      alt={`${group.collection.name} #${item.tokenId}`}
                      fill
                      sizes="(min-width: 1024px) 20vw, 50vw"
                      className="object-cover"
                      unoptimized={Boolean(item.imageUrl)}
                    />
                    {/* Same badge/overlay pattern as ListingCard's Floor badge. */}
                    {isSelected && (
                      <span className="card-overlay absolute right-1.5 top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-gold-500 text-[0.7rem] font-bold text-wood-950">
                        ✓
                      </span>
                    )}
                    {isListed && (
                      <span className="card-overlay legible-text absolute left-1.5 top-1.5 rounded-full bg-black/90 px-2 py-0.5 text-[0.6rem] font-bold text-emerald-300">
                        Listed
                      </span>
                    )}
                    {r && (
                      <span
                        className={`tier-badge absolute left-1.5 ${isListed ? "top-7" : "top-1.5"} rounded-full px-1.5 py-0.5 text-[0.55rem] font-bold uppercase tracking-wide`}
                        style={{ color: tierColor(r.tier) }}
                        title={`Rank #${r.rank} · ${r.percentile.toFixed(0)}th percentile`}
                      >
                        {r.tier}
                      </span>
                    )}
                    <span className="card-overlay legible-text absolute inset-x-1.5 bottom-1.5 flex flex-col rounded-lg bg-black/90 px-2 py-0.5 leading-tight">
                      <span className="truncate text-[0.6rem] font-bold text-foreground">
                        {r?.name ?? `#${item.tokenId}`}
                      </span>
                      <span className="truncate text-[0.5rem] text-foreground/60">
                        #{item.tokenId}
                        {r ? ` · R${r.rank} · ${r.tier}` : ""}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      ))}

      {selectedItems.length > 0 && (
        <div className="wood-ledger space-y-3 p-3">
          {reviewOpen && (
            <div
              className="fixed inset-0 z-[80] flex items-end justify-center bg-black/70 sm:items-center sm:p-4"
              role="dialog"
              aria-modal="true"
              aria-labelledby="listing-review-title"
            >
              <div className="wood-ledger w-full max-w-lg rounded-t-xl border border-line-strong p-4 sm:rounded-xl">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <p className="text-[0.65rem] font-black uppercase tracking-[0.14em] text-gold-300/75">
                      Verify before signing
                    </p>
                    <h3 id="listing-review-title" className="mt-1 font-display text-2xl text-gold-300">
                      Review listings
                    </h3>
                  </div>
                  <button
                    type="button"
                    onClick={() => setReviewOpen(false)}
                    className="flex h-10 w-10 items-center justify-center rounded-md border border-line text-foreground/65 hover:text-gold-300"
                    aria-label="Close review"
                  >
                    ✕
                  </button>
                </div>
                <dl className="mt-4 grid grid-cols-2 gap-2">
                  <div className="rounded-lg border border-line bg-panel-strong p-3">
                    <dt className="text-[0.65rem] uppercase tracking-wide text-foreground/45">
                      Planks
                    </dt>
                    <dd className="mt-1 text-sm text-foreground">{selectedItems.length}</dd>
                  </div>
                  <div className="rounded-lg border border-line bg-panel-strong p-3">
                    <dt className="text-[0.65rem] uppercase tracking-wide text-foreground/45">
                      Wallet signatures
                    </dt>
                    <dd className="mt-1 text-sm text-foreground">{selectedItems.length}</dd>
                  </div>
                  <div className="rounded-lg border border-line bg-panel-strong p-3">
                    <dt className="text-[0.65rem] uppercase tracking-wide text-foreground/45">
                      Expires
                    </dt>
                    <dd className="mt-1 text-sm text-foreground">{durationDays} days</dd>
                  </div>
                  <div className="rounded-lg border border-line bg-panel-strong p-3">
                    <dt className="text-[0.65rem] uppercase tracking-wide text-foreground/45">
                      Total ask
                    </dt>
                    <dd className="mt-1 text-sm text-foreground">{totalPreview ?? "—"} ETH</dd>
                  </div>
                </dl>
                <p className="mt-3 text-xs leading-5 text-foreground/55">
                  Each Plank creates one independently cancellable order. Price, expiry,
                  approval, and payload are checked before signing; the server verifies current
                  ownership before publication. Stale or partial failures remain selected for
                  retry.
                </p>
                <div className="mt-4 grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => setReviewOpen(false)}
                    className="min-h-11 rounded-lg border border-line text-sm text-foreground/75 hover:text-gold-300"
                  >
                    Back
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setReviewOpen(false);
                      void submit();
                    }}
                    className="min-h-11 rounded-lg bg-gold-500 text-sm font-bold text-wood-950 hover:bg-gold-400"
                  >
                    Continue to wallet
                  </button>
                </div>
              </div>
            </div>
          )}
          <div className="flex items-center justify-between">
            <p className="text-sm font-bold text-foreground">
              List {selectedItems.length} plank{selectedItems.length > 1 ? "s" : ""}
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
                    mode === m.id
                      ? "border-gold-400 bg-gold-500/15 text-gold-300"
                      : "border-line text-foreground/60 hover:border-gold-400"
                  }`}
                >
                  {m.label}
                </button>
              ))}
            </div>
          </div>

          {mode === "same" ? (
            <label className="block">
              <span className="text-[0.65rem] font-bold uppercase tracking-wider text-foreground/50">
                Price per plank (ETH)
              </span>
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
          ) : (
            <ul className="space-y-1.5">
              {selectedItems.map((item) => {
                const key = itemKey(item);
                return (
                  <li key={key} className="flex items-center gap-2">
                    <span className="w-16 shrink-0 text-xs font-bold text-foreground">
                      #{item.tokenId}
                    </span>
                    <input
                      type="text"
                      inputMode="decimal"
                      placeholder="0.0"
                      aria-label={`Price for #${item.tokenId} in ETH`}
                      value={perItemPrices[key] ?? ""}
                      disabled={busy}
                      onChange={(e) =>
                        setPerItemPrices((prev) => ({
                          ...prev,
                          [key]: e.target.value.replace(/[^0-9.]/g, ""),
                        }))
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
              <span className="text-[0.65rem] font-bold uppercase tracking-wider text-foreground/50">
                Expires
              </span>
              <select
                value={durationDays}
                disabled={busy}
                onChange={(e) => setDurationDays(Number(e.target.value))}
                className="mt-1 min-h-11 w-full rounded-lg border border-line bg-panel px-2.5 text-foreground"
              >
                {DURATIONS.map((d) => (
                  <option key={d.days} value={d.days}>
                    {d.label}
                  </option>
                ))}
              </select>
            </label>
            {totalPreview && (
              <p className="text-xs text-foreground/60">
                Total ask{" "}
                <span className="font-display text-gold-300">{totalPreview} Ξ</span>
              </p>
            )}
          </div>

          <p className="text-center text-[0.6rem] text-foreground/40">
            Each plank is its own signed listing — your wallet will ask for{" "}
            {selectedItems.length} signature{selectedItems.length > 1 ? "s" : ""}, one per item.
          </p>

          <button
            type="button"
            disabled={busy}
            onClick={openReview}
            className="min-h-12 w-full rounded-lg bg-gold-500 text-sm font-bold text-wood-950 transition hover:bg-gold-400 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy
              ? "Listing…"
              : `Review ${selectedItems.length} listing${selectedItems.length > 1 ? "s" : ""}`}
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
            <li
              key={s.key}
              className="flex items-center justify-between gap-3 border-t border-line px-3 py-2 first:border-t-0"
            >
              <span className="text-xs font-bold text-foreground">#{s.tokenId}</span>
              <span
                className={`text-xs ${
                  s.state === "listed"
                    ? "text-emerald-300"
                    : s.state === "failed"
                      ? "text-red-300"
                      : "text-foreground/60"
                }`}
              >
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
