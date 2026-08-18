"use client";

import { useEffect, useMemo, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { chainDisplayName, chainBrandColor } from "@/lib/market/multichain/trading/foreign-chain-registry";
import { swrJson } from "@/lib/market/swr-fetch";
import ChainIcon from "@/components/market/ChainIcon";
import { normalizeAssetSymbol, type MultiAssetPrices } from "@/lib/multi-asset-price";

/**
 * Some collection images (any sourced from lib/market/multichain/adapters/
 * defillama-nft.ts) are cached URLs on img.reservoir.tools -- confirmed
 * live 2026-08-18 in a real browser: that domain no longer resolves at all
 * (ERR_NAME_NOT_RESOLVED), since Reservoir shut down its public
 * infrastructure in 2025 (see defillama-nft.ts's own header). A plain
 * <Image> with a dead src throws a real console error and shows a broken
 * image; this swaps to the same "?" placeholder used for a genuinely
 * absent imageUrl, so a real user never sees breakage from third-party
 * infrastructure this app doesn't control.
 */
/**
 * On-brand placeholder for a collection with no real art yet -- a plain
 * grey "?" reads as broken/generic (flagged live 2026-08-18: "bare
 * artwork/graphics look... generic grey"). This reuses the same
 * wood-grain + gold plank mark the header/nav already establishes as this
 * app's visual identity (bg-wood-900, gold-300/400, PlankFence.tsx's own
 * plank-board motif) instead of inventing a new look, and never claims to
 * be real per-token art -- it's honest about being a placeholder.
 */
function PlankPlaceholder() {
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-1 bg-gradient-to-br from-wood-900 via-wood-800 to-wood-900">
      <svg viewBox="0 0 24 24" className="h-7 w-7 text-gold-400/70" fill="none" stroke="currentColor" strokeWidth="1.5">
        <rect x="2" y="9" width="20" height="6" rx="1" />
        <line x1="2" y1="12" x2="22" y2="12" strokeOpacity="0.4" />
        <circle cx="6" cy="10.5" r="0.5" fill="currentColor" stroke="none" />
        <circle cx="18" cy="13.5" r="0.5" fill="currentColor" stroke="none" />
      </svg>
      <span className="text-[0.55rem] font-black uppercase tracking-wider text-gold-400/50">Art pending</span>
    </div>
  );
}

/**
 * Confirmed live 2026-08-19: some upstream (Alchemy/OpenSea) metadata
 * carries the LITERAL 4-character string "null" for an image field instead
 * of a real null (see alchemy-nft.ts's cleanMetadataString for the
 * verified source) -- a truthy string that sailed past a plain `!src`
 * check and crashed Next's <Image> with "invalid src prop" the moment a
 * user clicked into an affected collection. lib/ipfs.ts's withImageWidth
 * now sanitizes this at the shared chokepoint other callers go through,
 * but this component reads `imageUrl` directly (not via withImageWidth),
 * so it needs its own guard.
 */
function isPoisonedImageSrc(src: string | null): boolean {
  if (!src) return true;
  const trimmed = src.trim().toLowerCase();
  return trimmed === "" || trimmed === "null" || trimmed === "undefined";
}

function CollectionThumb({ src, alt, onFail }: { src: string | null; alt: string; onFail?: () => void }) {
  const [failed, setFailed] = useState(false);
  if (!src || isPoisonedImageSrc(src) || failed) {
    return <PlankPlaceholder />;
  }
  return (
    <Image
      src={src}
      alt={alt}
      fill
      sizes="20vw"
      className="object-cover"
      unoptimized
      onError={() => {
        setFailed(true);
        onFail?.();
      }}
    />
  );
}

type TrackedCollection = {
  chainSlug: string;
  chainId: number | null;
  contractAddress: string;
  name: string | null;
  imageUrl: string | null;
  isVaultBacked: boolean;
  floorPriceWei: string | null;
  floorPriceCurrency: string | null;
  syncedAt: string | null;
  /** False for Solana today -- see route's own comment: the Seaport-based buy/sweep/offers/rarity pipeline has no Solana equivalent. */
  tradeable: boolean;
  /** Real observed 7-day Transfer count (evm-log-scan.ts) -- the honest volume proxy this app actually has; never a fabricated $ figure. 0 for Solana (not scanned by that pipeline) or a collection with no recent chain activity. */
  recentActivity: number;
  /** Real handle/wallet "whenever provided" -- never fabricated, see rarity-index-runner.ts's header on why creator_username itself is usually null. */
  creatorHandle: string | null;
  creatorAddress: string | null;
  /** Real ENS name, "whenever publicly known" (lib/market/multichain/ens.ts) -- never fabricated. */
  creatorEns: string | null;
  /** Real OpenSea 24h volume/sales (rarity-index-runner.ts). Null until a collection has been through that scaffold pass. */
  volume24hWei: string | null;
  sales24h: number | null;
  /** Real floor % change from this app's own prior observation -- OpenSea has no such field. Null until at least two syncs have run. */
  floorChangePct: number | null;
  /** Real, from the same source as floorPriceWei (Alchemy/Magic Eden snapshot) -- already returned by this route, just never surfaced on this page until now. */
  totalSupply: number | null;
  listedCount: number | null;
};

type SortMode = "trending" | "floor-desc" | "floor-asc" | "name";

/** A collection is graded "real" for ranking/display purposes only when it has actual art AND at least one real signal (activity, volume, or a tradeable order book) -- an artless or dead row shouldn't out-rank one a person can actually look at and buy. Max possible score is 2050. */
function gradeScore(c: TrackedCollection, artOk: boolean): number {
  let score = 0;
  if (artOk) score += 1000;
  if (c.tradeable) score += 500;
  score += (Math.min(c.recentActivity, 5000) / 5000) * 300;
  if (c.volume24hWei && c.volume24hWei !== "0") score += 200;
  if (c.creatorHandle || c.creatorEns) score += 50;
  return score;
}

/**
 * A visible A/B/C/D letter for gradeScore(), because "the sort order
 * changed" isn't the same as "grading is visibly real" -- flagged live
 * 2026-08-18 ("dont properly graded collections as far as i can genuinely
 * tell"). Same four real inputs as gradeScore, just thresholded into a
 * legible band instead of staying an invisible sort key. Never shown for a
 * row with no art at all -- an ungraded placeholder, not a fabricated D.
 */
