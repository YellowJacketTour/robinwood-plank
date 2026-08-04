"use client";

import { useEffect, useMemo, useState } from "react";
import { formatEther } from "ethers";
import Link from "next/link";
import { MARKET_COLLECTIONS } from "@/lib/market/collections";

type DiscoverResult = {
  id: string;
  collectionSlug: string;
  tokenId: string;
  priceWei: string;
  imageUrl: string | null;
};

type DiscoverResponse = {
  results: DiscoverResult[];
  total: number;
  facets: Record<string, Record<string, number>>;
  note?: string;
};

type TrendingCollection = {
  slug: string;
  name: string;
  image: string;
  volume24hWei: string;
  volumeVelocity: number;
  floorWei: string | null;
  floorDeltaPct: number | null;
  tradeCount24h: number;
  saleCount24h: number;
  score: number;
};

function ethLabel(wei: string | null): string {
  if (!wei) return "—";
  try {
    const eth = Number(formatEther(BigInt(wei)));
    return `${eth.toLocaleString(undefined, { maximumFractionDigits: 4 })} ETH`;
  } catch {
    return "—";
  }
}

/** trait filter key <-> URL param encoding: "TraitType:TraitValue" */
function traitKey(traitType: string, traitValue: string): string {
  return `${traitType}:${traitValue}`;
}

