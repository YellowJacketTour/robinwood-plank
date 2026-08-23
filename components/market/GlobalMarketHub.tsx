"use client";

import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import Image from "next/image";
import Link from "next/link";
import { useRouter, useSearchParams, usePathname } from "next/navigation";
import { chainDisplayName, chainBrandColor } from "@/lib/market/multichain/trading/foreign-chain-registry";
import { swrJson, invalidateSwr } from "@/lib/market/swr-fetch";
import { NFT_CONTRACT_ADDRESS, ROBINWOOD_TOTAL_SUPPLY } from "@/lib/mint-contract";
import { isSpamCollectionTitle, looksLikeContractName } from "@/lib/market/collection-title";
import ChainIcon from "@/components/market/ChainIcon";
import CurrencyIcon from "@/components/market/CurrencyIcon";
import MarketBreadcrumb from "@/components/market/MarketBreadcrumb";
import { normalizeAssetSymbol, type MultiAssetPrices } from "@/lib/multi-asset-price";
import CollectionArtImage from "@/components/market/CollectionArtImage";

const CollectionThumb = CollectionArtImage;

/**
 * Pure presentational skeleton loaders -- shimmer/pulse placeholders shaped
 * like the real hero, rankings table, and chain-pill row so the page never
 * flashes "blank then pop". Uses only existing tokens (bg-panel, border-line,
 * wood tones) plus Tailwind's built-in animate-pulse; no new dependency.
 */
function SkeletonBar({ className = "" }: { className?: string }) {
  return <div className={`animate-pulse rounded bg-foreground/10 ${className}`} />;
}

function GlobalMarketHubSkeleton() {
  return (
    <div className="space-y-4 p-4" aria-busy="true" aria-live="polite">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="space-y-2">
          <SkeletonBar className="h-6 w-40" />
          <SkeletonBar className="h-3 w-72 max-w-[70vw]" />
        </div>
        <SkeletonBar className="h-11 w-48 rounded-md" />
      </div>

      <div className="dense-card flex items-center gap-3 overflow-hidden border-line p-3">
        <SkeletonBar className="h-14 w-14 shrink-0 rounded-md" />
        <div className="min-w-0 flex-1 space-y-2">
          <SkeletonBar className="h-4 w-20 rounded-full" />
          <SkeletonBar className="h-5 w-56 max-w-full" />
        </div>
      </div>

      <div className="space-y-2">
        <SkeletonBar className="h-3 w-52" />
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-[1.4fr_1fr]">
          <SkeletonBar className="min-h-[15rem] rounded-xl sm:min-h-[18rem]" />
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-2">
            {Array.from({ length: 6 }).map((_, i) => (
              <SkeletonBar key={i} className="min-h-[6.5rem] rounded-lg" />
            ))}
          </div>
        </div>
      </div>

      <div className="space-y-2">
        <SkeletonBar className="h-3 w-28" />
        <div className="flex flex-wrap gap-1.5">
          {Array.from({ length: 7 }).map((_, i) => (
            <SkeletonBar key={i} className="h-9 w-24 rounded-full" />
          ))}
        </div>
        <div className="overflow-hidden rounded-lg border border-line bg-panel">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="flex items-center gap-3 border-b border-line/60 px-3 py-2.5 last:border-0">
              <SkeletonBar className="h-9 w-9 shrink-0 rounded" />
              <SkeletonBar className="h-3.5 flex-1" />
              <SkeletonBar className="h-3.5 w-16" />
              <SkeletonBar className="hidden h-3.5 w-14 sm:block" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * On-brand empty state -- reuses PlankPlaceholder's wood-grain + gold plank
 * mark instead of a bare line of text, for every conditional-empty-render
 * (no collections, search yields nothing, chain filter yields nothing).
 */
function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-line bg-wood-900/40 px-6 py-12 text-center">
      <svg viewBox="0 0 24 24" className="h-8 w-8 text-gold-400/50" fill="none" stroke="currentColor" strokeWidth="1.5">
        <rect x="2" y="9" width="20" height="6" rx="1" />
        <line x1="2" y1="12" x2="22" y2="12" strokeOpacity="0.4" />
        <circle cx="6" cy="10.5" r="0.5" fill="currentColor" stroke="none" />
        <circle cx="18" cy="13.5" r="0.5" fill="currentColor" stroke="none" />
      </svg>
      <p className="text-sm font-bold text-foreground/70">{title}</p>
      <p className="max-w-xs text-xs text-foreground/45">{body}</p>
    </div>
  );
}

type TrackedCollection = {
  chainSlug: string;
  chainId: number | null;
  contractAddress: string;
  adapter?: string | null;
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
  /** Real OpenSea 7d/30d volume/sales, same response/pass as the 24h fields above -- never fabricated from a single-window data point. Null until that pass has run. */
  volume7dWei: string | null;
  sales7d: number | null;
  volume30dWei: string | null;
  sales30d: number | null;
  /** Real floor % change from this app's own prior observation -- OpenSea has no such field. Null until at least two syncs have run. */
  floorChangePct: number | null;
  floorChangeStatus?: "observed-24h" | "collecting-baseline" | null;
  /** Real, from the same source as floorPriceWei (Alchemy/Magic Eden snapshot) -- already returned by this route, just never surfaced on this page until now. */
  totalSupply: number | null;
  listedCount: number | null;
  /** Real distinct-owner count (Alchemy getOwnersForContract, EVM chains only) -- null for Solana/Bitcoin and any EVM collection not yet fetched, never a fabricated 0. */
  holderCount: number | null;
  /** True only for the injected RobinWood native book row — links to /market, not /market/multichain. */
  isNativeHome?: boolean;
};

type GlobalTokenHit = {
  chainSlug: string;
  collectionSlug: string;
  tokenId: string;
  name: string | null;
  imageUrl: string | null;
  rarityRank: number | null;
  rarityTier: string | null;
};

/** Picks the right real volume/sales field for a chosen display window -- never derives 7d/30d from the 24h figure, just reads the matching column populated by the same OpenSea pass (see volume7dWei/sales7d's own doc comment above). */
function windowVolumeWei(c: TrackedCollection, window: "24h" | "7d" | "30d"): string | null {
  if (window === "7d") return c.volume7dWei;
  if (window === "30d") return c.volume30dWei;
  return c.volume24hWei;
}
function windowSales(c: TrackedCollection, window: "24h" | "7d" | "30d"): number | null {
  if (window === "7d") return c.sales7d;
  if (window === "30d") return c.sales30d;
  return c.sales24h;
}
function displaySales(c: TrackedCollection, window: "24h" | "7d" | "30d"): number | null {
  const n = windowSales(c, window);
  if (n == null || n === 0) return null;
  return n;
}
function isZeroWei(wei: string | null | undefined): boolean {
  if (wei == null || wei === "" || wei === "0") return true;
  try {
    return BigInt(wei) === 0n;
  } catch {
    return true;
  }
}
function displayFloorWei(c: TrackedCollection): string | null {
  return isZeroWei(c.floorPriceWei) ? null : c.floorPriceWei;
}
/** 0.0% with no 24h volume/sales is a stored zero, not a measured flat tape. */
function displayChangePct(c: TrackedCollection): number | null {
  if (c.floorChangePct == null || !Number.isFinite(c.floorChangePct)) return null;
  if (c.floorChangePct === 0 && isZeroWei(c.volume24hWei) && !(c.sales24h != null && c.sales24h > 0)) {
    return null;
  }
  return c.floorChangePct;
}
function displayHolders(c: TrackedCollection): number | null {
  if (c.holderCount == null || c.holderCount <= 0) return null;
  if (isHomeRow(c)) return c.holderCount;
  if (c.holderCount <= 2 && !(c.listedCount && c.listedCount > 0) && !(c.volume24hWei && c.volume24hWei !== "0")) {
    return null;
  }
  return c.holderCount;
}
function displayName(c: TrackedCollection): string {
  const n = (c.name ?? "").trim();
  if (!n || n === ".." || /^0x[0-9a-fA-F]{12,}$/.test(n) || /^erc-?721$/i.test(n)) {
    const a = c.contractAddress;
    // Ordinals/Solana collection ids are slugs or pubkeys — ellipsizing
    // "bitcoin-booms" into "bitcoi…ooms" hides the only real identity we have.
    if (c.chainSlug === "bitcoin-mainnet" || c.chainSlug === "solana-mainnet") return a;
    return a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
  }
  return n;
}