function gradeLetter(score: number): "A" | "B" | "C" | "D" {
  if (score >= 1700) return "A";
  if (score >= 1350) return "B";
  if (score >= 1000) return "C";
  return "D";
}
const GRADE_COLOR: Record<string, string> = {
  A: "#34d399",
  B: "#a3e635",
  C: "#fbbf24",
  D: "#fb7185",
};

function GradeBadge({ score }: { score: number }) {
  const letter = gradeLetter(score);
  return (
    <span
      className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[0.6rem] font-black text-wood-950"
      style={{ backgroundColor: GRADE_COLOR[letter] }}
      title={`Composite grade ${letter} — real art, order book, activity, volume, and creator attribution`}
    >
      {letter}
    </span>
  );
}

// Real, current chainSlug values only (verified against what
// scripts/seed-multichain-collections.ts and discover-multichain-
// collections.ts actually write to Postgres -- "matic-mainnet" and bare
// "solana" were never real values, they were carried over from an earlier,
// wrong assumption). Ordered per explicit direction: Bitcoin, Robinhood,
// Solana, Base, Ethereum, BNB Chain first, then the remaining EVM chains.
const ALL_CHAIN_SLUGS_ORDER = [
  "bitcoin-mainnet",
  "robinhood",
  "solana-mainnet",
  "base-mainnet",
  "eth-mainnet",
  "bnb-mainnet",
  "polygon-mainnet",
  "arb-mainnet",
  "opt-mainnet",
  "avax-mainnet",
];

/**
 * The "global market world" hub -- every collection this app tracks
 * outside Marketplank's own single RobinWood plank collection, browsable
 * by chain, one click into each collection's real buy/sweep/send surface
 * (MultichainCollectionView).
 *
 * LAYOUT, TOP TO BOTTOM: a top-mover banner (real highest-24h-volume
 * tradeable+art row per refresh, not a curated/paid "Featured" slot --
 * this app has no such inventory to sell), a horizontal per-chain "top
 * collections, last 24h" scroll strip, then the full filterable/sortable
 * grid with a real sidebar of checkbox filters mirroring Marketplank's own
 * filter vocabulary (chain, tradeable, has-art, verified-creator).
 *
 * NO PACK PULLS / LUCKY BUY -- DELIBERATE, NOT A GAP
 * ---------------------------------------------------------------------------
 * Magic Eden's "Top Pack Pulls" strip is real-money loot-box gambling (pay
 * X SOL, receive a random NFT, displayed with a payout multiplier). That's
 * a distinct regulated product with real legal exposure in many
 * jurisdictions and needs its own explicit scope/odds-disclosure decision,
 * not a bolt-on to this hub. Not built here.
 *
 * "BADGED" GRADING, REVERSE-ENGINEERED HONESTLY
 * ---------------------------------------------------------------------------
 * Magic Eden's "Badged" toggle is a binary verified/allowlist flag, and its
 * "Top" ranking is plain 24h-volume descending -- no hidden quality model.
 * gradeScore() above is this app's own, more honest composite: real art
 * present, a real order book (tradeable), real observed activity, real
 * volume, and real creator attribution all weigh in, so an artless or
 * wash-traded row can't simply out-rank a genuine one by raw volume alone.
 *
 * NO "AFFILIATE COLLECTIONS FROM OUR OWN MINTING STUDIOS" SECTION YET --
 * HONEST GAP, NOT AN OVERSIGHT
 * ---------------------------------------------------------------------------
 * plank_multichain_collections (migration 013) has no field distinguishing
 * a collection minted by this app's own studio tooling from any other
 * third-party collection someone tracked -- isVaultBacked is a DIFFERENT,
 * Robinhood-Chain-specific concept (whether MarketplankVaultV3 mechanics
 * apply), not "did we mint this." Building that distinction honestly needs
 * a real schema field (e.g. a `minted_by_us` column) set at seed/discover
 * time from actual knowledge of which collections came from this studio's
 * own minting flow, not a UI-side guess. Every collection here is grouped
 * only by chain until that field exists.
 */