export default function DiscoverView() {
  const [query, setQuery] = useState("");
  const [collectionSlug, setCollectionSlug] = useState("");
  const [minEth, setMinEth] = useState("");
  const [maxEth, setMaxEth] = useState("");
  const [selectedTraits, setSelectedTraits] = useState<Set<string>>(new Set());
  const [data, setData] = useState<DiscoverResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [trending, setTrending] = useState<TrendingCollection[] | null>(null);
  const [filterSheetOpen, setFilterSheetOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/discover/trending")
      .then((r) => r.json())
      .then((json) => {
        if (!cancelled) setTrending(json.collections ?? []);
      })
      .catch(() => {
        if (!cancelled) setTrending([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    const params = new URLSearchParams();
    if (query.trim()) params.set("q", query.trim());
    if (collectionSlug) params.set("collection", collectionSlug);
    if (minEth) params.set("minEth", minEth);
    if (maxEth) params.set("maxEth", maxEth);
    for (const key of selectedTraits) params.append("trait", key);

    const t = setTimeout(() => {
      if (cancelled) return;
      setLoading(true);
      fetch(`/api/discover?${params.toString()}`, { signal: controller.signal })
        .then((r) => r.json())
        .then((json) => {
          if (!cancelled) setData(json);
        })
        .catch((err) => {
          if (!cancelled && err?.name !== "AbortError") setData({ results: [], total: 0, facets: {} });
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }, 250); // debounce so every keystroke doesn't fire a request

    return () => {
      cancelled = true;
      controller.abort();
      clearTimeout(t);
    };
  }, [query, collectionSlug, minEth, maxEth, selectedTraits]);

  const facetEntries = useMemo(() => {
    const facets = data?.facets ?? {};
    return Object.entries(facets).sort(([a], [b]) => a.localeCompare(b));
  }, [data]);

  function toggleTrait(traitType: string, traitValue: string) {
    const key = traitKey(traitType, traitValue);
    setSelectedTraits((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function clearFilters() {
    setQuery("");
    setCollectionSlug("");
    setMinEth("");
    setMaxEth("");
    setSelectedTraits(new Set());
  }

  const activeFilterCount =
    selectedTraits.size + (collectionSlug ? 1 : 0) + (minEth ? 1 : 0) + (maxEth ? 1 : 0);

  return (
    <div data-market-shell className="mx-auto max-w-[1400px] px-3 py-6 sm:px-4 lg:px-6">
      <header className="mb-6">
        <h1 className="font-display text-2xl text-gold-300 sm:text-3xl">Discover</h1>
        <p className="mt-1 text-sm text-cream-muted">
          Search and filter every RobinWood collection by trait, rarity, and price.
        </p>
      </header>

      <TrendingRail collections={trending} />

      <div className="mt-6 flex flex-col gap-4 lg:flex-row lg:items-start">
        {/* Filter rail: 248px sticky on desktop, bottom sheet below 960px — DESIGN.md filter-rail spec */}
        <button
          type="button"
          className="flex h-11 items-center justify-between rounded-md border border-line bg-panel px-4 text-sm font-bold text-cream lg:hidden"
          onClick={() => setFilterSheetOpen(true)}
        >
          <span>Filters{activeFilterCount > 0 ? ` (${activeFilterCount})` : ""}</span>
          <span aria-hidden="true">▾</span>
        </button>

        <aside className="hidden w-[248px] shrink-0 lg:sticky lg:top-24 lg:block">
          <FilterPanel
            query={query}
            setQuery={setQuery}
            collectionSlug={collectionSlug}
            setCollectionSlug={setCollectionSlug}
            minEth={minEth}
            setMinEth={setMinEth}
            maxEth={maxEth}
            setMaxEth={setMaxEth}
            facetEntries={facetEntries}
            selectedTraits={selectedTraits}
            toggleTrait={toggleTrait}
            onClear={clearFilters}
          />
        </aside>

        {filterSheetOpen && (
          <div
            className="fixed inset-0 z-[80] flex items-end bg-black/85 lg:hidden"
            role="presentation"
            onClick={() => setFilterSheetOpen(false)}
          >
            <div
              className="max-h-[85vh] w-full overflow-y-auto rounded-t-xl border-t border-line bg-panel p-4"
              onClick={(e) => e.stopPropagation()}
              role="dialog"
              aria-modal="true"
              aria-label="Filters"
            >
              <div className="mb-3 flex items-center justify-between">
                <h2 className="text-sm font-bold uppercase tracking-wide text-gold-300">Filters</h2>
                <button
                  type="button"
                  className="flex h-11 items-center px-2 text-sm text-cream-muted"
                  onClick={() => setFilterSheetOpen(false)}
                >
                  Done
                </button>
              </div>
              <FilterPanel
                query={query}
                setQuery={setQuery}
                collectionSlug={collectionSlug}
                setCollectionSlug={setCollectionSlug}
                minEth={minEth}
                setMinEth={setMinEth}
                maxEth={maxEth}
                setMaxEth={setMaxEth}
                facetEntries={facetEntries}
                selectedTraits={selectedTraits}
                toggleTrait={toggleTrait}
                onClear={clearFilters}
              />
            </div>
          </div>
        )}

        <section className="min-w-0 flex-1">
          <div className="mb-3 flex items-center justify-between text-xs text-cream-muted">
            <span>
              {loading ? "Searching…" : `${data?.total ?? 0} result${data?.total === 1 ? "" : "s"}`}
            </span>
          </div>

          {data?.note && (
            <div className="mb-4 rounded-md border border-line bg-panel-strong p-3 text-xs text-cream-muted">
              {data.note}
            </div>
          )}

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5">
            {(data?.results ?? []).map((item) => (
              <Link
                key={item.id}
                href={`/market/${item.collectionSlug}?token=${item.tokenId}`}
                className="group overflow-hidden rounded-lg border border-line bg-panel transition hover:border-gold-500/60"
              >
                <div className="aspect-square w-full overflow-hidden bg-panel-strong">
                  {item.imageUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={item.imageUrl}
                      alt={`RobinWood Plank #${item.tokenId}`}
                      className="h-full w-full object-cover transition group-hover:scale-105"
                      loading="lazy"
                    />
                  ) : (
                    <div className="flex h-full w-full items-center justify-center text-xs text-cream-muted">
                      No image
                    </div>
                  )}
                </div>
                <div className="p-2.5">
                  <div className="text-xs font-bold text-cream">#{item.tokenId}</div>
                  <div className="text-xs text-gold-300">{ethLabel(item.priceWei)}</div>
                </div>
              </Link>
            ))}
          </div>

          {!loading && (data?.results.length ?? 0) === 0 && (
            <div className="mt-10 rounded-lg border border-line bg-panel p-8 text-center text-sm text-cream-muted">
              No listings match these filters.
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function FilterPanel(props: {
  query: string;
  setQuery: (v: string) => void;
  collectionSlug: string;
  setCollectionSlug: (v: string) => void;
  minEth: string;
  setMinEth: (v: string) => void;
  maxEth: string;
  setMaxEth: (v: string) => void;
  facetEntries: [string, Record<string, number>][];
  selectedTraits: Set<string>;
  toggleTrait: (traitType: string, traitValue: string) => void;
  onClear: () => void;
}) {
  const {
    query,
    setQuery,
    collectionSlug,
    setCollectionSlug,
    minEth,
    setMinEth,
    maxEth,
    setMaxEth,
    facetEntries,
    selectedTraits,
    toggleTrait,
    onClear,
  } = props;

  return (
    <div className="flex flex-col gap-4 rounded-lg border border-line bg-panel p-3.5">
      <div>
        <label className="mb-1 block text-[0.6875rem] font-black uppercase tracking-[0.12em] text-cream-muted">
          Search
        </label>
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Name or token id"
          className="h-10 w-full rounded-md border border-line bg-panel-strong px-2.5 text-sm text-cream outline-none focus:border-gold-500"
        />
      </div>

      <div>
        <label className="mb-1 block text-[0.6875rem] font-black uppercase tracking-[0.12em] text-cream-muted">
          Collection
        </label>
        <select
          value={collectionSlug}
          onChange={(e) => setCollectionSlug(e.target.value)}
          className="h-10 w-full rounded-md border border-line bg-panel-strong px-2.5 text-sm text-cream outline-none focus:border-gold-500"
        >
          <option value="">All collections</option>
          {MARKET_COLLECTIONS.map((c) => (
            <option key={c.slug} value={c.slug}>
              {c.name}
            </option>
          ))}
        </select>
      </div>

      <div>
        <label className="mb-1 block text-[0.6875rem] font-black uppercase tracking-[0.12em] text-cream-muted">
          Price (ETH)
        </label>
        <div className="flex gap-2">
          <input
            type="text"
            inputMode="decimal"
            value={minEth}
            onChange={(e) => setMinEth(e.target.value)}
            placeholder="Min"
            className="h-10 w-full rounded-md border border-line bg-panel-strong px-2.5 text-sm text-cream outline-none focus:border-gold-500"
          />
          <input
            type="text"
            inputMode="decimal"
            value={maxEth}
            onChange={(e) => setMaxEth(e.target.value)}
            placeholder="Max"
            className="h-10 w-full rounded-md border border-line bg-panel-strong px-2.5 text-sm text-cream outline-none focus:border-gold-500"
          />
        </div>
      </div>

      {facetEntries.length > 0 && (
        <div className="flex flex-col gap-3 border-t border-line pt-3">
          {facetEntries.map(([traitType, values]) => (
            <div key={traitType}>
              <div className="mb-1.5 text-[0.6875rem] font-black uppercase tracking-[0.12em] text-cream-muted">
                {traitType}
              </div>
              <div className="flex flex-col gap-1">
                {Object.entries(values)
                  .sort(([, a], [, b]) => b - a)
                  .map(([value, count]) => {
                    const key = traitKey(traitType, value);
                    const checked = selectedTraits.has(key);
                    return (
                      <label
                        key={key}
                        className="flex min-h-[32px] cursor-pointer items-center justify-between gap-2 rounded-md px-1.5 text-xs text-cream hover:bg-panel-strong"
                      >
                        <span className="flex items-center gap-2">
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => toggleTrait(traitType, value)}
                            className="h-4 w-4"
                          />
                          {value}
                        </span>
                        <span className="text-cream-muted">{count}</span>
                      </label>
                    );
                  })}
              </div>
            </div>
          ))}
        </div>
      )}

      <button
        type="button"
        onClick={onClear}
        className="h-10 rounded-md border border-line bg-panel-strong text-xs font-bold uppercase tracking-wide text-gold-300"
      >
        Clear filters
      </button>
    </div>
  );
}

function TrendingRail({ collections }: { collections: TrendingCollection[] | null }) {
  if (collections === null) {
    return (
      <div className="h-32 animate-pulse rounded-lg border border-line bg-panel" aria-hidden="true" />
    );
  }
  if (collections.length === 0) return null;

  return (
    <section aria-labelledby="trending-heading">
      <h2 id="trending-heading" className="mb-3 font-display text-lg text-gold-300">
        Trending Collections
      </h2>
      <div className="flex gap-3 overflow-x-auto pb-2">
        {collections.map((c) => (
          <Link
            key={c.slug}
            href={`/market/${c.slug}`}
            className="flex w-56 shrink-0 flex-col gap-2 rounded-lg border border-line bg-panel p-3 transition hover:border-gold-500/60"
          >
            <div className="flex items-center justify-between">
              <span className="text-sm font-bold text-cream">{c.name}</span>
              {c.saleCount24h > 0 && (
                <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[0.65rem] font-black text-emerald-400">
                  {c.volumeVelocity >= 999
                    ? "NEW"
                    : `${c.volumeVelocity.toFixed(1)}x pace`}
                </span>
              )}
            </div>
            <dl className="grid grid-cols-2 gap-x-2 gap-y-1 text-xs">
              <dt className="text-cream-muted">Floor</dt>
              <dd className="text-right text-gold-300">{ethLabel(c.floorWei)}</dd>
              <dt className="text-cream-muted">24h vol</dt>
              <dd className="text-right text-cream">{ethLabel(c.volume24hWei)}</dd>
              <dt className="text-cream-muted">Floor Δ24h</dt>
              <dd
                className={`text-right ${
                  c.floorDeltaPct === null
                    ? "text-cream-muted"
                    : c.floorDeltaPct >= 0
                      ? "text-emerald-400"
                      : "text-red-400"
                }`}
              >
                {c.floorDeltaPct === null ? "—" : `${c.floorDeltaPct >= 0 ? "+" : ""}${c.floorDeltaPct.toFixed(1)}%`}
              </dd>
              <dt className="text-cream-muted">Trades 24h</dt>
              <dd className="text-right text-cream">{c.tradeCount24h}</dd>
            </dl>
          </Link>
        ))}
      </div>
    </section>
  );
}