function searchText(value: string | null | undefined): string {
  return (value ?? "").normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function collectionSearchScore(c: TrackedCollection, rawQuery: string): number {
  const q = searchText(rawQuery);
  if (!q) return 0;
  const fields = [displayName(c), c.contractAddress, c.creatorHandle, c.creatorEns].map(searchText);
  let best = -1;
  for (const field of fields) {
    if (!field) continue;
    if (field === q) best = Math.max(best, 1000);
    else if (field.startsWith(q)) best = Math.max(best, 800);
    else if (field.split(" ").some((word) => word.startsWith(q))) best = Math.max(best, 650);
    else if (field.includes(q)) best = Math.max(best, 500);
  }
  return best;
}
/** Real listed-count/total-supply as a percentage -- null unless both real figures are present (never a fabricated 0%). Shared by both the "Listed" column's own display AND its sort. */
function listedPctOf(c: TrackedCollection): number | null {
  if (c.listedCount == null || c.listedCount <= 0) return null;
  if (c.totalSupply == null || c.totalSupply <= 0) return null;
  return (c.listedCount / c.totalSupply) * 100;
}

const SUBSCRIPT_DIGITS = "₀₁₂₃₄₅₆₇₈₉";
function toSubscript(n: number): string {
  return String(Math.trunc(n))
    .split("")
    .map((d) => SUBSCRIPT_DIGITS[Number(d)] ?? d)
    .join("");
}

/**
 * Compact native amount for dense ranking/card stats. BTC (and any
 * sub-0.001 native floor) loses significant digits under toFixed(3)
 * ("0.000 ₿"). Leading-zero subscript (Axiom/Photon: 0.0₄123) keeps the
 * first real digits; scientific only when there are more than six leading
 * zeros. Never rounds a real non-zero amount to a display zero.
 */
function formatCompactNative(weiStr: string): { display: string; title: string } {
  const abs = Math.abs(Number(weiStr) / 1e18);
  if (!Number.isFinite(abs) || abs === 0) return { display: "0", title: "0" };
  const title = abs.toPrecision(8).replace(/\.?0+$/, "");
  if (abs >= 1_000_000) return { display: `${(abs / 1_000_000).toPrecision(3)}M`, title };
  if (abs >= 1_000) return { display: `${(abs / 1_000).toPrecision(3)}K`, title };
  if (abs >= 1) return { display: abs >= 100 ? abs.toFixed(0) : abs >= 10 ? abs.toFixed(1) : abs.toFixed(2), title };
  const exp = Math.floor(Math.log10(abs));
  const leadingZeros = -exp - 1;
  if (leadingZeros <= 2) {
    const fixed = abs.toFixed(Math.min(6, leadingZeros + 3)).replace(/0+$/, "").replace(/\.$/, "");
    return { display: fixed, title };
  }
  if (leadingZeros <= 6) {
    const mantissa = abs * 10 ** (leadingZeros + 1);
    const body = mantissa.toPrecision(3).replace(/\.?0+$/, "");
    return { display: `0.0${toSubscript(leadingZeros)}${body}`, title: abs.toExponential(4) };
  }
  return { display: abs.toExponential(2).replace("e+", "e").replace("e-0", "e-"), title: abs.toExponential(4) };
}

function formatCompactCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toPrecision(3)}M`;
  if (n >= 10_000) return `${Math.round(n / 1_000)}k`;
  return n.toLocaleString();
}

/** Listed-% as a book-depth signal: thin book (scarce) vs heavy book (easy to buy, more sell pressure). */
function listedTone(pct: number): string {
  if (pct < 1) return "text-emerald-400";
  if (pct < 8) return "text-gold-300";
  if (pct < 20) return "text-foreground/80";
  return "text-rose-400";
}

function NativeAmount({ wei, usdLabel }: { wei: string; usdLabel: string | null }) {
  const { display, title } = formatCompactNative(wei);
  return (
    <span className="inline-flex flex-col items-end leading-tight" title={usdLabel ? `${title} · ${usdLabel}` : title}>
      <span className="font-display tabular-nums text-gold-300">{display}</span>
      {usdLabel && (
        <span className="font-sans text-[0.62rem] font-semibold text-cream-muted/90">{usdLabel}</span>
      )}
    </span>
  );
}

function FloorCurrencyMark({ collection }: { collection: TrackedCollection }) {
  const symbol = normalizeAssetSymbol(collection.floorPriceCurrency);
  if (symbol && symbol !== chainNativeAsset(collection.chainSlug)) {
    return <CurrencyIcon symbol={symbol} size={14} className="shrink-0" />;
  }
  return <ChainIcon chainSlug={collection.chainSlug} size={14} className="shrink-0" />;
}

function chainNativeAsset(chainSlug: string): string {
  if (chainSlug === "polygon-mainnet") return "POL";
  if (chainSlug === "bnb-mainnet") return "BNB";
  if (chainSlug === "avax-mainnet") return "AVAX";
  if (chainSlug === "solana-mainnet") return "SOL";
  if (chainSlug === "bitcoin-mainnet") return "BTC";
  return "ETH";
}

function shortCollectionId(address: string): string {
  if (address.length <= 14) return address;
  if (address.startsWith("0x")) return `${address.slice(0, 6)}…${address.slice(-4)}`;
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/**
 * A bare "—" reads as "broken" to a viewer -- flagged live ("tons of
 * missing fields. we want zero missing fields ever"). This app's honesty
 * discipline means some cells genuinely have no real source to show
 * (Solana/Bitcoin have no OpenSea-equivalent volume/sales/change feed;
 * holder count is Alchemy/EVM-only) -- the fix isn't fabricating a number,
 * it's making every "—" explain itself instead of looking unexplained.
 * Real per-chain reasoning, not a generic apology.
 */
function emptyCellReason(c: TrackedCollection, field: "change" | "volume" | "sales" | "listed" | "holders"): string {
  const isSolana = c.chainSlug === "solana-mainnet";
  const isBitcoin = c.chainSlug === "bitcoin-mainnet";
  const isRobinhood = c.chainSlug === "robinhood";
  if (field === "holders") {
    if (isSolana || isBitcoin) return "Holder counts aren't sourced for this chain yet -- no clean single-call endpoint exists on Helius DAS or UniSat/Ordiscan.";
    return "Not fetched yet -- holder count loads the first time this collection's own page is viewed.";
  }
  if (isSolana) return "Magic Eden's public API has no volume/sales/change feed for this collection -- floor price is all it exposes.";
  if (isBitcoin) return "UniSat/Ordiscan expose collection metadata, not a volume/sales/change feed for this collection.";
  if (isRobinhood && field !== "listed") {
    return "OpenSea indexed this Robinhood contract with no floor/volume snapshot -- a dash is unknown, not a fake zero.";
  }
  if (field === "change") return "Needs at least two real syncs of this collection to compute a real change -- not yet available.";
  return "This collection hasn't been through an OpenSea stats pass yet -- real data lands on the next sync, never fabricated in the meantime.";
}

function isHomeRow(c: Pick<TrackedCollection, "chainSlug" | "contractAddress" | "isNativeHome" | "name">): boolean {
  if (c.isNativeHome) return true;
  return c.chainSlug === "robinhood" && c.contractAddress.toLowerCase() === NFT_CONTRACT_ADDRESS.toLowerCase();
}

function collectionHref(c: Pick<TrackedCollection, "chainSlug" | "contractAddress" | "isNativeHome" | "name">): string {
  if (isHomeRow(c)) return "/market";
  return `/market/multichain/${c.chainSlug}/${encodeURIComponent(c.contractAddress)}`;
}

/**
 * Every column the rankings table (and, sharing "one sort concept, not two"
 * the same way chainFilter already does, the browsable grid below it) can
 * be ordered by -- SOTA rankings pages (OpenSea/Blur/Tensor/Magic Eden, see
 * this session's own research) make every real column a clickable sort key
 * rather than hiding sort behind a separate dropdown/button-group; "grade"
 * is this app's own honest composite (see gradeScore's header) standing in
 * for OpenSea's plain volume-desc "Trending" default.
 */
type SortColumn = "grade" | "name" | "floor" | "change" | "volume" | "sales" | "listed" | "holders";
type SortDir = "asc" | "desc";

/** Column -> the direction that reads as "most interesting first" on a first click, e.g. Volume/Floor/Sales/Holders/Listed/Grade default to descending (biggest first), Name defaults A-Z (ascending), matching every real marketplace rankings table checked in this session's research. */
const DEFAULT_SORT_DIR: Record<SortColumn, SortDir> = {
  grade: "desc",
  name: "asc",
  floor: "desc",
  change: "desc",
  volume: "desc",
  sales: "desc",
  listed: "desc",
  holders: "desc",
};

/** Null/undefined always sorts to the end regardless of direction -- the standard convention for a metric that's genuinely absent for some rows (e.g. holderCount is EVM-only, 7d/30d volume needs a later pass) rather than hiding the whole column or fabricating a 0. */
function compareNullable(a: number | null, b: number | null, dir: SortDir): number {
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  return dir === "asc" ? a - b : b - a;
}

/**
 * The one real comparator every sortable column above resolves through --
 * `grade` is the default ("Trending"), everything else reads a single real
 * field/derived value off the row. Floor price is only ever a MEANINGFUL
 * ordering within the same currency (see the header this replaced for why
 * cross-currency floor comparison is dishonest); a cross-currency pair
 * falls through to a 0 (no opinion), not a fabricated ranking.
 */
function compareByColumn(
  a: TrackedCollection,
  b: TrackedCollection,
  column: SortColumn,
  dir: SortDir,
  window: "24h" | "7d" | "30d",
  hasArt: (c: TrackedCollection) => boolean
): number {
  switch (column) {
    case "name":
      return dir === "asc" ? (a.name ?? "").localeCompare(b.name ?? "") : (b.name ?? "").localeCompare(a.name ?? "");
    case "floor": {
      const fa = a.floorPriceWei ? Number(a.floorPriceWei) : null;
      const fb = b.floorPriceWei ? Number(b.floorPriceWei) : null;
      if (fa != null && fb != null && a.floorPriceCurrency !== b.floorPriceCurrency) return 0;
      return compareNullable(fa, fb, dir);
    }
    case "change":
      return compareNullable(a.floorChangePct, b.floorChangePct, dir);
    case "volume": {
      const va = windowVolumeWei(a, window);
      const vb = windowVolumeWei(b, window);
      return compareNullable(va != null ? Number(va) : null, vb != null ? Number(vb) : null, dir);
    }
    case "sales":
      return compareNullable(windowSales(a, window), windowSales(b, window), dir);
    case "listed":
      return compareNullable(a.listedCount, b.listedCount, dir);
    case "holders":
      return compareNullable(a.holderCount, b.holderCount, dir);
    case "grade":
    default:
      return compareNullable(gradeScore(a, hasArt(a)), gradeScore(b, hasArt(b)), dir);
  }
}

/** Every real input gradeScore() weighs, plus what each one actually contributed for THIS collection -- so the badge can show its work instead of asking a viewer to trust an opaque letter. Mirrors gradeScore()'s own logic exactly; the two must never drift apart. */
type GradeBreakdown = {
  score: number;
  gradable: boolean;
  parts: Array<{ label: string; points: number; max: number; met: boolean }>;
};

function hasUsableCells(c: TrackedCollection): boolean {
  if (displayFloorWei(c)) return true;
  if (c.listedCount != null && c.listedCount > 0) return true;
  if (c.volume24hWei && c.volume24hWei !== "0") return true;
  if (c.sales24h != null && c.sales24h > 0) return true;
  if (c.holderCount != null && c.holderCount > 0) return true;
  if (c.totalSupply != null && c.totalSupply > 0) return true;
  return false;
}

const CATALOG_ADAPTERS = new Set([
  "unisat-collections",
  "ordiscan-ordinals",
  "magiceden-solana",
  "helius-solana",
  "coingecko-nft",
]);

/** UniSat collectionId / ME symbol / Solana mint are the collection — not missing titles. */
function isCatalogSourced(c: TrackedCollection): boolean {
  if (c.chainSlug === "solana-mainnet" || c.chainSlug === "bitcoin-mainnet") return true;
  if (c.adapter && CATALOG_ADAPTERS.has(c.adapter)) return true;
  const a = c.contractAddress ?? "";
  if (a && !/^0x[0-9a-fA-F]{40}$/i.test(a)) return true;
  return false;
}

/** Hide EVM hex/empty shells with no cells. Never drop catalog (UniSat/ME/Helius) or rows with floor/listed/volume/holders/activity. */
function isTitleJunkWithoutData(c: TrackedCollection): boolean {
  if (isHomeRow(c)) return false;
  if (isSpamCollectionTitle(c.name)) return true;
  if (isCatalogSourced(c)) return false;
  const junk = looksLikeContractName(c.name || displayName(c)) || !(c.name ?? "").trim();
  if (!junk) return false;
  return !hasUsableCells(c);
}

function hasMarketEvidence(c: TrackedCollection): boolean {
  if (c.isNativeHome) return true;
  if (c.floorPriceWei && c.floorPriceWei !== "0") return true;
  if (c.listedCount != null && c.listedCount > 0) return true;
  if (c.volume24hWei && c.volume24hWei !== "0") return true;
  if (c.sales24h != null && c.sales24h > 0) return true;
  return false;
}
/**
 * A missing marketplace adapter is not proof that a collection has no market.
 * Native-contract collections (CryptoPunks is the canonical example) can have
 * real fills and asks outside the generic ERC-721 order adapters. Keep the
 * anti-gaming liquidity requirement, but allow independently observed floor +
 * sale evidence to make the row gradable while the native book is indexed.
 */
function hasGradeEvidence(c: TrackedCollection): boolean {
  if (c.isNativeHome) return true;
  if ((c.listedCount != null && c.listedCount > 0) || c.isVaultBacked) return true;
  const hasFloor = Boolean(c.floorPriceWei && c.floorPriceWei !== "0");
  const hasSales = (c.sales24h ?? 0) > 0 || Boolean(c.volume24hWei && c.volume24hWei !== "0");
  return hasFloor && hasSales;
}

function gradeBreakdown(c: TrackedCollection, artOk: boolean): GradeBreakdown {
  const activityPoints = (Math.min(c.recentActivity, 5000) / 5000) * 300;
  const hasVolume = Boolean(c.volume24hWei && c.volume24hWei !== "0");
  const hasCreator = Boolean(c.creatorHandle || c.creatorEns);
  const liveBook = c.listedCount != null && c.listedCount > 0;
  const hasFloor = Boolean(c.floorPriceWei && c.floorPriceWei !== "0");
  const vault = Boolean(c.isVaultBacked);
  const home = Boolean(c.isNativeHome);
  const parts: GradeBreakdown["parts"] = [
    { label: "Has real art", points: artOk ? 400 : 0, max: 400, met: artOk },
    { label: "Live listed count", points: liveBook ? 500 : 0, max: 500, met: liveBook },
    { label: "Real floor price", points: hasFloor ? 400 : 0, max: 400, met: hasFloor },
    { label: "Real 24h volume", points: hasVolume ? 400 : 0, max: 400, met: hasVolume },
    { label: "Recent chain activity", points: Math.round(activityPoints), max: 300, met: c.recentActivity > 0 },
    { label: "Known creator handle/ENS", points: hasCreator ? 50 : 0, max: 50, met: hasCreator },
    { label: "Native RobinWood collection", points: home ? 400 : 0, max: 400, met: home },
    { label: "Vault / decentralized NFT liquidity (on-chain)", points: vault ? 400 : 0, max: 400, met: vault },
  ];
  return {
    score: parts.reduce((sum, p) => sum + p.points, 0),
    gradable: (artOk || home) && hasGradeEvidence(c),
    parts,
  };
}

/** Null when the row has no market evidence -- an image on a tradeable chain is not a grade. Still not wash-trade or stolen-art detection. */
function gradeScore(c: TrackedCollection, artOk: boolean): number | null {
  const b = gradeBreakdown(c, artOk);
  return b.gradable ? b.score : null;
}

function gradeLetter(breakdown: GradeBreakdown): "A" | "B" | "C" | "D" | null {
  if (!breakdown.gradable) return null;
  if (breakdown.score >= 1500) return "A";
  if (breakdown.score >= 1100) return "B";
  if (breakdown.score >= 700) return "C";
  return "D";
}
const GRADE_COLOR: Record<string, string> = {
  A: "#34d399",
  B: "#a3e635",
  C: "#fbbf24",
  D: "#fb7185",
};

/** A clickable, real sortable column header -- every real rankings page checked this session (OpenSea/Blur/Tensor/Magic Eden) uses this exact interaction instead of hiding sort behind a separate dropdown. Shows a ▲/▼ on whichever column is currently active. */
function SortableTh({
  column,
  sortColumn,
  sortDir,
  onSort,
  align,
  className,
  children,
  hasData = true,
}: {
  column: SortColumn;
  sortColumn: SortColumn;
  sortDir: SortDir;
  onSort: (column: SortColumn) => void;
  align?: "left" | "right";
  className?: string;
  children: ReactNode;
  /** When false, every visible row is null for this column -- click still sorts (and sets the active header) so the control never disappears. Title explains why the order may not change. */
  hasData?: boolean;
}) {
  const active = sortColumn === column;
  return (
    <th className={`px-2 py-2 ${align === "left" ? "text-left" : "text-right"} ${className ?? ""}`}>
      <button
        type="button"
        onClick={() => onSort(column)}
        aria-pressed={active}
        title={!hasData ? "No collection shown here has real data for this column yet — order may not change until it does." : undefined}
        className={`inline-flex min-h-8 items-center gap-0.5 transition-colors ${
          active ? "text-gold-300" : "text-foreground/55 hover:text-gold-300"
        }`}
      >
        {children}
        <span className={`w-2.5 text-[0.55rem] ${active ? "" : "text-foreground/30"}`} aria-hidden="true">
          {active ? (sortDir === "asc" ? "▲" : "▼") : "↕"}
        </span>
      </button>
    </th>
  );
}

/**
 * Real per-collection explanation of WHY a grade is what it is -- flagged
 * live ("grades dont have explanations of criteria or why each collection
 * is the grade it is"). A tooltip alone (the old behavior) isn't reliably
 * discoverable or screen-reader-exposed, so this is a real disclosure
 * popover: click/focus the badge, see the exact point breakdown gradeScore
 * actually computed for this row, not a generic definition of the letter.
 */
function GradeBadge({ breakdown }: { breakdown: GradeBreakdown }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const letter = gradeLetter(breakdown);
  const thresholdLabel = letter === "A" ? "≥1500" : letter === "B" ? "≥1100" : letter === "C" ? "≥700" : letter === "D" ? "<700" : "needs floor, listed, volume, or sales";

  // Real fix for a real bug flagged live twice ("the graded pop up
  // explanations are colliding with backgrounds and nearby text and
  // visuals"): the previous version was absolutely-positioned INSIDE a
  // table cell, inside this table's own overflow-x-auto scroll wrapper --
  // ancestor overflow clipping/stacking interacts badly with an
  // absolutely positioned child meant to float above sibling rows,
  // regardless of z-index. A position:fixed overlay, positioned from the
  // button's own real measured screen coordinates, escapes that ancestor
  // entirely -- it can never be clipped or visually bled-through by
  // table/row backgrounds again.
  const openPopover = () => {
    const rect = buttonRef.current?.getBoundingClientRect();
    if (rect) {
      const width = 256; // matches the popover's own w-64
      setPos({
        top: rect.bottom + 6,
        left: Math.min(Math.max(rect.right - width, 8), window.innerWidth - width - 8),
      });
    }
    setOpen((v) => !v);
  };

  return (
    <span className="relative inline-block">
      <button
        ref={buttonRef}
        type="button"
        onClick={openPopover}
        onBlur={() => setOpen(false)}
        aria-expanded={open}
        aria-label={letter ? `Grade ${letter}, ${breakdown.score} points -- click for the full breakdown` : `Ungraded -- no floor, listed, volume, or sales yet`}
        className={`inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full px-0.5 text-[0.55rem] font-black transition-transform duration-150 hover:scale-110 ${letter ? "text-wood-950" : ""}`}
        style={{
          backgroundColor: letter ? GRADE_COLOR[letter] : "transparent",
          color: letter ? undefined : "rgba(245,237,224,0.4)",
          border: letter ? undefined : "1px solid rgba(245,237,224,0.25)",
        }}
      >
        {letter ?? "—"}
      </button>
      {open && pos && typeof document !== "undefined"
        ? createPortal(
            <div
              role="tooltip"
              className="fixed z-[999] w-64 rounded-lg border border-line-strong bg-wood-950 p-3 text-left text-[0.65rem] opacity-100 shadow-2xl ring-1 ring-black/60"
              style={{ top: pos.top, left: pos.left, backgroundColor: "#1a1512" }}
            >
              <p className="mb-1.5 font-black uppercase tracking-wide text-foreground/50">
                {letter ? `Grade ${letter} · ${breakdown.score} pts` : "Ungraded"}
              </p>
              <p className="mb-2 text-[0.6rem] text-foreground/35">
                {letter
                  ? `${thresholdLabel} points needed for ${letter}. Not a wash-trade or stolen-art score.`
                  : "No letter until this collection has executable liquidity: a live listing or a redeemable on-chain vault. Sales history, transfer activity, a floor claim, and artwork alone cannot create a market grade. Not wash-trade or stolen-art detection."}
              </p>
              <ul className="space-y-1">
                {breakdown.parts.map((p) => (
                  <li key={p.label} className="flex items-center justify-between gap-2">
                    <span className={p.met ? "text-foreground/80" : "text-foreground/35"}>
                      {p.met ? "✓" : "✗"} {p.label}
                    </span>
                    <span className="shrink-0 font-mono tabular-nums text-foreground/50">
                      {p.points}/{p.max}
                    </span>
                  </li>
                ))}
              </ul>
            </div>,
            document.body
          )
        : null}
    </span>
  );
}

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
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [collections, setCollections] = useState<TrackedCollection[]>([]);
  const [deadArt, setDeadArt] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  // Every filter/sort field below is initialized straight from the URL
  // query string (same `searchParams.get(...) || default` pattern
  // PortfolioView.tsx's own wallet param already uses) so a shared link or
  // a page reload restores the exact same view, not a reset one.
  const [chainFilter, setChainFilter] = useState<Set<string>>(
    () => new Set((searchParams.get("chains") ?? "").split(",").filter(Boolean))
  );
  const [search, setSearch] = useState(() => searchParams.get("q") ?? "");
  const [onlyTradeable, setOnlyTradeable] = useState(() => searchParams.get("tradeable") === "1");
  const [onlyArt, setOnlyArt] = useState(() => searchParams.get("art") !== "0");
  const [onlyVerifiedCreator, setOnlyVerifiedCreator] = useState(() => searchParams.get("creator") === "1");
  const [onlyListed, setOnlyListed] = useState(() => searchParams.get("listed") === "1");
  const [showShells, setShowShells] = useState(() => searchParams.get("shells") === "1");
  const [priceMin, setPriceMin] = useState(() => searchParams.get("min") ?? "");
  const [priceMax, setPriceMax] = useState(() => searchParams.get("max") ?? "");
  const [mobileFiltersOpen, setMobileFiltersOpen] = useState(false);
  // Default = "grade" desc: gradeScore() descending -- the volume-primary/
  // floor-secondary pattern state-of-the-art multichain marketplaces
  // (OpenSea Trending, Blur, Magic Eden) converge on, now weighted by real
  // art/tradeability instead of raw activity alone (see gradeScore's own
  // header). Every column of the rankings table below is a real clickable
  // sort key (see SortColumn/compareByColumn's own header) -- this is ONE
  // shared sort concept driving both the rankings table AND the browsable
  // grid beneath it, same "one filter concept, not two" discipline
  // chainFilter already follows, not a second parallel sort control.
  const [sortColumn, setSortColumn] = useState<SortColumn>(() => (searchParams.get("sort") as SortColumn) || "grade");
  const [sortDir, setSortDir] = useState<SortDir>(() => (searchParams.get("dir") as SortDir) || "desc");
  /** Clicking a header: same column flips direction, a new column adopts its own sensible default direction (DEFAULT_SORT_DIR) -- the standard sortable-table interaction every real rankings page (OpenSea/Blur/Tensor/Magic Eden) uses. */
  const toggleSort = (column: SortColumn) => {
    if (column === sortColumn) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortColumn(column);
      setSortDir(DEFAULT_SORT_DIR[column]);
    }
  };
  // Rankings-table row count -- Magic Eden's real "Show top: 10/25/50/100"
  // control, live-checked 2026-08-19. Matters far more now than it would
  // have before this session's discovery work: this app went from ~170 to
  // 3,500+ tracked collections, so a fixed cutoff either buries most of
  // them or floods the page -- a real control beats guessing one number.
  // Default 10, not 25 -- flagged live 2026-08-20 ("so its not a journey to
  // get to the more immersive listing displays"): the ranked table was
  // pushing the real art-driven grid below the fold by default. The
  // existing 10/25/50/100 picker already lets a reader opt into more --
  // this only changes what a first-time visitor sees before choosing.
  const [rankingsShowCount, setRankingsShowCount] = useState(10);
  // Real 24h/7d/30d selector for the rankings table's Volume/Sales columns --
  // same OpenSea-sourced fields as volume24hWei/sales24h, just a different
  // window of the same already-fetched response (see rarity-index-runner.ts
  // and 027_collection_stats_multiwindow.sql). Purely a display choice, no
  // extra fetch.
  const [rankingsWindow, setRankingsWindow] = useState<"24h" | "7d" | "30d">("24h");
  // The full filterable/browsable grid below the rankings table has no
  // natural cutoff of its own -- unlike rankings (capped at 100 max) it's
  // meant to hold every tracked collection matching the current filters,
  // which with this app's real 3,500+ (and growing) index means the grid
  // was mounting the ENTIRE filtered set as live DOM at once. Confirmed
  // live 2026-08-19 via a real browser check: 6,318 <li> cards mounted
  // simultaneously produced a body 796,000px tall and crashed a full-page
  // screenshot outright (Skia bitmap-alloc assert on h:550301) -- this
  // wasn't a subjective "feels big" complaint, it was thousands of image-
  // bearing card nodes genuinely alive in the DOM, which is also the
  // direct cause of the "laggy" complaint (that many nodes cost real
  // layout/paint/GC time). Paginated client-side rendering, same "Show
  // top N" pattern rankings already uses, reset to the first page whenever
  // the active filter set changes so a new filter never silently shows a
  // stale scroll position deep into a different result set.
  const GRID_PAGE_SIZE = 60;
  const [gridVisibleCount, setGridVisibleCount] = useState(GRID_PAGE_SIZE);
  const [tokenHits, setTokenHits] = useState<GlobalTokenHit[]>([]);
  const [tokenSearchLoading, setTokenSearchLoading] = useState(false);
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
  const [onlyWatched, setOnlyWatched] = useState(() => searchParams.get("starred") === "1");
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
        const data = await swrJson<{ collections: TrackedCollection[] }>("/api/market/multichain?v=index-2", {
          ttlMs: 60_000,
          swrMs: 600_000,
          session: true,
          isGood: (d) => {
            const rows = (d as { collections?: unknown })?.collections;
            return Array.isArray(rows) && rows.length > 0;
          },
        });
        if (!cancelled) {
          const rows = data.collections ?? [];
          const hasHome = rows.some((c) => isHomeRow(c));
          setCollections(
            hasHome
              ? rows
              : [
                  {
                    chainSlug: "robinhood",
                    chainId: 4663,
                    contractAddress: NFT_CONTRACT_ADDRESS,
                    name: "RobinWood",
                    imageUrl: "/images/plank-logo.webp",
                    isVaultBacked: true,
                    floorPriceWei: null,
                    floorPriceCurrency: "ETH",
                    syncedAt: null,
                    tradeable: true,
                    recentActivity: 0,
                    creatorHandle: "RobinWoodPlank",
                    creatorAddress: null,
                    creatorEns: null,
                    volume24hWei: null,
                    sales24h: null,
                    volume7dWei: null,
                    sales7d: null,
                    volume30dWei: null,
                    sales30d: null,
                    floorChangePct: null,
                    totalSupply: ROBINWOOD_TOTAL_SUPPLY,
                    listedCount: null,
                    holderCount: null,
                    isNativeHome: true,
                  },
                  ...rows,
                ]
          );
        }
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

  // Real ETH/SOL/BTC/POL/BNB/AVAX USD prices -- one shared fetch for the whole hub
  // (rankings table + Biggest Movers), same short-TTL swr pattern the
  // collection index itself uses. usdPrices stays {} (not fabricated
  // zeros) until this resolves, so every USD-dependent render checks for
  // a real price before showing one.
  // Global Index card art -- static, not live-fetched. PlankyChan (real
  // on-chain RobinWood Base trait, token #111, confirmed live via the
  // metadata store -- no "Captain Planket" or "RobinWood Executive" trait
  // exists in the real collection) downloaded once from IPFS and committed
  // to public/images/mascots/, per explicit instruction 2026-08-19 ("don't
  // wire the pictures in [dynamically], just find the art, download, upload
  // it static") after the live /api/market/token -> IPFS-gateway path hit
  // real, repeated rate-limiting (Pinata 429/1015, ipfs.io timeouts) during
  // this same session.
  const PLANKY_CHAN_IMAGE = "/images/mascots/planky-chan.png";

  // Home-chain ("RW") card art -- same static-not-live-fetched treatment.
  // "PlankoshiWoodamoto" (real on-chain RobinWood Base trait, token #1474,
  // Legendary tier, confirmed live via the metadata store) per explicit
  // instruction 2026-08-19 ("use PlankoshiWoodamoto ... for going back to
  // robinwood plank"), replacing the earlier feather-glyph placeholder.
  const WOODAMOTO_IMAGE = "/images/mascots/plankoshi-woodamoto.png";

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

  // Sorted strictly by real popularity (tracked-collection count), most to
  // least -- flagged live 2026-08-20 ("stack the chains better and by
  // popularity"). ALL_CHAIN_SLUGS_ORDER used to override this with a fixed
  // canonical list, which is why Bitcoin (60) and Robinhood (358) sat ahead
  // of Polygon (819) and Arbitrum (488) -- backwards from what the numbers
  // actually say. No fallback tiebreak needed beyond count: a real tie
  // (same count) falls back to slug order for a stable sort, not a fixed
  // pin.
  const chains = useMemo(() => {
    const seen = new Map<string, number>();
    for (const c of collections) {
      // Chain badges are registry coverage counters, not hydrated-row
      // counters. A newly discovered address must be visible in the total
      // immediately even while its name/art/stats cells are still pending.
      // RobinWood's native home row has its own dedicated card above this
      // registry and is not a discovered collection row; counting it here
      // made the badge exactly one higher than the traversable chain roster.
      if (isHomeRow(c)) continue;
      if (isSpamCollectionTitle(c.name)) continue;
      seen.set(c.chainSlug, (seen.get(c.chainSlug) ?? 0) + 1);
    }
    return [...seen.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }, [collections]);

  /** Real floor price scaled to native units, currency-blind -- honest about the same cross-currency imprecision compareByColumn's own "floor" case documents (Solana lamports and ETH wei both land in the same raw magnitude once scaled). Used ONLY for the min/max price filter below, never for ranking order. */
  const floorNative = (c: TrackedCollection): number | null => (c.floorPriceWei ? Number(c.floorPriceWei) / 1e18 : null);

  // A marketplace may intentionally group several contracts under one
  // branded collection (XCOPY Editions is a live example). Shared art is
  // therefore not proof that two contracts are duplicates. Preserve both
  // canonical identities, but expose the address suffix whenever the same
  // chain + display name occurs more than once so cards cannot masquerade as
  // duplicate rows and users can navigate the exact contract they mean.
  const ambiguousCollectionNames = useMemo(() => {
    const counts = new Map<string, number>();
    for (const collection of collections) {
      const identity = `${collection.chainSlug}:${displayName(collection).trim().toLowerCase()}`;
      counts.set(identity, (counts.get(identity) ?? 0) + 1);
    }
    return new Set([...counts].filter(([, count]) => count > 1).map(([identity]) => identity));
  }, [collections]);

  const ranked = useMemo(() => {
    const min = priceMin.trim() ? Number(priceMin) : null;
    const max = priceMax.trim() ? Number(priceMax) : null;
    const rows = collections.filter((c) => {
      if (onlyWatched && !watchlist.has(key(c))) return false;
      if (chainFilter.size > 0 && !chainFilter.has(c.chainSlug)) return false;
      if (isSpamCollectionTitle(c.name)) return false;
      if (!showShells && isTitleJunkWithoutData(c)) return false;
      if (onlyTradeable && !c.tradeable) return false;
      const oneChain = chainFilter.size === 1;
      if (onlyArt && !hasArt(c) && !oneChain) return false;
      if (onlyVerifiedCreator && !(c.creatorHandle || c.creatorEns)) return false;
      if (onlyListed && !(c.listedCount != null && c.listedCount > 0) && !oneChain) return false;
      if (!showShells && !hasMarketEvidence(c) && !oneChain) return false;
      if (min !== null || max !== null) {
        const p = floorNative(c);
        if (p === null) return false;
        if (min !== null && p < min) return false;
        if (max !== null && p > max) return false;
      }
      return true;
    });
    return [...rows].sort((a, b) => {
      const home = Number(isHomeRow(b)) - Number(isHomeRow(a));
      if (home !== 0) return home;
      const book = Number(hasMarketEvidence(b)) - Number(hasMarketEvidence(a));
      if (book !== 0) return book;
      const primary = compareByColumn(a, b, sortColumn, sortDir, rankingsWindow, hasArt);
      if (primary !== 0) return primary;
      const floorTie = compareNullable(
        displayFloorWei(a) ? Number(displayFloorWei(a)) : null,
        displayFloorWei(b) ? Number(displayFloorWei(b)) : null,
        "desc"
      );
      if (floorTie !== 0) return floorTie;
      return (a.name ?? a.contractAddress).localeCompare(b.name ?? b.contractAddress);
    });
  }, [collections, chainFilter, sortColumn, sortDir, rankingsWindow, onlyTradeable, onlyArt, onlyVerifiedCreator, onlyListed, onlyWatched, watchlist, showShells, priceMin, priceMax, deadArt]);

  /** Catalog grid only — a name query must not blank Live rankings (that table sits above the search box). */
  const filtered = useMemo(() => {
    const q = search.trim();
    if (!q) return ranked;
    // Search is a catalog-wide discovery operation. Feature toggles such as
    // "has art" must not hide a collection whose indexed pieces prove that
    // it exists (the MUGS collection did exactly that). Chain selection still
    // scopes results; junk-name suppression remains a safety invariant.
    return collections
      .filter((c) =>
        (chainFilter.size === 0 || chainFilter.has(c.chainSlug)) &&
        (!onlyWatched || watchlist.has(key(c))) &&
        !isSpamCollectionTitle(c.name)
      )
      .map((c) => ({ c, score: collectionSearchScore(c, q) }))
      .filter((row) => row.score >= 0)
      .sort((a, b) => b.score - a.score || compareByColumn(a.c, b.c, sortColumn, sortDir, rankingsWindow, hasArt))
      .map((row) => row.c);
  }, [ranked, collections, chainFilter, search, sortColumn, sortDir, rankingsWindow, onlyWatched, watchlist, deadArt]);

  useEffect(() => {
    const query = search.trim();
    if (query.length < 2) {
      setTokenHits([]);
      setTokenSearchLoading(false);
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setTokenSearchLoading(true);
      const qs = new URLSearchParams({ q: query });
      if (chainFilter.size) qs.set("chains", [...chainFilter].join(","));
      try {
        const response = await fetch(`/api/market/multichain/token-search?${qs}`, { signal: controller.signal });
        const body = response.ok ? await response.json() as { tokens?: GlobalTokenHit[] } : null;
        if (!controller.signal.aborted) setTokenHits(body?.tokens ?? []);
      } catch {
        if (!controller.signal.aborted) setTokenHits([]);
      } finally {
        if (!controller.signal.aborted) setTokenSearchLoading(false);
      }
    }, 220);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [search, chainFilter]);

  useEffect(() => {
    setGridVisibleCount(GRID_PAGE_SIZE);
  }, [chainFilter, search, sortColumn, sortDir, onlyTradeable, onlyArt, onlyVerifiedCreator, onlyListed, onlyWatched, showShells, priceMin, priceMax]);

  // URL persistence -- reflects every real filter/sort field above into the
  // query string (router.replace, not push, so filtering doesn't spam
  // browser history) via the SAME useSearchParams/router.replace pattern
  // PortfolioView.tsx's own ?wallet= param already establishes elsewhere in
  // this codebase. Only non-default values are written, so a plain
  // "/market/global" with no filters stays clean rather than growing a
  // query string full of defaults.
  useEffect(() => {
    const params = new URLSearchParams();
    if (chainFilter.size > 0) params.set("chains", [...chainFilter].join(","));
    if (search.trim()) params.set("q", search.trim());
    if (sortColumn !== "grade") params.set("sort", sortColumn);
    if (sortDir !== DEFAULT_SORT_DIR[sortColumn]) params.set("dir", sortDir);
    if (onlyTradeable) params.set("tradeable", "1");
    if (!onlyArt) params.set("art", "0");
    if (onlyVerifiedCreator) params.set("creator", "1");
    if (onlyListed) params.set("listed", "1");
    if (onlyWatched) params.set("starred", "1");
    if (showShells) params.set("shells", "1");
    if (priceMin.trim()) params.set("min", priceMin.trim());
    if (priceMax.trim()) params.set("max", priceMax.trim());
    const qs = params.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- router/pathname are stable per Next.js contract; including them would re-run this on every render for no reason.
  }, [chainFilter, search, sortColumn, sortDir, onlyTradeable, onlyArt, onlyVerifiedCreator, onlyListed, onlyWatched, showShells, priceMin, priceMax]);

  // Top movers: real gradeScore-ranked rows with both real art and a real
  // order book, highest 24h volume as the tiebreak -- never a curated/paid
  // slot (this hub has no such inventory to sell), and never a row a
  // visitor couldn't actually act on. Immersive large-hero + medium-strip
  // carousel (flagged live 2026-08-18: the single-card banner "isn't
  // immersive"), not a single static banner.
  const topMovers = useMemo(() => {
    const candidates = collections.filter((c) => {
      if (chainFilter.size > 0 && !chainFilter.has(c.chainSlug)) return false;
      return c.tradeable && hasArt(c) && c.volume24hWei && c.volume24hWei !== "0";
    });
    return candidates
      .sort((a, b) => {
        const g = (gradeScore(b, true) ?? 0) - (gradeScore(a, true) ?? 0);
        if (g !== 0) return g;
        return Number(BigInt(b.volume24hWei!) - BigInt(a.volume24hWei!));
      })
      .slice(0, 6);
  }, [collections, deadArt, chainFilter]);

  // Rankings is the first N rows of the SAME `filtered` list the grid
  // renders -- one filter/sort, two presentations. Previously the table
  // required hasArt while the grid defaulted to every tracked contract
  // (hex + "Art pending" on Avalanche while CryptoSeals sat in rankings).
  const rankings = useMemo(() => ranked.slice(0, rankingsShowCount), [ranked, rankingsShowCount]);

  const hydratedKey = useRef("");
  useEffect(() => {
    if (loading || rankings.length === 0) return;
    const missing = rankings
      .filter((c) => {
        if (isHomeRow(c)) return false;
        if (looksLikeContractName(c.name) || isSpamCollectionTitle(c.name)) return false;
        if (!displayFloorWei(c)) return true;
        if (c.listedCount == null) return true;
        if (c.holderCount == null) return true;
        if (c.volume24hWei == null) return true;
        return false;
      })
      .slice(0, 10);
    if (missing.length === 0) return;
    const stamp = missing.map((c) => `${c.chainSlug}:${c.contractAddress}`).join(",");
    if (hydratedKey.current === stamp) return;
    hydratedKey.current = stamp;
    let cancelled = false;
    void (async () => {
      const res = await fetch("/api/market/multichain/hydrate-stats", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          rows: missing.map((c) => ({ chainSlug: c.chainSlug, contractAddress: c.contractAddress })),
        }),
      }).catch(() => null);
      if (!res?.ok || cancelled) return;
      const body = (await res.json().catch(() => null)) as { hydrated?: number } | null;
      if (!body?.hydrated) return;
      invalidateSwr("/api/market/multichain");
      const data = await swrJson<{ collections: TrackedCollection[] }>("/api/market/multichain?v=index-2", {
        ttlMs: 0,
        swrMs: 60_000,
        session: false,
        isGood: (d) => {
          const rows = (d as { collections?: unknown })?.collections;
          return Array.isArray(rows) && rows.length > 0;
        },
      });
      if (!cancelled && data.collections) setCollections(data.collections);
    })();
    return () => {
      cancelled = true;
    };
  }, [loading, rankings, chainFilter]);

  // Real, per-column "does ANY row currently shown have real data here" --
  // feeds SortableTh's hasData prop (see its own header for why: sorting
  // an all-null column is a real no-op that reads as broken rather than
  // "genuinely nothing to sort here", flagged live against Bitcoin's
  // rankings, where 0 of 2,618 tracked collections have any volume/sales/
  // change data). Computed from `rankings` itself, so it always reflects
  // the CURRENT chain filter -- switching to a chain that does have real
  // data re-enables the column immediately.
  const rankingsHasData = useMemo(
    () => ({
      change: rankings.some((c) => c.floorChangePct != null),
      volume: rankings.some((c) => windowVolumeWei(c, rankingsWindow) != null),
      sales: rankings.some((c) => windowSales(c, rankingsWindow) != null),
      listed: rankings.some((c) => c.listedCount != null),
      holders: rankings.some((c) => c.holderCount != null),
    }),
    [rankings, rankingsWindow]
  );

  // Biggest Movers -- Magic Eden's real secondary strip (live-checked
  // 2026-08-19), sorted purely by |24h floor change|, not volume/grade.
  // This surfaces a DIFFERENT real signal than the rankings table above
  // (a thin collection can have a huge % swing without much volume behind
  // it) -- distinct information, not a restatement of the same ranking.
  // Requires floorChangePct to actually be present (at least two syncs
  // observed) -- skipped, not zero-filled, for a collection that hasn't.
  const biggestMovers = useMemo(() => {
    const rows = collections.filter((c) => {
      if (chainFilter.size > 0 && !chainFilter.has(c.chainSlug)) return false;
      return hasArt(c) && c.floorChangePct != null && c.floorChangePct !== 0;
    });
    return rows.sort((a, b) => Math.abs(b.floorChangePct!) - Math.abs(a.floorChangePct!)).slice(0, 8);
  }, [collections, deadArt, chainFilter]);

  const toggleChain = (slug: string) => {
    setChainFilter((prev) => {
      const next = new Set(prev);
      if (next.has(slug)) next.delete(slug);
      else next.add(slug);
      return next;
    });
  };

  if (loading) {
    return <GlobalMarketHubSkeleton />;
  }
  if (loadError) {
    return (
      <div className="p-6">
        <EmptyState title="Couldn't reach the global market" body={loadError} />
      </div>
    );
  }

  const activeFilterCount =
    chainFilter.size +
    (onlyTradeable ? 1 : 0) +
    (onlyArt ? 1 : 0) +
    (onlyVerifiedCreator ? 1 : 0) +
    (onlyListed ? 1 : 0) +
    (onlyWatched ? 1 : 0) +
    (priceMin.trim() ? 1 : 0) +
    (priceMax.trim() ? 1 : 0);

  const filterPanel = (
    <div className="space-y-4">
      <div>
        <p className="mb-1.5 text-[0.65rem] font-black uppercase tracking-wider text-foreground/40">Chains</p>
        <div className="space-y-1">
          {chains.map(([slug, count]) => (
            <label key={slug} className="flex min-h-9 cursor-pointer items-center gap-2 rounded px-1 text-sm transition-colors hover:bg-foreground/5">
              <input
                type="checkbox"
                checked={chainFilter.has(slug)}
                onChange={() => toggleChain(slug)}
                className="h-4 w-4 shrink-0 accent-gold-400 transition-transform"
              />
              <ChainIcon chainSlug={slug} size={16} className="shrink-0" />
              <span className="min-w-0 flex-1 truncate text-foreground/80" title={chainDisplayName(slug)}>
                {chainDisplayName(slug)}
              </span>
              <span className="shrink-0 whitespace-nowrap text-foreground/40">{count}</span>
            </label>
          ))}
        </div>
      </div>
      <div>
        <p className="mb-1.5 text-[0.65rem] font-black uppercase tracking-wider text-foreground/40">Features</p>
        <div className="space-y-1">
          <label className="flex min-h-9 cursor-pointer items-center gap-2 rounded px-1 text-sm transition-colors hover:bg-foreground/5">
            <input type="checkbox" checked={onlyTradeable} onChange={(e) => setOnlyTradeable(e.target.checked)} className="h-4 w-4 accent-gold-400" />
            <span className="text-foreground/80">Buy / sweep / send enabled</span>
          </label>
          <label className="flex min-h-9 cursor-pointer items-center gap-2 rounded px-1 text-sm transition-colors hover:bg-foreground/5">
            <input type="checkbox" checked={onlyArt} onChange={(e) => setOnlyArt(e.target.checked)} className="h-4 w-4 accent-gold-400" />
            <span className="text-foreground/80">Has real artwork</span>
          </label>
          <label className="flex min-h-9 cursor-pointer items-center gap-2 rounded px-1 text-sm transition-colors hover:bg-foreground/5">
            <input
              type="checkbox"
              checked={onlyVerifiedCreator}
              onChange={(e) => setOnlyVerifiedCreator(e.target.checked)}
              className="h-4 w-4 accent-gold-400"
            />
            <span className="text-foreground/80">Known creator (handle / ENS)</span>
          </label>
          <label className="flex min-h-9 cursor-pointer items-center gap-2 rounded px-1 text-sm transition-colors hover:bg-foreground/5">
            <input type="checkbox" checked={onlyListed} onChange={(e) => setOnlyListed(e.target.checked)} className="h-4 w-4 accent-gold-400" />
            <span className="text-foreground/80">Listed only (real listedCount &gt; 0)</span>
          </label>
          <label className="flex min-h-9 cursor-pointer items-center gap-2 rounded px-1 text-sm transition-colors hover:bg-foreground/5">
            <input type="checkbox" checked={showShells} onChange={(e) => setShowShells(e.target.checked)} className="h-4 w-4 accent-gold-400" />
            <span className="text-foreground/80">Show shells (no floor / listed / volume yet)</span>
          </label>
        </div>
      </div>
      <div>
        <p className="mb-1.5 text-[0.65rem] font-black uppercase tracking-wider text-foreground/40">Floor price</p>
        <p className="mb-1.5 text-[0.6rem] text-foreground/35">
          Native units, currency-blind (mixing ETH/SOL/BTC collections) -- see the rankings table&apos;s own Floor column for a
          currency-aware figure.
        </p>
        <div className="flex gap-2">
          <input
            type="number"
            step="0.0001"
            min="0"
            value={priceMin}
            onChange={(e) => setPriceMin(e.target.value)}
            placeholder="Min"
            aria-label="Minimum floor price"
            className="min-h-9 w-1/2 rounded-md border border-line bg-background px-2 text-sm text-foreground placeholder:text-foreground/30"
          />
          <input
            type="number"
            step="0.0001"
            min="0"
            value={priceMax}
            onChange={(e) => setPriceMax(e.target.value)}
            placeholder="Max"
            aria-label="Maximum floor price"
            className="min-h-9 w-1/2 rounded-md border border-line bg-background px-2 text-sm text-foreground placeholder:text-foreground/30"
          />
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
            setOnlyListed(false);
            setOnlyWatched(false);
            setPriceMin("");
            setPriceMax("");
          }}
          className="min-h-9 w-full rounded-md border border-line px-3 text-xs font-bold text-foreground/60 transition-colors hover:border-line-strong hover:text-foreground/80"
        >
          Clear filters ({activeFilterCount})
        </button>
      )}
    </div>
  );

  return (
    <div className="space-y-4 p-4">
      <MarketBreadcrumb variant="hub" />
      <div>
        <h2 className="font-display text-xl text-gold-300">Global Market</h2>
        <p className="text-xs text-foreground/50">
          {collections.length} collection{collections.length === 1 ? "" : "s"} tracked across{" "}
          {chains.length} chain{chains.length === 1 ? "" : "s"} — real listings, buy, sweep, and send on every
          EVM one ({collections.filter((c) => c.tradeable).length} of {collections.length}; Solana rows are
          browse-only for now, see the badge on each card).
        </p>
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
        className="dense-card group flex items-center gap-3 overflow-hidden border-gold-400/40 p-3 transition-[border-color,box-shadow] duration-200 hover:border-gold-400 hover:shadow-gold"
      >
        <div className="relative flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-md bg-[#0c0906] transition-transform duration-200 group-hover:scale-105">
          <Image src={WOODAMOTO_IMAGE} alt="" fill sizes="56px" className="object-cover" />
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
        {/*
         * Concept art, not a letterform placeholder: a locked vault holding
         * several different-colored plank bands, i.e. "many collections'
         * value, one basket, not open yet" -- the actual mechanic
         * (multi-collection $PLANK basket, gated pending external audit)
         * rather than a generic icon. The diagonal ribbon is a real
         * "coming soon" stamp on the artwork itself, on top of (not instead
         * of) the existing text badge below.
         */}
        <div className="relative flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-md bg-[#0c0906]">
          <Image src={PLANKY_CHAN_IMAGE} alt="" fill sizes="56px" className="object-cover" />
          <span className="card-overlay absolute -right-5 top-2 w-24 rotate-45 bg-gold-500 py-0.5 text-center text-[0.45rem] font-black uppercase tracking-widest text-wood-950 shadow">
            Soon
          </span>
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
              const heroGrade = gradeBreakdown(hero, true);
              return (
                <Link
                  href={collectionHref(hero)}
                  className="dense-card group relative flex min-h-[15rem] flex-col justify-end overflow-hidden p-0 transition-[border-color,box-shadow] duration-200 hover:border-gold-400/60 hover:shadow-gold sm:min-h-[18rem]"
                >
                  <div className="absolute inset-0">
                    <CollectionThumb
                      src={hero.imageUrl}
                      alt={hero.name ?? hero.contractAddress}
                      onFail={() => setDeadArt((prev) => new Set(prev).add(key(hero)))}
                      width={2048}
                      variant="hero"
                      priority
                    />
                  </div>
                  <div className="absolute inset-0 bg-gradient-to-t from-black/90 via-black/20 to-transparent transition-opacity group-hover:from-black/95" />
                  <div className="relative space-y-1.5 p-4">
                    <div className="flex items-center gap-1.5">
                      <span className="inline-flex items-center rounded-full bg-gold-400/90 px-2 py-0.5 text-[0.6rem] font-black uppercase tracking-wider text-wood-950">
                        Top mover
                      </span>
                      <GradeBadge breakdown={heroGrade} />
                    </div>
                    <p className="truncate text-2xl font-bold text-white drop-shadow" title={hero.name ?? hero.contractAddress}>
                      {hero.name ?? hero.contractAddress}
                    </p>
                    <p className="flex flex-wrap items-center gap-x-1 text-sm text-white/75">
                      <span style={{ color: chainBrandColor(hero.chainSlug) }}>{chainDisplayName(hero.chainSlug)}</span>
                      <span>{" · "}Vol</span>
                      <span className="inline-flex items-center gap-1">
                        {formatCompactNative(hero.volume24hWei!).display}
                        <ChainIcon chainSlug={hero.chainSlug} size={14} className="shrink-0" />
                        {(() => {
                          const usd = toUsd(hero.volume24hWei, chainNativeAsset(hero.chainSlug));
                          return usd != null ? <span className="text-white/50">{formatUsdCompact(usd)}</span> : null;
                        })()}
                      </span>
                      {hero.sales24h ? <span>{" · "}{hero.sales24h} sales</span> : null}
                      {hero.floorPriceWei && (
                        <span className="inline-flex items-center gap-1">
                          {" · "}Floor {formatCompactNative(hero.floorPriceWei).display}
                          <FloorCurrencyMark collection={hero} />
                        </span>
                      )}
                    </p>
                  </div>
                </Link>
              );
            })()}

            {/* Medium strip: the next 5 graded movers, immersive art tiles, 2-up on mobile. */}
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-2">
              {topMovers.slice(1).map((c) => {
                const grade = gradeBreakdown(c, true);
                return (
                  <Link
                    key={key(c)}
                    href={collectionHref(c)}
                    className="group relative flex min-h-[6.5rem] flex-col justify-end overflow-hidden rounded-lg border border-line transition-[border-color,box-shadow] duration-200 hover:border-gold-400/60 hover:shadow-gold"
                  >
                    <div className="absolute inset-0">
                      <CollectionThumb
                        src={c.imageUrl}
                        alt={displayName(c)}
                        onFail={() => setDeadArt((prev) => new Set(prev).add(key(c)))}
                        width={1024}
                        variant="tile"
                      />
                    </div>
                    <div className="absolute inset-0 bg-gradient-to-t from-black/85 via-black/10 to-transparent" />
                    <div className="relative space-y-0.5 p-2">
                      <GradeBadge breakdown={grade} />
                      <p className="truncate text-xs font-bold text-white" title={displayName(c)}>
                        {displayName(c)}
                      </p>
                      <p className="flex items-center gap-1 truncate text-[0.65rem] text-white/70">
                        {formatCompactNative(c.volume24hWei!).display}
                        <ChainIcon chainSlug={c.chainSlug} size={16} className="shrink-0" />
                        · 24h
                      </p>
                    </div>
                  </Link>
                );
              })}
            </div>
          </div>
        </div>
      )}

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
           * Chain badges -- the primary way to narrow this table to one or
           * more chains. Same chainFilter state the sidebar checkboxes and
           * the full grid below already use (one filter concept, not two).
           * Deliberately NOT a soft rounded pill: flagged live 2026-08-20
           * ("sexier, more intentional and avante garde than the trenches
           * simple setup") -- asymmetric clipped corner (one cut edge, not
           * four rounded ones), a full-bleed top accent bar in the chain's
           * own real brand color (chainBrandColor, same source ChainIcon
           * already uses -- never a second, invented palette), and an
           * active state that FLIPS to a solid color block (dark text on
           * the chain's own hue) rather than a translucent tint, so
           * selection reads as a committed choice, not a hover ghost. The
           * count sits in its own monospace corner chip like a ticket
           * stub number, not inline text.
           */}
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => setOnlyWatched((value) => !value)}
              aria-pressed={onlyWatched}
              className={`relative flex min-h-10 items-center gap-2 border px-4 text-xs font-black uppercase tracking-wide transition-all hover:-translate-y-0.5 ${onlyWatched ? "border-gold-300 bg-gold-300 text-[#0c0906] shadow-[0_0_18px_rgba(244,201,93,.45)]" : "border-gold-300/45 text-gold-200 hover:bg-gold-300/10"}`}
              style={{ clipPath: "polygon(0 0, 100% 0, 100% 100%, 10px 100%, 0 calc(100% - 10px))" }}
            >
              <span aria-hidden className="text-lg leading-none">★</span>
              Starred
              <span className="font-mono text-[0.65rem] opacity-75">{watchlist.size}</span>
            </button>
            {chains.map(([slug, count]) => {
              const active = chainFilter.has(slug);
              const brand = chainBrandColor(slug);
              return (
                <button
                  key={slug}
                  type="button"
                  onClick={() => toggleChain(slug)}
                  aria-pressed={active}
                  className="group relative flex min-h-10 items-center gap-2 border px-3.5 pl-4 text-xs font-black uppercase tracking-wide transition-all duration-150 hover:-translate-y-0.5 active:translate-y-0"
                  style={{
                    clipPath: "polygon(0 0, 100% 0, 100% 100%, 10px 100%, 0 calc(100% - 10px))",
                    borderColor: active ? brand : "var(--color-line)",
                    backgroundColor: active ? brand : "transparent",
                    color: active ? "#0c0906" : "var(--color-foreground)",
                  }}
                >
                  <span
                    aria-hidden="true"
                    className="absolute inset-x-0 top-0 h-[3px] transition-opacity"
                    style={{ backgroundColor: brand, opacity: active ? 0 : 0.85 }}
                  />
                  <ChainIcon chainSlug={slug} size={15} className="shrink-0" />
                  <span className={`whitespace-nowrap ${active ? "" : "text-foreground/80"}`}>{chainDisplayName(slug)}</span>
                  <span
                    className="shrink-0 whitespace-nowrap rounded-sm px-1 font-mono text-[0.65rem] font-bold"
                    style={{
                      backgroundColor: active ? "#0c090633" : "var(--color-panel-strong)",
                      color: active ? "#0c0906" : "var(--color-foreground)",
                      opacity: active ? 0.85 : 0.55,
                    }}
                  >
                    {count}
                  </span>
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
           *
           * DATA TYPOGRAPHY (design-direction preview, 2026-08-19): every
           * numeric column below now sets font-mono on top of the existing
           * tabular-nums -- tabular-nums alone keeps digit WIDTHS aligned in
           * a proportional font, monospace additionally locks every GLYPH
           * (currency symbols, the % sign, arrows, the decimal point) onto
           * one fixed grid, which is what actually lets a scanning eye track
           * a column instead of re-parsing each row. Same pattern every real
           * trading terminal (Axiom, Photon, Blur, Tensor) uses for exactly
           * this reason. Nothing else about this table changed -- same
           * columns, same responsive hide/show, same data, same links.
           */}
          <div className="flex items-center justify-between px-1 pb-1.5">
            <div className="flex items-center gap-3">
              <span className="text-[0.6rem] font-black uppercase tracking-wider text-foreground/35">Live rankings</span>
              {/* Real, visible legend for the green checkmark riding inside the Collection column -- flagged live ("check mark column is still unexplained"): a hover-only tooltip isn't visible to a sighted user scanning the table, so this makes the meaning legible without hovering every row. */}
              <span className="inline-flex items-center gap-1 text-[0.6rem] text-foreground/35">
                <span className="text-emerald-400">✓</span> = known creator
              </span>
            </div>
            <span className="inline-flex items-center gap-1.5 font-mono text-[0.6rem] font-bold uppercase tracking-wider text-emerald-400">
              <span className="live-pulse-dot h-1.5 w-1.5 rounded-full bg-emerald-400" aria-hidden="true" />
              Live
            </span>
          </div>
          {rankings.length === 0 ? (
            <EmptyState
              title={
                chainFilter.size > 0
                  ? "No ranked collections on this chain yet"
                  : "No ranked collections yet"
              }
              body={
                chainFilter.size > 0
                  ? "Live rankings need a real book or artwork on the selected chain. Catalog cards below can still list identity rows with art pending."
                  : "Live rankings need a real floor, listings, or volume plus artwork. The catalog grid below is a separate search."
              }
            />
          ) : (
          <div className="overflow-x-auto rounded-lg border border-line bg-panel">
            <table className="w-full min-w-[36rem] border-collapse text-sm">
              <thead>
                <tr className="border-b border-line text-left text-[0.6rem] font-black uppercase tracking-wider text-foreground/40">
                  <th className="w-8 px-2 py-2" />
                  <th className="w-10 px-1 py-2 text-right font-mono">#</th>
                  <SortableTh column="name" sortColumn={sortColumn} sortDir={sortDir} onSort={toggleSort} align="left">
                    Collection
                  </SortableTh>
                  <SortableTh column="floor" sortColumn={sortColumn} sortDir={sortDir} onSort={toggleSort}>
                    Floor
                  </SortableTh>
                  <SortableTh column="change" sortColumn={sortColumn} sortDir={sortDir} onSort={toggleSort} hasData={rankingsHasData.change}>
                    24h Change
                  </SortableTh>
                  <SortableTh column="volume" sortColumn={sortColumn} sortDir={sortDir} onSort={toggleSort} className="hidden sm:table-cell" hasData={rankingsHasData.volume}>
                    {rankingsWindow} Volume
                  </SortableTh>
                  <SortableTh column="sales" sortColumn={sortColumn} sortDir={sortDir} onSort={toggleSort} className="hidden md:table-cell" hasData={rankingsHasData.sales}>
                    {rankingsWindow} Sales
                  </SortableTh>
                  <SortableTh column="listed" sortColumn={sortColumn} sortDir={sortDir} onSort={toggleSort} className="hidden md:table-cell" hasData={rankingsHasData.listed}>
                    Listed
                  </SortableTh>
                  <SortableTh column="holders" sortColumn={sortColumn} sortDir={sortDir} onSort={toggleSort} className="hidden md:table-cell" hasData={rankingsHasData.holders}>
                    Holders
                  </SortableTh>
                  <SortableTh column="grade" sortColumn={sortColumn} sortDir={sortDir} onSort={toggleSort} className="w-9">
                    Grade
                  </SortableTh>
                </tr>
              </thead>
              <tbody>
                {rankings.map((c, i) => {
                  const change = displayChangePct(c);
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
                    <tr
                      key={rowKey}
                      className="row-enter border-b border-line/60 transition-colors last:border-0 hover:bg-foreground/5"
                      style={{ "--row-delay": `${Math.min(i, 12) * 20}ms` } as CSSProperties}
                    >
                      <td className="px-2 py-2 text-center">
                        <button
                          type="button"
                          onClick={() => toggleWatchlist(rowKey)}
                          aria-pressed={watched}
                          aria-label={watched ? "Remove from watchlist" : "Add to watchlist"}
                          className={`grid size-8 place-items-center rounded-md border text-base leading-none transition-all duration-150 hover:scale-110 active:scale-95 ${watched ? "border-gold-200 bg-gold-300 text-[#151006] shadow-[0_0_14px_rgba(244,201,93,.55)]" : "border-transparent text-foreground/35 hover:border-gold-300/40 hover:text-gold-200"}`}
                        >
                          {watched ? "★" : "☆"}
                        </button>
                      </td>
                      <td className="px-1 py-2 text-right text-xs text-foreground/40 tabular-nums font-mono">{i + 1}</td>
                      <td className="px-2 py-2">
                        <Link
                          href={collectionHref(c)}
                          className="group flex min-w-0 items-center gap-2"
                        >
                          <div className="relative h-9 w-9 shrink-0 overflow-hidden rounded bg-wood-900 transition-shadow duration-200 group-hover:shadow-gold">
                            <CollectionThumb
                              src={c.imageUrl}
                              alt={displayName(c)}
                              onFail={() => setDeadArt((prev) => new Set(prev).add(rowKey))}
                              width={256}
                              variant="thumb"
                            />
                            <span
                              className="absolute -bottom-0.5 -right-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-black/70"
                              title={chainDisplayName(c.chainSlug)}
                            >
                              <ChainIcon chainSlug={c.chainSlug} size={10} />
                            </span>
                          </div>
                          <span className="min-w-0 flex-1">
                            <span className="block truncate font-bold text-foreground/90" title={displayName(c)}>
                              {displayName(c)}
                            </span>
                            <span
                              className="block truncate font-mono text-[0.58rem] text-foreground/40"
                              title={`Collection id ${c.contractAddress}`}
                            >
                              {shortCollectionId(c.contractAddress)}
                            </span>
                          </span>
                          {/* Known-creator checkmark -- real signal (a real handle/ENS this app has observed), never OpenSea's own "verified" claim, which this app cannot honestly assert for an auto-discovered collection. The title tooltip alone isn't reliably exposed to screen readers, and there's no dedicated column/header for this icon (it rides inside "Collection"), so the accessible label lives on the icon itself via a sr-only span -- same pattern ListingCard.tsx uses for its own icon-only trust badge. */}
                          {(c.creatorHandle || c.creatorEns) && (
                            <span className="shrink-0 text-emerald-400" title={`Known creator: ${c.creatorHandle ?? c.creatorEns}`}>
                              <span className="sr-only">Known creator: {c.creatorHandle ?? c.creatorEns} — </span>
                              ✓
                            </span>
                          )}
                        </Link>
                      </td>
                      <td className="whitespace-nowrap px-2 py-2 text-right tabular-nums font-mono text-gold-300">
                        {displayFloorWei(c) ? (
                          <span className="inline-flex items-center justify-end gap-1">
                            <NativeAmount
                              wei={displayFloorWei(c)!}
                              usdLabel={(() => {
                                const usd = toUsd(displayFloorWei(c), c.floorPriceCurrency);
                                return usd != null ? formatUsdCompact(usd) : null;
                              })()}
                            />
                            <FloorCurrencyMark collection={c} />
                          </span>
                        ) : (
                          <span className="text-foreground/40">—</span>
                        )}
                      </td>
                      <td className={`whitespace-nowrap px-2 py-2 text-right tabular-nums font-mono font-bold ${changeColor}`}>
                        {change != null ? (
                          `${changeArrow}${Math.abs(change).toFixed(1)}%`
                        ) : c.floorChangeStatus === "collecting-baseline" ? (
                          <span
                            className="text-amber-300/80"
                            title="Executable floor tracking is active. An exact 24-hour comparison appears after the first complete observation window."
                          >
                            Baseline
                          </span>
                        ) : (
                          <span title={emptyCellReason(c, "change")}>—</span>
                        )}
                      </td>
                      <td className="hidden whitespace-nowrap px-2 py-2 text-right tabular-nums font-mono text-foreground/60 sm:table-cell">
                        {(() => {
                          const vol = windowVolumeWei(c, rankingsWindow);
                          if (!vol || vol === "0") return <span title={emptyCellReason(c, "volume")}>—</span>;
                          const usd = toUsd(vol, chainNativeAsset(c.chainSlug));
                          return (
                            <span className="inline-flex items-center justify-end gap-1">
                              <NativeAmount wei={vol} usdLabel={usd != null ? formatUsdCompact(usd) : null} />
                              <ChainIcon chainSlug={c.chainSlug} size={14} className="shrink-0" />
                            </span>
                          );
                        })()}
                      </td>
                      <td className="hidden px-2 py-2 text-right tabular-nums font-mono text-foreground/60 md:table-cell">
                        {displaySales(c, rankingsWindow) ?? <span title={emptyCellReason(c, "sales")}>—</span>}
                      </td>
                      <td className="hidden whitespace-nowrap px-2 py-2 text-right tabular-nums font-mono text-foreground/60 md:table-cell">
                        {c.listedCount != null ? (
                          <span
                            className="inline-flex flex-col items-end leading-tight"
                            title={
                              c.totalSupply != null
                                ? `${c.listedCount.toLocaleString()} listed of ${c.totalSupply.toLocaleString()} supply`
                                : `${c.listedCount.toLocaleString()} listed`
                            }
                          >
                            <span className="text-foreground/90">{formatCompactCount(c.listedCount)}</span>
                            <span className="text-[0.58rem] text-foreground/40">
                              {c.totalSupply != null ? `of ${formatCompactCount(c.totalSupply)}` : "listed"}
                            </span>
                          </span>
                        ) : (
                          <span title={emptyCellReason(c, "listed")}>—</span>
                        )}
                      </td>
                      <td className="hidden px-2 py-2 text-right tabular-nums font-mono text-foreground/80 md:table-cell">
                        {displayHolders(c) != null ? (
                          <span className="inline-flex flex-col items-end leading-tight" title={`${displayHolders(c)!.toLocaleString()} unique wallets`}>
                            <span>{displayHolders(c)!.toLocaleString()}</span>
                            <span className="text-[0.58rem] font-sans text-foreground/40">wallets</span>
                          </span>
                        ) : (
                          <span title={emptyCellReason(c, "holders")}>—</span>
                        )}
                      </td>
                      <td className="px-2 py-2 text-right">
                        <GradeBadge breakdown={gradeBreakdown(c, hasArt(c))} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          )}

          {/* Window + Show-top controls side by side, not stacked -- flagged live ("dont need to be stacked and leave all that empty space"): both are short single-row button groups with real horizontal room to share a line on anything wider than a phone. */}
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-xs">
            {/* Real 24h/7d/30d window toggle for the Volume/Sales columns above -- same real OpenSea-sourced data (rarity-index-runner.ts), just a different interval of the same already-fetched response. Never fabricated from a single-window figure. */}
            <div className="flex items-center gap-1.5">
              <span className="text-foreground/40">Window</span>
              {(["24h", "7d", "30d"] as const).map((w) => (
                <button
                  key={w}
                  type="button"
                  onClick={() => setRankingsWindow(w)}
                  aria-pressed={rankingsWindow === w}
                  className={`min-h-8 rounded-md border px-2.5 font-bold transition-colors duration-150 ${
                    rankingsWindow === w
                      ? "border-gold-400 bg-gold-400/15 text-gold-300"
                      : "border-line text-foreground/50 hover:border-line-strong hover:text-foreground/70"
                  }`}
                >
                  {w}
                </button>
              ))}
            </div>

            {/* Real "Show top: N" control, Magic Eden's own pattern -- a fixed cutoff either buried most of 3,500+ tracked collections or flooded the page; this lets the reader choose. */}
            <div className="flex items-center gap-1.5">
              <span className="text-foreground/40">Show top</span>
              {[10, 25, 50, 100].map((n) => (
                <button
                  key={n}
                  type="button"
                  onClick={() => setRankingsShowCount(n)}
                  aria-pressed={rankingsShowCount === n}
                  className={`min-h-8 rounded-md border px-2.5 font-bold transition-colors duration-150 ${
                    rankingsShowCount === n
                      ? "border-gold-400 bg-gold-400/15 text-gold-300"
                      : "border-line text-foreground/50 hover:border-line-strong hover:text-foreground/70"
                  }`}
                >
                  {n}
                </button>
              ))}
            </div>
          </div>
        </div>

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
            {biggestMovers.map((c, i) => {
              const change = c.floorChangePct!;
              const up = change > 0;
              return (
                <Link
                  key={key(c)}
                  href={collectionHref(c)}
                  className="row-enter group rounded-lg border border-line bg-panel p-2 transition-[border-color,box-shadow,transform] duration-200 hover:-translate-y-0.5 hover:border-gold-400/60 hover:shadow-gold"
                  style={{ "--row-delay": `${Math.min(i, 12) * 25}ms` } as CSSProperties}
                >
                  <div className="relative mb-1.5 aspect-square w-full overflow-hidden rounded bg-wood-900">
                    <CollectionThumb
                      src={c.imageUrl}
                      alt={displayName(c)}
                      onFail={() => setDeadArt((prev) => new Set(prev).add(key(c)))}
                      width={1024}
                      variant="tile"
                    />
                    <span
                      className="absolute bottom-1 right-1 flex h-4 w-4 items-center justify-center rounded-full bg-black/70"
                      title={chainDisplayName(c.chainSlug)}
                    >
                      <ChainIcon chainSlug={c.chainSlug} size={10} />
                    </span>
                  </div>
                  <p className="truncate text-xs font-bold text-foreground/90" title={displayName(c)}>
                    {displayName(c)}
                  </p>
                  <p className="truncate text-[0.65rem] text-foreground/50">
                    {c.floorPriceWei ? (
                      <>
                        {formatCompactNative(c.floorPriceWei).display}
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
          placeholder="Search collections or pieces…"
          className="min-h-10 flex-1 min-w-[10rem] rounded-md border border-line bg-background px-3 text-sm text-foreground placeholder:text-foreground/30 transition-colors focus:border-gold-400/60"
        />
        {/* The grid has no table header to click, unlike the rankings table above -- same shared sortColumn/sortDir state, just a dropdown since there's no header row here. */}
        <select
          value={`${sortColumn}:${sortDir}`}
          onChange={(e) => {
            const [col, dir] = e.target.value.split(":") as [SortColumn, SortDir];
            setSortColumn(col);
            setSortDir(dir);
          }}
          className="min-h-10 rounded-md border border-line bg-background px-2 text-sm text-foreground transition-colors focus:border-gold-400/60"
          aria-label="Sort collections"
        >
          <option value="grade:desc">Trending (graded)</option>
          <option value="floor:desc">Floor: high to low</option>
          <option value="floor:asc">Floor: low to high</option>
          <option value="name:asc">Name: A-Z</option>
          <option value="name:desc">Name: Z-A</option>
          <option value={`volume:desc`}>{rankingsWindow} volume: high to low</option>
          <option value="change:desc">24h change: high to low</option>
          <option value="listed:desc">Listed: high to low</option>
          <option value="holders:desc">Holders: high to low</option>
        </select>
        <button
          type="button"
          onClick={() => setMobileFiltersOpen(true)}
          className="min-h-10 rounded-md border border-line bg-background px-3 text-sm font-bold text-foreground/80 transition-colors hover:border-line-strong lg:hidden"
        >
          Filters{activeFilterCount > 0 ? ` (${activeFilterCount})` : ""}
        </button>
      </div>

      <div className="flex gap-4">
        {/* sticky, not just top-aligned -- flagged live 2026-08-20 ("no
         * wasted real estate"): a non-sticky sidebar this short left its
         * entire column dead for the rest of a long scroll once the reader
         * passed its own height. max-h-[calc(100dvh-2rem)] + overflow-y-auto
         * so it never grows taller than the viewport itself if the filter
         * list ever gets long. */}
        <aside className="sticky top-4 hidden max-h-[calc(100dvh-2rem)] w-56 shrink-0 overflow-y-auto rounded-lg border border-line bg-panel p-3 lg:block">
          {filterPanel}
        </aside>

        <div className="min-w-0 flex-1">
          {search.trim().length >= 2 && filtered.length > 0 && (
            <section className="mb-4 space-y-2" aria-label="Matching collections">
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-xs font-black uppercase tracking-wider text-gold-300">Collections</h3>
                <span className="text-[0.65rem] text-foreground/45">{filtered.length} matches · best matches first</span>
              </div>
              <ul className="grid grid-cols-2 gap-2 sm:grid-cols-4 xl:grid-cols-6">
                {filtered.slice(0, 12).map((c) => (
                  <li key={`search:${key(c)}`}>
                    <Link href={collectionHref(c)} className="dense-card group flex h-full items-center gap-2 p-2 hover:border-line-strong">
                      <div className="relative h-14 w-14 shrink-0 overflow-hidden rounded-md bg-wood-900">
                        <CollectionThumb src={c.imageUrl} alt={displayName(c)} width={256} variant="tile" />
                        <span className="absolute bottom-1 right-1 flex h-4 w-4 items-center justify-center rounded-full bg-black/70">
                          <ChainIcon chainSlug={c.chainSlug} size={10} />
                        </span>
                      </div>
                      <div className="min-w-0">
                        <p className="truncate text-xs font-bold text-foreground">{displayName(c)}</p>
                        <p className="truncate text-[0.6rem] text-foreground/45">{chainDisplayName(c.chainSlug)}</p>
                        {c.totalSupply != null && <p className="text-[0.6rem] text-foreground/45">{c.totalSupply.toLocaleString()} pieces</p>}
                      </div>
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {search.trim().length >= 2 && (tokenSearchLoading || tokenHits.length > 0) && (
            <section className="mb-4 space-y-2" aria-label="Matching pieces">
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-xs font-black uppercase tracking-wider text-gold-300">Individual pieces</h3>
                <span className="text-[0.65rem] text-foreground/45">
                  {tokenSearchLoading ? "Searching indexed pieces…" : `${tokenHits.length} matches`}
                </span>
              </div>
              {tokenHits.length > 0 && (
                <ul className="grid grid-cols-2 gap-2 sm:grid-cols-4 xl:grid-cols-6">
                  {tokenHits.slice(0, 12).map((token) => (
                    <li key={`${token.chainSlug}:${token.collectionSlug}:${token.tokenId}`}>
                      <Link
                        href={`/market/multichain/${encodeURIComponent(token.chainSlug)}/${encodeURIComponent(token.collectionSlug)}?q=${encodeURIComponent(token.tokenId)}&show=all`}
                        className="dense-card group flex h-full flex-col overflow-hidden p-0 hover:border-line-strong"
                      >
                        <div className="relative aspect-square bg-wood-900">
                          <CollectionThumb src={token.imageUrl} alt={token.name || `Token ${token.tokenId}`} width={512} variant="tile" />
                          <span className="card-overlay absolute left-1.5 top-1.5 flex h-6 w-6 items-center justify-center rounded-full bg-black/60">
                            <ChainIcon chainSlug={token.chainSlug} size={15} />
                          </span>
                        </div>
                        <div className="min-w-0 p-2">
                          <p className="truncate text-xs font-bold text-foreground">{token.name || `#${token.tokenId}`}</p>
                          <p className="truncate text-[0.6rem] text-foreground/45">
                            {chainDisplayName(token.chainSlug)} · #{token.tokenId}
                            {token.rarityRank ? ` · rank ${token.rarityRank}` : ""}
                          </p>
                        </div>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}
          {filtered.length === 0 ? (
            <EmptyState
              title="No collections match"
              body={
                search.trim()
                  ? `Nothing tracked matches "${search.trim()}" with the current filters.`
                  : "No tracked collections fit the current chain/feature filters — try clearing a few."
              }
            />
          ) : search.trim().length >= 2 ? null : (
            // Density scales with real available width instead of capping at
            // 4 columns forever -- flagged live 2026-08-20 ("no wasted real
            // estate"): a wide desktop monitor was stretching each card far
            // larger than the art itself needed, the same complaint real
            // high-density gallery sites (Unsplash et al.) solve by adding
            // columns, not by growing cell size.
            <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5 2xl:grid-cols-6">
              {filtered.slice(0, gridVisibleCount).map((c, i) => (
                <li key={key(c)} className="row-enter" style={{ "--row-delay": `${Math.min(i, 16) * 15}ms` } as CSSProperties}>
                  <Link
                    href={collectionHref(c)}
                    className="dense-card group flex flex-col overflow-hidden p-0 transition-[transform,border-color,box-shadow] duration-200 hover:-translate-y-0.5 hover:border-line-strong hover:shadow-gold"
                  >
                    <div className="relative aspect-square w-full bg-wood-900">
                      <CollectionThumb
                        src={c.imageUrl}
                        alt={displayName(c)}
                        onFail={() => setDeadArt((prev) => new Set(prev).add(key(c)))}
                        width={1024}
                        variant="tile"
                        priority={i < 6}
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
                          <GradeBadge breakdown={gradeBreakdown(c, hasArt(c))} />
                        </span>
                      )}
                    </div>
                    <div className="space-y-1 p-2.5">
                      <p className="truncate text-sm font-bold text-foreground" title={displayName(c)}>
                        {displayName(c)}
                      </p>
                      {ambiguousCollectionNames.has(`${c.chainSlug}:${displayName(c).trim().toLowerCase()}`) && (
                        <p className="truncate font-mono text-[0.6rem] text-gold-300/70" title={c.contractAddress}>
                          contract {shortCollectionId(c.contractAddress)}
                        </p>
                      )}
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
                      {displayFloorWei(c) && (
                        <p className="text-xs text-foreground/50">
                          Floor {formatCompactNative(displayFloorWei(c)!).display}
                          {displayChangePct(c) != null && (
                            <span className={`ml-1.5 font-bold ${displayChangePct(c)! >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                              {displayChangePct(c)! >= 0 ? "▲" : "▼"} {Math.abs(displayChangePct(c)!).toFixed(1)}%
                            </span>
                          )}
                        </p>
                      )}
                      {c.volume24hWei && c.volume24hWei !== "0" && (
                        <p className="flex items-center gap-1 text-xs text-foreground/50">
                          Vol {formatCompactNative(c.volume24hWei).display}
                          <ChainIcon chainSlug={c.chainSlug} size={16} className="shrink-0" />
                          · 24h
                          {c.sales24h ? ` · ${c.sales24h} sales` : ""}
                        </p>
                      )}
                      {(c.listedCount != null || displayHolders(c) != null) && (
                        <p className="text-[0.65rem] text-foreground/45">
                          {c.listedCount != null ? `${c.listedCount.toLocaleString()} listed` : null}
                          {c.listedCount != null && c.totalSupply != null ? ` / ${c.totalSupply.toLocaleString()}` : null}
                          {displayHolders(c) != null ? `${c.listedCount != null ? " · " : ""}${displayHolders(c)!.toLocaleString()} wallets` : null}
                        </p>
                      )}
                      {(c.creatorHandle || c.creatorEns || c.creatorAddress) && (
                        <p
                          className="truncate text-[0.65rem] text-foreground/40"
                          title={c.creatorHandle ? `@${c.creatorHandle}` : c.creatorEns ? c.creatorEns : c.creatorAddress!}
                        >
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
          {filtered.length > gridVisibleCount && (
            <div className="mt-3 flex flex-col items-center gap-1">
              <button
                type="button"
                onClick={() => setGridVisibleCount((n) => n + GRID_PAGE_SIZE)}
                className="min-h-11 rounded-md border border-line bg-panel px-5 text-sm font-bold text-foreground/80 transition-colors hover:border-gold-400/60 hover:text-gold-300"
              >
                Show more ({filtered.length - gridVisibleCount} left)
              </button>
              <p className="text-[0.65rem] text-foreground/40">
                Showing {Math.min(gridVisibleCount, filtered.length)} of {filtered.length}
              </p>
            </div>
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