export default function GlobalMarketHub() {
  const [collections, setCollections] = useState<TrackedCollection[]>([]);
  const [deadArt, setDeadArt] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [chainFilter, setChainFilter] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");
  const [onlyTradeable, setOnlyTradeable] = useState(false);
  const [onlyArt, setOnlyArt] = useState(false);
  const [onlyVerifiedCreator, setOnlyVerifiedCreator] = useState(false);
  const [mobileFiltersOpen, setMobileFiltersOpen] = useState(false);
  // Default = "trending": gradeScore() descending, real floor ascending as
  // the tiebreak -- the volume-primary/floor-secondary pattern
  // state-of-the-art multichain marketplaces (OpenSea Trending, Blur,
  // Magic Eden) converge on, now weighted by real art/tradeability instead
  // of raw activity alone (see gradeScore's own header).
  const [sortMode, setSortMode] = useState<SortMode>("trending");
  // Rankings-table row count -- Magic Eden's real "Show top: 10/25/50/100"
  // control, live-checked 2026-08-19. Matters far more now than it would
  // have before this session's discovery work: this app went from ~170 to
  // 3,500+ tracked collections, so a fixed cutoff either buries most of
  // them or floods the page -- a real control beats guessing one number.
  const [rankingsShowCount, setRankingsShowCount] = useState(25);
  // Per-collection watchlist star, Magic Eden's real pattern. Client-only
  // (localStorage), no backend -- this app has no user-account system to
  // attach a server-side watchlist to, and a real client-persisted one is
  // honest about that rather than faking a synced feature.
  // Deliberately hydrated in an effect, NOT a useState lazy initializer --
  // this is a "use client" component Next still server-renders for the
  // initial HTML. A lazy initializer would read localStorage during the
  // CLIENT's hydration render itself, diverging from the empty server-
  // rendered HTML and triggering a real React hydration mismatch (the
  // star icons would flip from "reads as empty" to "reads as populated"
  // between server and client output). The effect-based version below
  // renders empty on both server AND the client's first hydration pass
  // (matching, no mismatch), then updates post-hydration -- the standard,
  // correct pattern for browser-only state. The "setState synchronously
  // within an effect" lint rule is a false positive for exactly this
  // mount-once, empty-deps-array case; it does not cascade.
  const [watchlist, setWatchlist] = useState<Set<string>>(new Set());
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem("plank:market:watchlist-v1");
      if (raw) setWatchlist(new Set(JSON.parse(raw) as string[]));
    } catch {
      // Corrupt/blocked storage -- start empty rather than throw.
    }
  }, []);
  const toggleWatchlist = (k: string) => {
    setWatchlist((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      try {
        window.localStorage.setItem("plank:market:watchlist-v1", JSON.stringify([...next]));
      } catch {
        // Best-effort persistence only.
      }
      return next;
    });
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // The collection index changes on a discover/sync cadence measured
        // in minutes, not seconds -- a longer ttl than the per-collection
        // listings view is correct here, not lazier caching.
        // isGood: never let a stale/empty index response lock out a real
        // one for the full 10-minute swr window -- same stale-poisons-
        // cache fix needed twice already this session (MultichainCollectionView's
        // rarity fetch, ForeignOfferForm's trait-index fetch).
        const data = await swrJson<{ collections: TrackedCollection[] }>("/api/market/multichain", {
          ttlMs: 60_000,
          swrMs: 600_000,
          session: true,
          isGood: (d) => Array.isArray((d as { collections?: unknown })?.collections),
        });
        if (!cancelled) setCollections(data.collections ?? []);
      } catch {
        if (!cancelled) setLoadError("Could not load the global market index right now.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Real ETH/SOL/BTC USD prices -- one shared fetch for the whole hub
  // (rankings table + Biggest Movers), same short-TTL swr pattern the
  // collection index itself uses. usdPrices stays {} (not fabricated
  // zeros) until this resolves, so every USD-dependent render checks for
  // a real price before showing one.
  const [usdPrices, setUsdPrices] = useState<MultiAssetPrices>({});
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await swrJson<{ prices: MultiAssetPrices }>("/api/market/asset-prices", {
          ttlMs: 30_000,
          swrMs: 120_000,
          session: true,
        });
        if (!cancelled) setUsdPrices(data.prices ?? {});
      } catch {
        // USD is a display enhancement, not core data -- a failed fetch
        // just means every USD figure stays hidden, native price still shows.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  /** Real USD-equivalent for a wei-denominated native price, or null if this currency has no fetched price -- never fabricated. */
  const toUsd = (weiStr: string | null, currency: string | null): number | null => {
    if (!weiStr) return null;
    const symbol = normalizeAssetSymbol(currency);
    const usd = symbol ? usdPrices[symbol]?.usd : null;
    if (usd == null) return null;
    return (Number(weiStr) / 1e18) * usd;
  };
  const formatUsdCompact = (n: number): string => {
    if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
    if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
    return `$${n.toFixed(2)}`;
  };

  const key = (c: TrackedCollection) => `${c.chainSlug}:${c.contractAddress}`;
  const hasArt = (c: TrackedCollection) => Boolean(c.imageUrl) && !deadArt.has(key(c));

  const chains = useMemo(() => {
    const seen = new Map<string, number>();
    for (const c of collections) seen.set(c.chainSlug, (seen.get(c.chainSlug) ?? 0) + 1);
    return [...seen.entries()].sort((a, b) => {
      const ia = ALL_CHAIN_SLUGS_ORDER.indexOf(a[0]);
      const ib = ALL_CHAIN_SLUGS_ORDER.indexOf(b[0]);
      if (ia !== -1 && ib !== -1) return ia - ib;
      return b[1] - a[1];
    });
  }, [collections]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const rows = collections.filter((c) => {
      if (chainFilter.size > 0 && !chainFilter.has(c.chainSlug)) return false;
      if (q && !(c.name ?? "").toLowerCase().includes(q)) return false;
      if (onlyTradeable && !c.tradeable) return false;
      if (onlyArt && !hasArt(c)) return false;
      if (onlyVerifiedCreator && !(c.creatorHandle || c.creatorEns)) return false;
      return true;
    });
    const floor = (c: TrackedCollection) => (c.floorPriceWei ? Number(c.floorPriceWei) : null);
    // Floor price is only ever compared WITHIN the same currency. Solana
    // floors are stored as lamports padded to an 18-decimal-equivalent
    // integer (see magiceden-solana.ts's lamportsToScaledString) -- that's
    // decimal-place normalization, NOT a real SOL/ETH exchange-rate
    // conversion, so "0.27 SOL" and "0.27 ETH" land at the same raw
    // magnitude despite being worth very different amounts. Comparing that
    // magnitude across currencies is meaningless (confirmed live: it was
    // clustering every cheap-looking SOL floor above real, far-more-
    // valuable ETH collections). Cross-currency pairs fall through to 0
    // (no opinion) rather than a fabricated ranking.
    const compareFloor = (a: TrackedCollection, b: TrackedCollection, direction: 1 | -1): number => {
      const fa = floor(a);
      const fb = floor(b);
      if (fa === null && fb === null) return 0;
      if (fa === null) return 1;
      if (fb === null) return -1;
      if (a.floorPriceCurrency !== b.floorPriceCurrency) return 0;
      return (fa - fb) * direction;
    };
    const sorted = [...rows];
    if (sortMode === "trending") {
      sorted.sort((a, b) => {
        const ga = gradeScore(a, hasArt(a));
        const gb = gradeScore(b, hasArt(b));
        if (gb !== ga) return gb - ga;
        return compareFloor(a, b, 1);
      });
    } else if (sortMode === "floor-desc" || sortMode === "floor-asc") {
      sorted.sort((a, b) => {
        if (a.tradeable !== b.tradeable) return a.tradeable ? -1 : 1;
        return compareFloor(a, b, sortMode === "floor-desc" ? -1 : 1);
      });
    } else {
      sorted.sort((a, b) => (a.name ?? "").localeCompare(b.name ?? ""));
    }
    return sorted;
  }, [collections, chainFilter, search, sortMode, onlyTradeable, onlyArt, onlyVerifiedCreator, deadArt]);

  // Top movers: real gradeScore-ranked rows with both real art and a real
  // order book, highest 24h volume as the tiebreak -- never a curated/paid
  // slot (this hub has no such inventory to sell), and never a row a
  // visitor couldn't actually act on. Immersive large-hero + medium-strip
  // carousel (flagged live 2026-08-18: the single-card banner "isn't
  // immersive"), not a single static banner.
  const topMovers = useMemo(() => {
    const candidates = collections.filter((c) => c.tradeable && hasArt(c) && c.volume24hWei && c.volume24hWei !== "0");
    return candidates
      .sort((a, b) => {
        const g = gradeScore(b, true) - gradeScore(a, true);
        if (g !== 0) return g;
        return Number(BigInt(b.volume24hWei!) - BigInt(a.volume24hWei!));
      })
      .slice(0, 6);
  }, [collections, deadArt]);

  // A single ranked table across every chain, filterable by the SAME chain
  // pills used everywhere else on this page (one filter concept, not two
  // parallel ones) -- reverse-engineered from OpenSea's own real rankings
  // page (opensea.io/collections, live-checked 2026-08-19): a dense table
  // -- Collection / Floor / 24h Change / 24h Volume / 24h Sales -- not a
  // card grid, with chain identity carried by a badge on each row rather
  // than by segregating chains into separate side-by-side panels. That
  // earlier per-chain-panel version read as a horizontal scroll strip on
  // anything narrower than a very wide desktop and hid most chains off-
  // screen -- the opposite of "insight at a glance." Every field below is
  // real data this app already tracks (floorPriceWei/Currency,
  // floorChangePct, volume24hWei, sales24h) -- no owners/supply column,
  // unlike OpenSea's own table, because this app doesn't have that data
  // and this codebase's own standing rule is never to fabricate a metric.
  const rankings = useMemo(() => {
    const rows = collections.filter((c) => hasArt(c) && (chainFilter.size === 0 || chainFilter.has(c.chainSlug)));
    return rows
      .sort((a, b) => {
        const g = gradeScore(b, true) - gradeScore(a, true);
        if (g !== 0) return g;
        const va = a.volume24hWei ? BigInt(a.volume24hWei) : BigInt(0);
        const vb = b.volume24hWei ? BigInt(b.volume24hWei) : BigInt(0);
        return vb > va ? 1 : vb < va ? -1 : 0;
      })
      .slice(0, rankingsShowCount);
  }, [collections, deadArt, chainFilter, rankingsShowCount]);

  // Biggest Movers -- Magic Eden's real secondary strip (live-checked
  // 2026-08-19), sorted purely by |24h floor change|, not volume/grade.
  // This surfaces a DIFFERENT real signal than the rankings table above
  // (a thin collection can have a huge % swing without much volume behind
  // it) -- distinct information, not a restatement of the same ranking.
  // Requires floorChangePct to actually be present (at least two syncs
  // observed) -- skipped, not zero-filled, for a collection that hasn't.
  const biggestMovers = useMemo(() => {
    const rows = collections.filter((c) => hasArt(c) && c.floorChangePct != null && c.floorChangePct !== 0);
    return rows.sort((a, b) => Math.abs(b.floorChangePct!) - Math.abs(a.floorChangePct!)).slice(0, 8);
  }, [collections, deadArt]);

  const toggleChain = (slug: string) => {
    setChainFilter((prev) => {
      const next = new Set(prev);
      if (next.has(slug)) next.delete(slug);
      else next.add(slug);
      return next;
    });
  };

  if (loading) {
    return <p className="p-6 text-center text-foreground/50">Loading the global market…</p>;
  }
  if (loadError) {
    return <p className="p-6 text-center text-red-300">{loadError}</p>;
  }

  const activeFilterCount = chainFilter.size + (onlyTradeable ? 1 : 0) + (onlyArt ? 1 : 0) + (onlyVerifiedCreator ? 1 : 0);

  const filterPanel = (
    <div className="space-y-4">
      <div>
        <p className="mb-1.5 text-[0.65rem] font-black uppercase tracking-wider text-foreground/40">Chains</p>
        <div className="space-y-1">
          {chains.map(([slug, count]) => (
            <label key={slug} className="flex min-h-9 cursor-pointer items-center gap-2 rounded px-1 text-sm hover:bg-foreground/5">
              <input
                type="checkbox"
                checked={chainFilter.has(slug)}
                onChange={() => toggleChain(slug)}
                className="h-4 w-4 shrink-0 accent-gold-400"
              />
              <ChainIcon chainSlug={slug} size={16} className="shrink-0" />
              <span className="flex-1 truncate text-foreground/80">{chainDisplayName(slug)}</span>
              <span className="text-foreground/40">{count}</span>
            </label>
          ))}
        </div>
      </div>
      <div>
        <p className="mb-1.5 text-[0.65rem] font-black uppercase tracking-wider text-foreground/40">Features</p>
        <div className="space-y-1">
          <label className="flex min-h-9 cursor-pointer items-center gap-2 rounded px-1 text-sm hover:bg-foreground/5">
            <input type="checkbox" checked={onlyTradeable} onChange={(e) => setOnlyTradeable(e.target.checked)} className="h-4 w-4 accent-gold-400" />
            <span className="text-foreground/80">Buy / sweep / send enabled</span>
          </label>
          <label className="flex min-h-9 cursor-pointer items-center gap-2 rounded px-1 text-sm hover:bg-foreground/5">
            <input type="checkbox" checked={onlyArt} onChange={(e) => setOnlyArt(e.target.checked)} className="h-4 w-4 accent-gold-400" />
            <span className="text-foreground/80">Has real artwork</span>
          </label>
          <label className="flex min-h-9 cursor-pointer items-center gap-2 rounded px-1 text-sm hover:bg-foreground/5">
            <input
              type="checkbox"
              checked={onlyVerifiedCreator}
              onChange={(e) => setOnlyVerifiedCreator(e.target.checked)}
              className="h-4 w-4 accent-gold-400"
            />
            <span className="text-foreground/80">Known creator (handle / ENS)</span>
          </label>
        </div>
      </div>
      {activeFilterCount > 0 && (
        <button
          type="button"
          onClick={() => {
            setChainFilter(new Set());
            setOnlyTradeable(false);
            setOnlyArt(false);
            setOnlyVerifiedCreator(false);
          }}
          className="min-h-9 w-full rounded-md border border-line px-3 text-xs font-bold text-foreground/60 hover:border-line-strong"
        >
          Clear filters ({activeFilterCount})
        </button>
      )}
    </div>
  );

  return (
    <div className="space-y-4 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-display text-xl text-gold-300">Global Market</h2>
          <p className="text-xs text-foreground/50">
            {collections.length} collection{collections.length === 1 ? "" : "s"} tracked across{" "}
            {chains.length} chain{chains.length === 1 ? "" : "s"} — real listings, buy, sweep, and send on every
            EVM one ({collections.filter((c) => c.tradeable).length} of {collections.length}; Solana rows are
            browse-only for now, see the badge on each card).
          </p>
        </div>
        <Link
          href="/market"
          className="min-h-11 flex items-center rounded-md border border-gold-400/50 px-3 text-sm font-bold text-gold-300 hover:border-gold-400"
        >
          ← Home: RobinWood Planks
        </Link>
      </div>

      {/*
       * Robinhood Chain (4663) is this app's OWN home chain -- Marketplank's
       * native RobinWood plank order book, deliberately excluded from
       * FOREIGN_CHAINS (foreign-chain-registry.ts) because it has its own
       * real trading path, not because it's out of scope for this hub.
       * Flagged live 2026-08-18: it must not be invisible next to 5 foreign
       * chains just because it's architecturally separate. Pinned first,
       * always -- no floor/volume figure fabricated here (that lives on
       * the native /market Buy & Sell tab itself); this is a real,
       * always-true link to the real thing, not a data card.
       */}
      <Link
        href="/market"
        className="dense-card flex items-center gap-3 overflow-hidden border-gold-400/40 p-3 transition-[border-color] hover:border-gold-400"
      >
        <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-md bg-gradient-to-br from-wood-900 to-wood-800 text-2xl font-black text-gold-300">
          RW
        </div>
        <div className="min-w-0 flex-1">
          <span className="inline-flex items-center rounded-full bg-gold-400/15 px-2 py-0.5 text-[0.6rem] font-black uppercase tracking-wider text-gold-300">
            Home chain
          </span>
          <p className="truncate text-lg font-bold text-foreground">RobinWood ($PLANK) — Robinhood Chain</p>
          <p className="text-xs text-foreground/50">This app&apos;s own native order book — full buy, sweep, offers, and rarity tools →</p>
        </div>
      </Link>

      {/*
       * Global Index -- the multi-collection $PLANK basket/vault design in
       * docs/marketplank/SPEC-GLOBAL-INDEX-ULTIMATE-FORM.md. That spec's
       * own status line is explicit and still governs: "nothing here
       * authorizes building or deploying a contract... requires the same
       * external-audit bar V3 received, and still requires the admin's
       * explicit go-ahead to begin." This teaser is purely informational --
       * same "coming soon" pattern as ForeignSwapComingSoon.tsx's
       * per-collection vault placeholder (styled identically: same
       * dense-card shell, same eyebrow-badge/heading/body rhythm), not a
       * feature flag, not a route, not a contract reference. It exists so
       * the hub is honest about what's coming without implying the gated
       * work has started.
       */}
      <div className="dense-card flex items-center gap-3 overflow-hidden border-line p-3 opacity-90">
        <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-md bg-gradient-to-br from-wood-900 to-wood-800 text-2xl font-black text-foreground/40">
          GI
        </div>
        <div className="min-w-0 flex-1">
          <span className="inline-flex items-center rounded-full bg-foreground/10 px-2 py-0.5 text-[0.6rem] font-black uppercase tracking-wider text-foreground/50">
            Coming soon
          </span>
          <p className="truncate text-lg font-bold text-foreground/80">Global Index</p>
          <p className="text-xs text-foreground/50">
            A multi-collection $PLANK basket, pro-rata redeemable across tracked collections — in design, pending
            external audit and go-ahead before any contract work begins.
          </p>
        </div>
      </div>

      {topMovers.length > 0 && (
        <div className="space-y-2">
          <p className="text-[0.65rem] font-black uppercase tracking-wider text-foreground/40">
            Trending now · graded + 24h volume
          </p>
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-[1.4fr_1fr]">
            {/* Immersive large hero: the single highest-graded mover, full art, full stats. */}
            {(() => {
              const hero = topMovers[0];
              const score = gradeScore(hero, true);
              return (
                <Link
                  href={`/market/multichain/${hero.chainSlug}/${encodeURIComponent(hero.contractAddress)}`}
                  className="dense-card group relative flex min-h-[15rem] flex-col justify-end overflow-hidden p-0 transition-[border-color] hover:border-gold-400/60 sm:min-h-[18rem]"
                >
                  <div className="absolute inset-0">
                    <CollectionThumb
                      src={hero.imageUrl}
                      alt={hero.name ?? hero.contractAddress}
                      onFail={() => setDeadArt((prev) => new Set(prev).add(key(hero)))}
                    />
                  </div>
                  <div className="absolute inset-0 bg-gradient-to-t from-black/90 via-black/20 to-transparent transition-opacity group-hover:from-black/95" />
                  <div className="relative space-y-1.5 p-4">
                    <div className="flex items-center gap-1.5">
                      <span className="inline-flex items-center rounded-full bg-gold-400/90 px-2 py-0.5 text-[0.6rem] font-black uppercase tracking-wider text-wood-950">
                        Top mover
                      </span>
                      <GradeBadge score={score} />
                    </div>
                    <p className="truncate text-2xl font-bold text-white drop-shadow">{hero.name ?? hero.contractAddress}</p>
                    <p className="text-sm text-white/75">
                      <span style={{ color: chainBrandColor(hero.chainSlug) }}>{chainDisplayName(hero.chainSlug)}</span>
                      {" · "}Vol {(Number(hero.volume24hWei) / 1e18).toFixed(3)} {hero.floorPriceCurrency ?? "ETH"}
                      {hero.sales24h ? ` · ${hero.sales24h} sales` : ""}
                      {hero.floorPriceWei && ` · Floor ${(Number(hero.floorPriceWei) / 1e18).toFixed(4)} ${hero.floorPriceCurrency ?? "ETH"}`}
                    </p>
                  </div>
                </Link>
              );
            })()}

            {/* Medium strip: the next 5 graded movers, immersive art tiles, 2-up on mobile. */}
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-2">
              {topMovers.slice(1).map((c) => {
                const score = gradeScore(c, true);
                return (
                  <Link
                    key={key(c)}
                    href={`/market/multichain/${c.chainSlug}/${encodeURIComponent(c.contractAddress)}`}
                    className="group relative flex min-h-[6.5rem] flex-col justify-end overflow-hidden rounded-lg border border-line transition-[border-color] hover:border-gold-400/60"
                  >
                    <div className="absolute inset-0">
                      <CollectionThumb
                        src={c.imageUrl}
                        alt={c.name ?? c.contractAddress}
                        onFail={() => setDeadArt((prev) => new Set(prev).add(key(c)))}
                      />
                    </div>
                    <div className="absolute inset-0 bg-gradient-to-t from-black/85 via-black/10 to-transparent" />
                    <div className="relative space-y-0.5 p-2">
                      <GradeBadge score={score} />
                      <p className="truncate text-xs font-bold text-white">{c.name ?? c.contractAddress}</p>
                      <p className="truncate text-[0.65rem] text-white/70">
                        {(Number(c.volume24hWei) / 1e18).toFixed(2)} {c.floorPriceCurrency ?? "ETH"} · 24h
                      </p>
                    </div>
                  </Link>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {rankings.length > 0 && (
        <div className="space-y-2">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <p className="text-[0.65rem] font-black uppercase tracking-wider text-foreground/40">Rankings · 24h</p>
            {chainFilter.size > 0 && (
              <button
                type="button"
                onClick={() => setChainFilter(new Set())}
                className="text-[0.65rem] font-bold text-gold-300 hover:underline"
              >
                Clear chain filter
              </button>
            )}
          </div>

          {/*
           * Chain pills, real logo + full name -- the primary way to narrow
           * this table to one or more chains. Same chainFilter state the
           * sidebar checkboxes and the full grid below already use, so
           * picking a chain here also narrows everything else on the page
           * (one filter concept, not two). Wraps naturally on mobile
           * instead of hiding chains off-screen in a scroll strip.
           */}
          <div className="flex flex-wrap gap-1.5">
            {chains.map(([slug, count]) => {
              const active = chainFilter.has(slug);
              return (
                <button
                  key={slug}
                  type="button"
                  onClick={() => toggleChain(slug)}
                  aria-pressed={active}
                  className="flex min-h-9 items-center gap-1.5 rounded-full border px-3 text-xs font-bold transition-colors"
                  style={
                    active
                      ? { borderColor: chainBrandColor(slug), backgroundColor: `${chainBrandColor(slug)}22`, color: chainBrandColor(slug) }
                      : { borderColor: "var(--color-line)" }
                  }
                >
                  <ChainIcon chainSlug={slug} size={15} className="shrink-0" />
                  <span className={active ? "" : "text-foreground/70"}>{chainDisplayName(slug)}</span>
                  <span className="text-foreground/40">{count}</span>
                </button>
              );
            })}
          </div>

          {/*
           * A dense ranked TABLE, not a card grid -- reverse-engineered from
           * OpenSea's own real rankings page (Collection / Floor / 24h
           * Change / 24h Volume / 24h Sales columns, live-checked
           * 2026-08-19). Wide content scrolls inside its own container
           * (overflow-x-auto) rather than ever widening the page itself.
           * Less critical columns hide below `sm`/`md` so the table stays
           * legible on a phone instead of shrinking every column into
           * unreadable text -- Collection, Floor, and 24h Change (the three
           * things worth a glance on any screen) always show.
           */}
          <div className="overflow-x-auto rounded-lg border border-line bg-panel">
            <table className="w-full min-w-[36rem] border-collapse text-sm">
              <thead>
                <tr className="border-b border-line text-left text-[0.6rem] font-black uppercase tracking-wider text-foreground/40">
                  <th className="w-8 px-2 py-2" />
                  <th className="w-10 px-1 py-2 text-right">#</th>
                  <th className="px-2 py-2">Collection</th>
                  <th className="px-2 py-2 text-right">Floor</th>
                  <th className="px-2 py-2 text-right">24h Change</th>
                  <th className="hidden px-2 py-2 text-right sm:table-cell">24h Volume</th>
                  <th className="hidden px-2 py-2 text-right md:table-cell">24h Sales</th>
                  <th className="hidden px-2 py-2 text-right lg:table-cell">Listed</th>
                  <th className="w-9 px-2 py-2 text-right">Grade</th>
                </tr>
              </thead>
              <tbody>
                {rankings.map((c, i) => {
                  const change = c.floorChangePct;
                  const changeColor = change == null ? "text-foreground/40" : change > 0 ? "text-emerald-400" : change < 0 ? "text-rose-400" : "text-foreground/40";
                  // Directional arrow ALONGSIDE color, not instead of it --
                  // Magic Eden's own table pairs both (live-checked
                  // 2026-08-19); color alone is a weaker signal for anyone
                  // with color-vision deficiency, and an arrow reads faster
                  // than parsing a +/- sign at a glance.
                  const changeArrow = change == null || change === 0 ? "" : change > 0 ? "▲ " : "▼ ";
                  const rowKey = key(c);
                  const watched = watchlist.has(rowKey);
                  const listedPct =
                    c.listedCount != null && c.totalSupply != null && c.totalSupply > 0
                      ? (c.listedCount / c.totalSupply) * 100
                      : null;
                  return (
                    <tr key={rowKey} className="border-b border-line/60 last:border-0 hover:bg-foreground/5">
                      <td className="px-2 py-2 text-center">
                        <button
                          type="button"
                          onClick={() => toggleWatchlist(rowKey)}
                          aria-pressed={watched}
                          aria-label={watched ? "Remove from watchlist" : "Add to watchlist"}
                          className={`text-base leading-none ${watched ? "text-gold-300" : "text-foreground/25 hover:text-foreground/50"}`}
                        >
                          {watched ? "★" : "☆"}
                        </button>
                      </td>
                      <td className="px-1 py-2 text-right text-xs text-foreground/40 tabular-nums">{i + 1}</td>
                      <td className="px-2 py-2">
                        <Link
                          href={`/market/multichain/${c.chainSlug}/${encodeURIComponent(c.contractAddress)}`}
                          className="flex min-w-0 items-center gap-2"
                        >
                          <div className="relative h-9 w-9 shrink-0 overflow-hidden rounded bg-wood-900">
                            <CollectionThumb
                              src={c.imageUrl}
                              alt={c.name ?? c.contractAddress}
                              onFail={() => setDeadArt((prev) => new Set(prev).add(rowKey))}
                            />
                            <span
                              className="absolute -bottom-0.5 -right-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-black/70"
                              title={chainDisplayName(c.chainSlug)}
                            >
                              <ChainIcon chainSlug={c.chainSlug} size={10} />
                            </span>
                          </div>
                          <span className="min-w-0 flex-1 truncate font-bold text-foreground/90">{c.name ?? c.contractAddress}</span>
                          {/* Known-creator checkmark -- real signal (a real handle/ENS this app has observed), never OpenSea's own "verified" claim, which this app cannot honestly assert for an auto-discovered collection. */}
                          {(c.creatorHandle || c.creatorEns) && (
                            <span className="shrink-0 text-emerald-400" title={`Known creator: ${c.creatorHandle ?? c.creatorEns}`}>
                              ✓
                            </span>
                          )}
                        </Link>
                      </td>
                      <td className="whitespace-nowrap px-2 py-2 text-right tabular-nums text-foreground/80">
                        {c.floorPriceWei ? (
                          <>
                            {(Number(c.floorPriceWei) / 1e18).toFixed(3)} {c.floorPriceCurrency ?? ""}
                            {(() => {
                              const usd = toUsd(c.floorPriceWei, c.floorPriceCurrency);
                              return usd != null ? (
                                <span className="ml-1 text-[0.65rem] text-foreground/40">{formatUsdCompact(usd)}</span>
                              ) : null;
                            })()}
                          </>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td className={`whitespace-nowrap px-2 py-2 text-right tabular-nums font-bold ${changeColor}`}>
                        {change != null ? `${changeArrow}${Math.abs(change).toFixed(1)}%` : "—"}
                      </td>
                      <td className="hidden whitespace-nowrap px-2 py-2 text-right tabular-nums text-foreground/60 sm:table-cell">
                        {c.volume24hWei && c.volume24hWei !== "0" ? (Number(c.volume24hWei) / 1e18).toFixed(2) : "—"}
                      </td>
                      <td className="hidden px-2 py-2 text-right tabular-nums text-foreground/60 md:table-cell">
                        {c.sales24h ?? "—"}
                      </td>
                      <td className="hidden whitespace-nowrap px-2 py-2 text-right tabular-nums text-foreground/60 lg:table-cell">
                        {listedPct != null ? `${listedPct.toFixed(1)}% · ${c.listedCount}/${c.totalSupply}` : "—"}
                      </td>
                      <td className="px-2 py-2 text-right">
                        <GradeBadge score={gradeScore(c, true)} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Real "Show top: N" control, Magic Eden's own pattern -- a fixed cutoff either buried most of 3,500+ tracked collections or flooded the page; this lets the reader choose. */}
          <div className="flex items-center gap-1.5 text-xs">
            <span className="text-foreground/40">Show top</span>
            {[10, 25, 50, 100].map((n) => (
              <button
                key={n}
                type="button"
                onClick={() => setRankingsShowCount(n)}
                aria-pressed={rankingsShowCount === n}
                className={`min-h-8 rounded-md border px-2.5 font-bold ${
                  rankingsShowCount === n
                    ? "border-gold-400 bg-gold-400/15 text-gold-300"
                    : "border-line text-foreground/50 hover:border-line-strong"
                }`}
              >
                {n}
              </button>
            ))}
          </div>
        </div>
      )}

      {/*
       * Biggest Movers -- Magic Eden's real secondary strip (live-checked
       * 2026-08-19), a DIFFERENT signal than the rankings table above: pure
       * |24h floor change|, regardless of volume or overall grade. A thin
       * collection can swing hard without much volume behind it -- worth
       * surfacing on its own rather than only inside the bigger table.
       */}
      {biggestMovers.length > 0 && (
        <div className="space-y-2">
          <p className="text-[0.65rem] font-black uppercase tracking-wider text-foreground/40">Biggest movers · 24h</p>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-8">
            {biggestMovers.map((c) => {
              const change = c.floorChangePct!;
              const up = change > 0;
              return (
                <Link
                  key={key(c)}
                  href={`/market/multichain/${c.chainSlug}/${encodeURIComponent(c.contractAddress)}`}
                  className="rounded-lg border border-line bg-panel p-2 transition-[border-color] hover:border-gold-400/60"
                >
                  <div className="relative mb-1.5 aspect-square w-full overflow-hidden rounded bg-wood-900">
                    <CollectionThumb
                      src={c.imageUrl}
                      alt={c.name ?? c.contractAddress}
                      onFail={() => setDeadArt((prev) => new Set(prev).add(key(c)))}
                    />
                    <span
                      className="absolute bottom-1 right-1 flex h-4 w-4 items-center justify-center rounded-full bg-black/70"
                      title={chainDisplayName(c.chainSlug)}
                    >
                      <ChainIcon chainSlug={c.chainSlug} size={10} />
                    </span>
                  </div>
                  <p className="truncate text-xs font-bold text-foreground/90">{c.name ?? c.contractAddress}</p>
                  <p className="truncate text-[0.65rem] text-foreground/50">
                    {c.floorPriceWei ? (
                      <>
                        {(Number(c.floorPriceWei) / 1e18).toFixed(3)} {c.floorPriceCurrency ?? ""}
                        {(() => {
                          const usd = toUsd(c.floorPriceWei, c.floorPriceCurrency);
                          return usd != null ? ` · ${formatUsdCompact(usd)}` : "";
                        })()}
                      </>
                    ) : (
                      "—"
                    )}
                  </p>
                  <p className={`text-xs font-bold tabular-nums ${up ? "text-emerald-400" : "text-rose-400"}`}>
                    {up ? "▲ " : "▼ "}
                    {Math.abs(change).toFixed(1)}%
                  </p>
                </Link>
              );
            })}
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-line bg-panel p-2.5">
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search collection name…"
          className="min-h-10 flex-1 min-w-[10rem] rounded-md border border-line bg-background px-3 text-sm text-foreground placeholder:text-foreground/30"
        />
        <select
          value={sortMode}
          onChange={(e) => setSortMode(e.target.value as SortMode)}
          className="min-h-10 rounded-md border border-line bg-background px-2 text-sm text-foreground"
          aria-label="Sort collections"
        >
          <option value="trending">Trending (graded)</option>
          <option value="floor-desc">Floor: high to low</option>
          <option value="floor-asc">Floor: low to high</option>
          <option value="name">Name</option>
        </select>
        <button
          type="button"
          onClick={() => setMobileFiltersOpen(true)}
          className="min-h-10 rounded-md border border-line bg-background px-3 text-sm font-bold text-foreground/80 lg:hidden"
        >
          Filters{activeFilterCount > 0 ? ` (${activeFilterCount})` : ""}
        </button>
      </div>

      <div className="flex gap-4">
        <aside className="hidden w-56 shrink-0 rounded-lg border border-line bg-panel p-3 lg:block">{filterPanel}</aside>

        <div className="min-w-0 flex-1">
          {filtered.length === 0 ? (
            <p className="p-6 text-center text-foreground/45">No collections match.</p>
          ) : (
            <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4">
              {filtered.map((c) => (
                <li key={key(c)}>
                  <Link
                    href={`/market/multichain/${c.chainSlug}/${encodeURIComponent(c.contractAddress)}`}
                    className="dense-card flex flex-col overflow-hidden p-0 transition-[transform,border-color] duration-150 hover:-translate-y-0.5 hover:border-line-strong"
                  >
                    <div className="relative aspect-square w-full bg-wood-900">
                      <CollectionThumb
                        src={c.imageUrl}
                        alt={c.name ?? c.contractAddress}
                        onFail={() => setDeadArt((prev) => new Set(prev).add(key(c)))}
                      />
                      {/* Chain badge, always on the art -- at-a-glance chain identification via the real brand mark on a translucent disc (readable against any art), same corner-overlay pattern ListingCard uses for rarity tier badges. */}
                      <span
                        className="card-overlay absolute left-1.5 top-1.5 flex h-6 w-6 items-center justify-center rounded-full bg-black/55 shadow backdrop-blur-sm"
                        title={chainDisplayName(c.chainSlug)}
                      >
                        <ChainIcon chainSlug={c.chainSlug} size={15} />
                      </span>
                      {/* Visible composite grade, always -- gradeScore already drives the "Trending" sort; this makes that grading legible on the card itself instead of staying an invisible sort key. Only shown for a graded (art-present) row. */}
                      {hasArt(c) && (
                        <span className="absolute right-1.5 top-1.5">
                          <GradeBadge score={gradeScore(c, true)} />
                        </span>
                      )}
                    </div>
                    <div className="space-y-1 p-2.5">
                      <p className="truncate text-sm font-bold text-foreground">{c.name ?? c.contractAddress}</p>
                      <div className="flex flex-wrap gap-1">
                        <span
                          className="inline-flex w-fit items-center rounded-full px-2 py-0.5 text-[0.55rem] font-black uppercase tracking-wider"
                          style={{ backgroundColor: `${chainBrandColor(c.chainSlug)}26`, color: chainBrandColor(c.chainSlug) }}
                        >
                          {chainDisplayName(c.chainSlug)}
                        </span>
                        {!c.tradeable && (
                          <span
                            className="inline-flex w-fit items-center rounded-full bg-foreground/10 px-2 py-0.5 text-[0.55rem] font-black uppercase tracking-wider text-foreground/50"
                            title="No Seaport-based order book on this chain yet -- browsing only, buy/sweep/send/offers aren't wired here."
                          >
                            Browse only
                          </span>
                        )}
                      </div>
                      {c.floorPriceWei && (
                        <p className="text-xs text-foreground/50">
                          Floor {(Number(c.floorPriceWei) / 1e18).toFixed(4)} {c.floorPriceCurrency ?? "ETH"}
                          {c.floorChangePct !== null && (
                            <span className={`ml-1.5 font-bold ${c.floorChangePct >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                              {c.floorChangePct >= 0 ? "▲" : "▼"} {Math.abs(c.floorChangePct).toFixed(1)}%
                            </span>
                          )}
                        </p>
                      )}
                      {c.volume24hWei && (
                        <p className="text-xs text-foreground/50">
                          Vol {(Number(c.volume24hWei) / 1e18).toFixed(3)} {c.floorPriceCurrency ?? "ETH"} · 24h
                          {c.sales24h ? ` · ${c.sales24h} sales` : ""}
                        </p>
                      )}
                      {(c.creatorHandle || c.creatorEns || c.creatorAddress) && (
                        <p className="truncate text-[0.65rem] text-foreground/40">
                          by{" "}
                          {c.creatorHandle
                            ? `@${c.creatorHandle}`
                            : c.creatorEns
                              ? c.creatorEns
                              : `${c.creatorAddress!.slice(0, 6)}…${c.creatorAddress!.slice(-4)}`}
                        </p>
                      )}
                      {c.recentActivity > 0 && <p className="text-[0.65rem] text-emerald-300/80">{c.recentActivity} transfers · 7d</p>}
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {mobileFiltersOpen && (
        <div className="fixed inset-0 z-50 flex items-end lg:hidden" role="dialog" aria-modal="true">
          <button
            type="button"
            aria-label="Close filters"
            onClick={() => setMobileFiltersOpen(false)}
            className="absolute inset-0 bg-black/60"
          />
          <div className="relative max-h-[80vh] w-full overflow-y-auto rounded-t-2xl border-t border-line bg-panel p-4">
            <div className="mb-3 flex items-center justify-between">
              <p className="font-display text-lg text-gold-300">Filters</p>
              <button
                type="button"
                onClick={() => setMobileFiltersOpen(false)}
                className="min-h-9 min-w-9 rounded-md border border-line px-3 text-sm font-bold text-foreground/70"
              >
                Done
              </button>
            </div>
            {filterPanel}
          </div>
        </div>
      )}
    </div>
  );
}
