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
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Map<string, SelectedItem>>(new Map());
  const [mode, setMode] = useState<PricingMode>("same");
  const [samePrice, setSamePrice] = useState("");
  const [perItemPrices, setPerItemPrices] = useState<Record<string, string>>({});
  const [durationDays, setDurationDays] = useState(7);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [statuses, setStatuses] = useState<BulkItemStatus[] | null>(null);
  const [rarity, setRarity] = useState<Map<string, RarityLookup>>(new Map());

  useEffect(() => {
    let cancelled = false;
    setInventory(null);
    setLoadError(null);
    void getOwnedInventory(collections, account)
      .then((inv) => {
        if (!cancelled) setInventory(inv);
      })
      .catch(() => {
        if (!cancelled) setLoadError("Could not load your planks — try again.");
      });
    return () => {
      cancelled = true;
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

  if (loadError) {
    return (
      <p className="rounded-lg border border-dashed border-red-500/30 px-4 py-6 text-center text-sm text-red-300" role="alert">
        {loadError}
      </p>
    );
  }
  if (inventory === null) {
    return (
      <p className="rounded-lg border border-dashed border-gold-500/30 bg-wood-900/40 px-4 py-8 text-center text-sm text-foreground/60">
        Reading your planks from chain…
      </p>
    );
  }

  const totalOwned = inventory.reduce((n, g) => n + g.items.length, 0);
  if (totalOwned === 0) {
    return (
      <p className="rounded-lg border border-dashed border-gold-500/30 bg-wood-900/40 px-4 py-8 text-center text-sm text-foreground/60">
        This wallet holds no planks yet.
      </p>
    );
  }

  const groups = inventory.filter((g) => g.items.length > 0);

  return (
    <div className="space-y-4">
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
                      src={item.imageUrl || group.collection.image}
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
                      <span className="card-overlay legible-text absolute left-1.5 top-1.5 rounded-full bg-black/60 px-2 py-0.5 text-[0.6rem] font-bold text-emerald-300">
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
                    <span className="card-overlay legible-text absolute inset-x-1.5 bottom-1.5 flex flex-col rounded-lg bg-black/60 px-2 py-0.5 leading-tight">
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
                      : "border-gold-500/30 text-foreground/60 hover:border-gold-400"
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
                className="mt-1 min-h-11 w-full rounded-lg border border-gold-500/30 bg-wood-900/70 px-2.5 text-foreground outline-none focus:border-gold-400"
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
                      className="min-h-10 w-full rounded-lg border border-gold-500/30 bg-wood-900/70 px-2.5 text-sm text-foreground outline-none focus:border-gold-400"
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
                className="mt-1 min-h-11 w-full rounded-lg border border-gold-500/30 bg-wood-900/70 px-2.5 text-foreground"
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
            onClick={() => void submit()}
            className="min-h-12 w-full rounded-lg bg-gold-500 text-sm font-bold text-wood-950 transition hover:bg-gold-400 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy
              ? "Listing…"
              : `List ${selectedItems.length} for sale`}
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
              className="flex items-center justify-between gap-3 border-t border-gold-500/15 px-3 py-2 first:border-t-0"
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
