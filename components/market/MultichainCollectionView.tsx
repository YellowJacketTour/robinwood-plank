"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Image from "next/image";
import { useRouter, useSearchParams, usePathname } from "next/navigation";
import { PackageOpen, Tag } from "lucide-react";
import { withImageWidth } from "@/lib/ipfs";
import CollectionArtImage from "@/components/market/CollectionArtImage";
import { catalogArtExtras } from "@/lib/market/multichain/token-art-templates";
import { collectionSurface } from "@/lib/market/multichain/collection-surface";
import { rarityMapGet, countTiers, tokenIdAliases } from "@/lib/market/rarity-lookup";
import { SkeletonCardGrid, SkeletonRows, SkeletonStats, SkeletonStatus } from "@/components/Skeleton";
import ListingCard from "@/components/market/ListingCard";
import BuyConfirm from "@/components/market/BuyConfirm";
import ForeignSweepConfirm from "@/components/market/ForeignSweepConfirm";
import ForeignCombinedSweepConfirm from "@/components/market/ForeignCombinedSweepConfirm";
import ForeignSendConfirm from "@/components/market/ForeignSendConfirm";
import ForeignDetailsModal from "@/components/market/ForeignDetailsModal";
import ForeignOfferConfirm from "@/components/market/ForeignOfferConfirm";
import ForeignOfferForm from "@/components/market/ForeignOfferForm";
import NativeForeignListForm from "@/components/market/NativeForeignListForm";
import NativeSolanaListForm from "@/components/market/NativeSolanaListForm";
import NativeForeignOfferForm from "@/components/market/NativeForeignOfferForm";
import NativeBundleListForm from "@/components/market/NativeBundleListForm";
import NativeSwapForm from "@/components/market/NativeSwapForm";
import { normalizeRarityTier, TIER_ORDER, tierCardStyle, tierGlow, tierAnimationClass } from "@/lib/rarity";
import { computeGenericRaritySnapshot, scoreTokenAgainstTraitIndex } from "@/lib/rarity-generic";
import { displayTokenLabel, shortTokenId } from "@/lib/market/token-label";
import FilterBar, { type MarketFilters } from "@/components/market/FilterBar";
import { SWEEP_MAX } from "@/lib/market/sweep";
import TraitCriteriaPicker from "@/components/market/TraitCriteriaPicker";
import {
  defaultFirstClause,
  formatCriteriaLabel,
  resolveCriteriaTokenIds,
  type CriteriaClause,
} from "@/lib/market/trait-criteria";
import type { TraitIndexResponse } from "@/lib/market/traits";
import { tierColor } from "@/lib/market/rarityClient";
import type { RarityLookup } from "@/lib/market/rarityClient";
import { useWallet } from "@/lib/wallet-context";
import { connectWallet } from "@/lib/wallet";
import { swrJson, invalidateSwr } from "@/lib/market/swr-fetch";
import type { SendFeeQuote } from "@/lib/market/send-fee";
import type { BatchSendStatus } from "@/lib/market/transfer";
import { chainDisplayName, FOREIGN_FEE_BPS, foreignOfferCurrency, nativeCurrencySymbol } from "@/lib/market/multichain/trading/foreign-chain-registry";
import { MARKETPLANK_NATIVE_LISTING_FEE_BPS } from "@/lib/constants";
import { isSolanaChainSlug, isBitcoinChainSlug, isNonEvmChainSlug, isRobinhoodChainSlug } from "@/lib/market/multichain/trading/non-evm-chains";
import { normalizeAssetSymbol, type MultiAssetPrices } from "@/lib/multi-asset-price";
import { isCrossChainBuyable, venueLabel, type Listing, type MarketCollection } from "@/lib/market/types";
import { formatTokenAmount, shortAddress } from "@/lib/trade";
import MarketNav from "@/components/market/MarketNav";
import MarketBreadcrumb from "@/components/market/MarketBreadcrumb";
import { MarketTabRail, MarketTabPanel } from "@/components/market/MarketScaffold";
import MarketBrowseLayout from "@/components/market/MarketBrowseLayout";
import RarityFloorStrip from "@/components/market/RarityFloorStrip";
import ChainIcon from "@/components/market/ChainIcon";
import type { RarityTier } from "@/lib/rarity";
import ForeignSwapComingSoon from "@/components/market/ForeignSwapComingSoon";
import ForeignActivityFeed, { type ForeignActivityEvent } from "@/components/market/ForeignActivityFeed";
import CollectionIntelligence from "@/components/market/CollectionIntelligence";
import { MARKET_TABS } from "@/lib/market/navigation";
import type { MarketTab } from "@/lib/market/types";

type ForeignOffer = {
  orderHash: string;
  maker: string;
  priceWei: string;
  expiresAt: string;
  acceptable: boolean;
  isWildcard: boolean;
  tokenId: string | null;
  imageUrl: string | null;
  name: string | null;
  /** True for a Marketplank-native offer (app/api/market/multichain/native-orders/route.ts) -- false/absent for an OpenSea-sourced row. */
  native?: boolean;
  /** Native criteria offers only -- see offers/route.ts's own header. */
  criteriaTokenIds?: string[] | null;
};
type MyListing = { orderHash: string; tokenId: string; priceWei: string; expiresAt: string; native?: boolean };

/** Mirrors swap-orders-store.ts's SwapListing (minus the raw order, which never leaves the server). */
type SwapItem = { contractAddress: string; tokenId: string };
type SwapRow = {
  id: string;
  maker: string;
  offerItems: SwapItem[];
  considerationItems: SwapItem[];
  considerationNativeWei: string;
  expiresAt: string;
};

type Props = {
  chainSlug: string;
  collectionSlug: string;
};

const SWEEP_SIZE_OPTIONS = [3, 5, 10, 20] as const;
/**
 * Offer discount for the "buy what's affordable, offer for the rest"
 * combined control -- 10% below each remainder item's own current listed
 * price. Chosen (not floor price) because: (a) it needs no extra fetch --
 * every remainder Listing already carries its own real priceWei, unlike
 * floor which would need a separate floor-listings call per chain family;
 * (b) it scales sensibly per-item (a 5 ETH item gets a meaningfully
 * different offer than a 0.1 ETH item, where a single flat floor-based
 * offer would not); (c) 10% is the same ballpark a rational floor-sweeper
 * already bids below ask on real marketplaces, so this isn't an arbitrary
 * number -- it is deliberately conservative enough to be a real, likely
 * acceptable offer instead of an insultingly low lowball.
 */
const COMBINED_OFFER_DISCOUNT_BPS = 1000;
/** Caps how many "offer the rest" wallet prompts one combined action can trigger -- an unbounded remainder could otherwise turn one click into dozens of signature prompts. */
const COMBINED_REMAINDER_CAP = 5;

/**
 * Browse + buy + sweep + send surface for ONE tracked multichain collection
 * (see plank_multichain_collections) -- deliberately a NEW page, not an
 * extension of MarketView.tsx, which is scoped to Marketplank's own single
 * RobinWood collection. See app/api/market/multichain/listings/route.ts's
 * header for why this can't live inside /market or /discover's existing,
 * documented contracts.
 *
 * Reuses the SAME ListingCard/BuyConfirm/foreign-fulfill machinery already
 * built and proven for the single-collection surface -- the cross-chain
 * buy/sweep/send flow is identical regardless of which collection or chain
 * an item came from, so nothing here reimplements that logic.
 */
/** Real listings-grid sort keys -- price (from each listing's own real priceWei, currency-consistent within one collection unlike GlobalMarketHub's cross-collection floor) and rarity rank (only meaningful once rarityMap is populated, see rarityMap's own header) -- never a fabricated rank for an unindexed collection. */
type ListingSort = "default" | "price-asc" | "price-desc" | "rarity-asc" | "rarity-desc";

export default function MultichainCollectionView({ chainSlug, collectionSlug }: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { address: evmAccount, adoptAccount } = useWallet();
  // NON-EVM WALLET STATE -- Solana (Phantom) and Bitcoin (UniSat) addresses
  // live outside lib/wallet-context.tsx's EVM-only account, since that
  // context is built entirely around ethers/BrowserProvider (see its own
  // adoptAccount, which every EVM buy/send/offer flow here already uses).
  // `account` below resolves to whichever is correct for this page's chain
  // family -- every existing EVM read/callback keeps using the same
  // `account` identifier it always has, now just chain-family-aware.
  const isSolana = isSolanaChainSlug(chainSlug);
  const isBitcoin = isBitcoinChainSlug(chainSlug);
  const isNonEvm = isNonEvmChainSlug(chainSlug);
  const [nonEvmAccount, setNonEvmAccount] = useState<string | null>(null);
  const account = isNonEvm ? nonEvmAccount : evmAccount;
  const [collection, setCollection] = useState<MarketCollection | null>(null);
  const [listings, setListings] = useState<Listing[]>([]);
  const [tokens, setTokens] = useState<Array<{ tokenId: string; name: string | null; imageUrl: string | null;
    animationUrl?: string | null; mediaType?: string | null;
    traits?: Array<{ traitType: string; value: string }> }>>([]);
  const [catalogBuilding, setCatalogBuilding] = useState(false);
  const [catalogMeta, setCatalogMeta] = useState<{
    projectedCount: number;
    expectedCount: number | null;
    partial: boolean;
  } | null>(null);
  const surface = collectionSurface(chainSlug);
  const [tokenLimit, setTokenLimit] = useState(surface.catalogPageSize);
  const [bookFilter, setBookFilter] = useState<"all" | "listed">(() => (searchParams.get("show") === "all" ? "all" : "listed"));
  const [browseMode, setBrowseMode] = useState<"art" | "intelligence">("art");
  /** Real listed-count/total-supply/holder-count from the tracked-collection snapshot (see getCollectionSupplyStats) -- null fields render as "—", never fabricated. holderCount is EVM-only (Alchemy getOwnersForContract) and may arrive later than the rest via the on-demand /api/market/multichain/holder-count backfill below. */
  const [supplyStats, setSupplyStats] = useState<{
    listedCount: number | null;
    totalSupply: number | null;
    holderCount: number | null;
    floorPriceWei: string | null;
    floorPriceCurrency: string | null;
  } | null>(null);
  // Real OpenSea 24h/7d/30d volume/sales (rarity-index-runner.ts, EVM-only
  // -- Solana/Bitcoin/Robinhood-native branches of the listings route always
  // resolve these to null, honestly, since neither Magic Eden's nor
  // UniSat's API exposes row-level history to sum a real window from).
  const [marketStats, setMarketStats] = useState<{
    volume24hWei: string | null;
    sales24h: number | null;
    volume7dWei: string | null;
    sales7d: number | null;
    volume30dWei: string | null;
    sales30d: number | null;
  } | null>(null);
  const [marketStatsWindow, setMarketStatsWindow] = useState<"24h" | "7d" | "30d">("24h");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [listingsUnavailable, setListingsUnavailable] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // SMART SEARCH / FILTER -- point-and-click, no page reload, applies
  // instantly to whatever is already loaded. Token-id search matches
  // exact or prefix (typing "54" finds #541, #5432, ...); price range is
  // inclusive on both ends and either side can be left blank.
  // Every filter/sort field below is initialized from the URL query string
  // (same `searchParams.get(...) || default` pattern PortfolioView.tsx's
  // own ?wallet= param and GlobalMarketHub.tsx's own filter state already
  // use) so a shared link or a page reload restores the exact same view.
  // chainSlug/collectionSlug themselves are ROUTE params (not query), so
  // this is purely the browse-state layer on top of a fixed collection.
  const [searchQuery, setSearchQuery] = useState(() => searchParams.get("q") ?? "");
  const [minPriceEth, setMinPriceEth] = useState(() => searchParams.get("min") ?? "");
  const [maxPriceEth, setMaxPriceEth] = useState(() => searchParams.get("max") ?? "");
  // TRAIT FILTER -- one selected value per trait category, AND-combined
  // (matches native's existing trait-criteria semantics, e.g.
  // trait-criteria.ts's own AND rule). Empty string = "any value" for that
  // category. Applied client-side to the already-loaded listings grid
  // (each Listing already carries real .traits, see listings/route.ts) AND
  // server-side for sweep (fetchForeignTraitFilteredListings), since a
  // trait-filtered sweep must pull from the FULL collection, not just
  // whatever's in the currently-loaded 40-listing page.
  const [selectedTraits, setSelectedTraits] = useState<Record<string, string>>(() => {
    const raw = searchParams.get("traits");
    if (!raw) return {};
    try {
      const parsed = JSON.parse(raw) as Record<string, string>;
      return typeof parsed === "object" && parsed !== null ? parsed : {};
    } catch {
      return {};
    }
  });
  const [activeTier, setActiveTier] = useState<RarityTier | "all">(() => (searchParams.get("tier") as RarityTier | "all") || "all");
  // SORT -- price (each listing's own real priceWei, currency-consistent
  // within a single collection) and rarity rank (rarityMap.rank, real
  // pre-computed information-content rank from index-foreign-rarity.ts --
  // never fabricated, and only offered once rarityMap is actually
  // populated for this collection, see the rarityMap effect's own header).
  const [listingSort, setListingSort] = useState<ListingSort>(() => (searchParams.get("sort") as ListingSort) || "price-asc");

  const [buyTarget, setBuyTarget] = useState<Listing | null>(null);
  const [buyBusy, setBuyBusy] = useState(false);

  const [sweepCount, setSweepCount] = useState<number>(SWEEP_SIZE_OPTIONS[0]);
  const [sweepOpen, setSweepOpen] = useState(false);
  const [sweepCustom, setSweepCustom] = useState("");
  const [sweepScope, setSweepScope] = useState<"floor" | "tier" | "trait">("floor");
  const [sweepClauses, setSweepClauses] = useState<CriteriaClause[]>([]);
  const [traitIndex, setTraitIndex] = useState<TraitIndexResponse | null>(null);
  const [criteriaOpen, setCriteriaOpen] = useState(false);
  const [activeTiers, setActiveTiers] = useState<RarityTier[]>([]);
  const [sweepPreview, setSweepPreview] = useState<Listing[] | null>(null);
  const [sweepBusy, setSweepBusy] = useState(false);

  // "MY ITEMS" / SEND -- owned tokens in this exact collection+chain for
  // the connected wallet, with single or batch send. Separate from the
  // listings grid on purpose: an owned token is not necessarily listed for
  // sale, and a listed token is not necessarily owned by the viewer.
  const [ownedTokenIds, setOwnedTokenIds] = useState<string[]>([]);
  const [ownedItems, setOwnedItems] = useState<Array<{ tokenId: string; name: string | null; imageUrl: string | null }>>([]);
  const [ownedLoading, setOwnedLoading] = useState(false);
  const [selectedForSend, setSelectedForSend] = useState<Set<string>>(new Set());
  const [sendTarget, setSendTarget] = useState<string[] | null>(null); // token ids currently in the confirm modal
  const [sendRecipient, setSendRecipient] = useState("");
  const [sendFeeQuote, setSendFeeQuote] = useState<SendFeeQuote | null>(null);
  const [sendFeeError, setSendFeeError] = useState<string | null>(null);
  const [sendBusy, setSendBusy] = useState(false);
  const [sendStatuses, setSendStatuses] = useState<Map<string, BatchSendStatus> | null>(null);

  // NON-EVM SWEEP PROGRESS -- only populated by the Solana/Bitcoin sweep
  // branches below (sweepSolanaListingsNow/sweepBitcoinListingsNow), which
  // are genuinely N sequential signed transactions, not the EVM router's
  // one atomic sweepBuy -- see foreign-fulfill.ts's own header on why.
  const [sweepStatuses, setSweepStatuses] = useState<Map<string, BatchSendStatus> | null>(null);

  // COMBINED SWEEP + OFFER -- additive control, separate from the plain
  // sweep/offer state above (both of those keep working unmodified). Given
  // a budget, splits the cheapest cross-chain-buyable listings into
  // `affordable` (swept the same way the plain sweep button would) and
  // `remainder` (the next COMBINED_REMAINDER_CAP listings just beyond
  // budget, each offered COMBINED_OFFER_DISCOUNT_BPS below its own price).
  const [combinedBudgetEth, setCombinedBudgetEth] = useState("");
  const [combinedPreview, setCombinedPreview] = useState<{ affordable: Listing[]; remainder: Listing[] } | null>(null);
  const [combinedBusy, setCombinedBusy] = useState(false);
  const [combinedError, setCombinedError] = useState<string | null>(null);
  const [combinedStatuses, setCombinedStatuses] = useState<Map<string, BatchSendStatus> | null>(null);

  // OFFERS / ACTIVITY -- the tab-parity pieces of "full native marketplank
  // experience for every collection on every chain." View-only for now:
  // see app/api/market/multichain/offers/route.ts's header on why accepting
  // an offer is a separate, not-yet-built signer flow (owner-as-fulfiller,
  // requires prior Seaport conduit approval), distinct from buyNow.
  const [offers, setOffers] = useState<ForeignOffer[]>([]);
  const [offersLoading, setOffersLoading] = useState(true);
  const [activity, setActivity] = useState<ForeignActivityEvent[]>([]);
  const [activityLoading, setActivityLoading] = useState(true);

  // MY LISTINGS -- own active listings in this collection. See
  // my-listings/route.ts's header on why this filters the full
  // active-listings set by offerer rather than a maker-scoped API call
  // (OpenSea removed that endpoint).
  const [myListings, setMyListings] = useState<MyListing[]>([]);
  const [myListingsLoading, setMyListingsLoading] = useState(false);

  const [tab, setTab] = useState<MarketTab>("buy-sell");

  // "sell" (Marketplank-native listing, see NativeForeignListForm.tsx) is
  // additive to MARKET_TABS. Robinhood Chain already has its own native
  // listing flow (MyInventory.tsx), so it's excluded here. Solana now gets
  // its own real Sell tab too (NativeSolanaListForm.tsx, via Magic Eden's
  // live Auction House program) -- flagged live 2026-08-20 ("all
  // collections on all chains of all types need ALL features in all
  // tabs"). Bitcoin stays excluded FOR NOW: its native listing engine
  // passed a testnet4-only security audit but explicitly failed the
  // mainnet bar (unverified inscription-to-UTXO binding is a real,
  // working fraud primitive against buyers -- see native-bitcoin-listing.ts's
  // own header), so wiring it into a real mainnet collection's Sell tab
  // before that's fixed would ship a real fund-loss risk, not "no
  // shortcuts." Revisit the moment that audit's remediation list closes.
  const isForeignEvm = !isNonEvm && !isRobinhoodChainSlug(chainSlug);
  const canSell = isForeignEvm || isSolana;
  const tabs = canSell ? [...MARKET_TABS, { id: "sell" as const, label: "Sell" }] : MARKET_TABS;
  /** One-click relist target, set by the "Relist" button in My Listings -- consumed once by NativeForeignListForm then cleared. */
  const [relistPreset, setRelistPreset] = useState<{ tokenId: string; priceWei: string } | null>(null);
  /** Which criteria-bid form to show on a foreign EVM chain's Offers tab -- defaults to Marketplank's own lower-fee direct path. */
  const [bidVenue, setBidVenue] = useState<"native" | "opensea">("native");
  /** Native BUNDLE listings for this collection+chain (roadmap item #7) -- see lib/market/bundle-orders-store.ts. */
  const [bundles, setBundles] = useState<Array<{ id: string; maker: string; tokenIds: string[]; priceWei: string; expiresAt: string }>>([]);
  const [swaps, setSwaps] = useState<SwapRow[]>([]);
  const [swapsLoading, setSwapsLoading] = useState(false);
  const [swapAccepting, setSwapAccepting] = useState<string | null>(null);
  const [swapError, setSwapError] = useState<string | null>(null);
  const [bundlesLoading, setBundlesLoading] = useState(false);
  const [bundleBuying, setBundleBuying] = useState<string | null>(null);
  const [bundleError, setBundleError] = useState<string | null>(null);

  // RARITY -- reuses the SAME information-content algorithm/tier system as
  // RobinWood's own collection (lib/rarity.ts + lib/rarity-generic.ts),
  // pre-computed in the background (scripts/index-foreign-rarity.ts) since
  // a live per-request compute would need every token in the collection.
  // Empty map (indexed=false) is a real, expected state for a collection
  // that hasn't been indexed yet -- cards render un-tiered, never a fake rank.
  const [rarityMap, setRarityMap] = useState<Map<string, RarityLookup>>(new Map());
  const [rarityFromIndex, setRarityFromIndex] = useState(false);
  const [raritySample, setRaritySample] = useState<{ size: number; partial: boolean } | null>(null);

  // DETAILS / MAKE OFFER -- real traits + collection-wide trait-frequency
  // signal (see ForeignDetailsModal's header on why this isn't a numeric
  // rank), and a genuine signed-Seaport-offer flow (foreign-offer.ts).
  const [detailsTarget, setDetailsTarget] = useState<Listing | null>(null);
  const [traitCounts, setTraitCounts] = useState<Record<string, Record<string, number>> | null>(null);
  const [openTraitGroups, setOpenTraitGroups] = useState<Record<string, boolean>>({});
  const [offerTarget, setOfferTarget] = useState<Listing | null>(null);
  const [offerAmountEth, setOfferAmountEth] = useState("");
  const [offerBusy, setOfferBusy] = useState(false);
  const [offerError, setOfferError] = useState<string | null>(null);
  const [acceptingOrderHash, setAcceptingOrderHash] = useState<string | null>(null);
  const [acceptError, setAcceptError] = useState<string | null>(null);

  const chainLabel = `${chainDisplayName(chainSlug)} via OpenSea`;

  const fetchCatalogTokens = useCallback(() => {
    const sort =
      listingSort === "rarity-desc" ? "rank-desc" : listingSort === "rarity-asc" ? "rank" : "id";
    const tierFilter = activeTiers.length === 1 ? activeTiers[0] : activeTier !== "all" ? activeTier : "";
    const qs = new URLSearchParams({
      chainSlug,
      collectionSlug,
      limit: String(Math.min(surface.catalogCap, tokenLimit)),
      art: "2",
      sort,
    });
    if (tierFilter) qs.set("tier", tierFilter);
    return swrJson<{ tokens: Array<{ tokenId: string; name: string | null; imageUrl: string | null;
      animationUrl?: string | null; mediaType?: string | null;
      traits?: Array<{ traitType: string; value: string }> }>;
      building?: boolean; projectedCount?: number; expectedCount?: number | null; partial?: boolean }>(
      `/api/market/multichain/tokens?${qs.toString()}`,
      { ttlMs: 8_000, swrMs: 45_000, session: true }
    )
      .then((tok) => {
        setTokens(tok.tokens ?? []);
        setCatalogBuilding(Boolean(tok.building));
        setCatalogMeta(typeof tok.projectedCount === "number" ? {
          projectedCount: tok.projectedCount,
          expectedCount: tok.expectedCount ?? null,
          partial: Boolean(tok.partial),
        } : null);
      })
      .catch(() => {
        setTokens([]);
        setCatalogBuilding(false);
      });
  }, [chainSlug, collectionSlug, listingSort, activeTier, activeTiers, tokenLimit, surface.catalogCap]);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const ident = await swrJson<{
        collection: {
          slug: string;
          name: string;
          imageUrl: string | null;
          contractAddress: string;
          listedCount: number | null;
          totalSupply: number | null;
          volume24hWei: string | null;
          sales24h: number | null;
          volume7dWei: string | null;
          sales7d: number | null;
          volume30dWei: string | null;
          sales30d: number | null;
          holderCount: number | null;
          floorPriceWei?: string | null;
          floorPriceCurrency?: string | null;
        };
      }>(`/api/market/multichain/collection?chainSlug=${chainSlug}&collectionSlug=${encodeURIComponent(collectionSlug)}`, {
        ttlMs: 30_000,
        swrMs: 120_000,
        session: true,
      });
      const data = ident;
      void swrJson<{
        listings: Listing[];
        listingsUnavailable?: string | null;
        collection?: { listedCount?: number | null; floorPriceWei?: string | null };
      }>(`/api/market/multichain/listings?chainSlug=${chainSlug}&collectionSlug=${encodeURIComponent(collectionSlug)}&limit=${surface.bookPageSize}`, {
        ttlMs: 8_000,
        swrMs: 45_000,
        session: true,
      })
        .then((book) => {
          setListings(book.listings ?? []);
          setListingsUnavailable(book.listingsUnavailable ?? null);
        })
        .catch(() => {
          setListingsUnavailable("book-unavailable");
        });
      /* catalog tokens: fetchCatalogTokens effect */
      // MarketCollection carries Robinhood-Chain-specific bookkeeping
      // (feeBps/royaltyBps/royaltyRecipient) that has no meaning for a
      // foreign collection -- real royalty is whatever the real Seaport
      // order's own consideration embeds (OpenSea's own enforcement), not
      // something this app tracks or sets. Zeroed here deliberately, not
      // a gap: ListingCard/BuyConfirm only read collection.name/image for
      // a cross-chain listing's display, never these fields.
      setCollection({
        slug: data.collection.slug,
        name: data.collection.name,
        contractAddress: data.collection.contractAddress,
        tokenStandard: "ERC721",
        image: data.collection.imageUrl ?? "",
        trustBadges: [],
        feeBps: 0,
        royaltyBps: 0,
        royaltyRecipient: "0x0000000000000000000000000000000000000000",
      });
      setSupplyStats({
        listedCount: data.collection.listedCount,
        totalSupply: data.collection.totalSupply,
        holderCount: data.collection.holderCount,
        floorPriceWei: data.collection.floorPriceWei ?? null,
        floorPriceCurrency: data.collection.floorPriceCurrency ?? null,
      });
      // Real, on-demand backfill: if this collection has never had a holder
      // count computed, fetch one now (see holder-count/route.ts's own
      // header for why this is on-demand-per-view, never bulk sync). Fire-
      // and-forget -- the stat bar just shows "—" until it resolves, same
      // as every other "—" placeholder on this page while data loads.
      if (data.collection.holderCount == null && !isNonEvm) {
        void swrJson<{ holderCount: number | null }>(
          `/api/market/multichain/holder-count?chainSlug=${chainSlug}&contractAddress=${encodeURIComponent(data.collection.contractAddress)}`,
          { ttlMs: 0, swrMs: 0, session: true }
        )
          .then((res) => {
            if (res.holderCount != null) {
              setSupplyStats((prev) => (prev ? { ...prev, holderCount: res.holderCount } : prev));
            }
          })
          .catch(() => {});
      }
      setMarketStats({
        volume24hWei: data.collection.volume24hWei,
        sales24h: data.collection.sales24h,
        volume7dWei: data.collection.volume7dWei,
        sales7d: data.collection.sales7d,
        volume30dWei: data.collection.volume30dWei,
        sales30d: data.collection.sales30d,
      });
    } catch {
      setLoadError("Could not load this collection.");
    } finally {
      setLoading(false);
    }
  }, [chainSlug, collectionSlug, surface.bookPageSize, isNonEvm]);

  useEffect(() => {
    void load();
    // "Always refreshing" -- periodically revalidate in the background so a
    // listing that sold or got underbid elsewhere doesn't sit stale on
    // screen just because the viewer never re-navigated. swrJson's own ttl
    // (8s) means most of these calls are cheap no-op cache hits; this timer
    // just guarantees the check happens even on a long-idle tab.
    const id = setInterval(() => void load(), 20_000);
    return () => clearInterval(id);
  }, [load]);

  useEffect(() => {
    void fetchCatalogTokens();
  }, [fetchCatalogTokens]);

  useEffect(() => {
    if (!catalogBuilding) return;
    const id = setInterval(() => void fetchCatalogTokens(), 10_000);
    return () => clearInterval(id);
  }, [catalogBuilding, fetchCatalogTokens]);

  // Real ETH/SOL/BTC/POL/BNB/AVAX USD prices -- same shared fetch + short-TTL swr pattern
  // GlobalMarketHub.tsx's own usdPrices effect uses. usdPrices stays {} (not
  // fabricated zeros) until this resolves, so every USD-dependent render
  // checks for a real price before showing one.
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
        // USD is a display enhancement, not core data -- a failed fetch just
        // means every USD figure stays hidden, native price still shows.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  /** Real USD-equivalent for a wei-denominated native price, or null if this currency has no fetched price -- never fabricated. */
  const toUsd = useCallback(
    (weiStr: string | null, currency: string | null): number | null => {
      if (!weiStr) return null;
      const symbol = normalizeAssetSymbol(currency);
      const usd = symbol ? usdPrices[symbol]?.usd : null;
      if (usd == null) return null;
      return (Number(weiStr) / 1e18) * usd;
    },
    [usdPrices]
  );
  const formatUsdCompact = (n: number): string => {
    if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
    if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
    return `$${n.toFixed(2)}`;
  };

  const loadOwned = useCallback(async () => {
    if (!account || !collection?.contractAddress) {
      setOwnedTokenIds([]);
      return;
    }
    setOwnedLoading(true);
    try {
      // Owned-token membership changes only on a real transfer (send/buy),
      // both of which explicitly invalidateSwr() below -- safe to hold a
      // longer stale window here than listings without feeling out of date.
      const data = await swrJson<{
        tokenIds: string[];
        items: Array<{ tokenId: string; name: string | null; imageUrl: string | null }>;
      }>(
        `/api/market/multichain/owned?chainSlug=${chainSlug}&owner=${account}&contractAddress=${collection.contractAddress}`,
        { ttlMs: 20_000, swrMs: 120_000, session: true }
      );
      setOwnedTokenIds(data.tokenIds ?? []);
      setOwnedItems(data.items ?? []);
    } catch {
      setOwnedTokenIds([]);
      setOwnedItems([]);
    } finally {
      setOwnedLoading(false);
    }
  }, [account, chainSlug, collection?.contractAddress]);

  useEffect(() => {
    void loadOwned();
  }, [loadOwned]);

  // SWAPS. Loaded per-chain, NOT per-collection (unlike bundles): a swap's
  // offer and consideration items can each span multiple contracts, so
  // "the collection this swap belongs to" isn't a well-defined value --
  // see swap-orders-store.ts's getSwapListings for the same reasoning on
  // the storage side. Filtered client-side to swaps that actually touch
  // the collection being viewed, so the section stays relevant to the page.
  const loadSwaps = useCallback(async () => {
    if (!isForeignEvm) {
      setSwaps([]);
      return;
    }
    setSwapsLoading(true);
    try {
      const data = await swrJson<{ swaps: SwapRow[] }>(
        `/api/market/multichain/native-swap-orders?chainSlug=${chainSlug}`,
        { ttlMs: 15_000, swrMs: 60_000, session: true }
      );
      setSwaps(data.swaps ?? []);
    } catch {
      setSwaps([]);
    } finally {
      setSwapsLoading(false);
    }
  }, [isForeignEvm, chainSlug]);

  useEffect(() => {
    void loadSwaps();
  }, [loadSwaps]);

  const loadBundles = useCallback(async () => {
    if (!isForeignEvm || !collection?.contractAddress) {
      setBundles([]);
      return;
    }
    setBundlesLoading(true);
    try {
      const data = await swrJson<{ bundles: Array<{ id: string; maker: string; tokenIds: string[]; priceWei: string; expiresAt: string }> }>(
        `/api/market/multichain/native-bundle-orders?chainSlug=${chainSlug}&contractAddress=${collection.contractAddress}`,
        { ttlMs: 15_000, swrMs: 60_000, session: true }
      );
      setBundles(data.bundles ?? []);
    } catch {
      setBundles([]);
    } finally {
      setBundlesLoading(false);
    }
  }, [isForeignEvm, chainSlug, collection?.contractAddress]);

  useEffect(() => {
    void loadBundles();
  }, [loadBundles]);

  const loadOffers = useCallback(async () => {
    try {
      const data = await swrJson<{ offers: ForeignOffer[] }>(
        `/api/market/multichain/offers?chainSlug=${chainSlug}&collectionSlug=${encodeURIComponent(collectionSlug)}&limit=20`,
        { ttlMs: 15_000, swrMs: 90_000, session: true }
      );
      setOffers(data.offers ?? []);
    } catch {
      setOffers([]);
    } finally {
      setOffersLoading(false);
    }
  }, [chainSlug, collectionSlug]);

  useEffect(() => {
    void loadOffers();
  }, [loadOffers]);

  const loadActivity = useCallback(async () => {
    try {
      // Sale/transfer history is inherently append-only for anything already
      // recorded -- a long swr window is correct, the only "freshness" that
      // matters is whether a NEW event has landed.
      const data = await swrJson<{ events: ForeignActivityEvent[] }>(
        `/api/market/multichain/activity?chainSlug=${chainSlug}&collectionSlug=${encodeURIComponent(collectionSlug)}&limit=25`,
        { ttlMs: 30_000, swrMs: 300_000, session: true }
      );
      setActivity(data.events ?? []);
    } catch {
      setActivity([]);
    } finally {
      setActivityLoading(false);
    }
  }, [chainSlug, collectionSlug]);

  useEffect(() => {
    void loadActivity();
  }, [loadActivity]);

  const loadMyListings = useCallback(async () => {
    if (!account) {
      setMyListings([]);
      return;
    }
    setMyListingsLoading(true);
    try {
      const data = await swrJson<{ listings: MyListing[] }>(
        `/api/market/multichain/my-listings?chainSlug=${chainSlug}&collectionSlug=${encodeURIComponent(collectionSlug)}&maker=${account}`,
        { ttlMs: 15_000, swrMs: 90_000, session: true }
      );
      setMyListings(data.listings ?? []);
    } catch {
      setMyListings([]);
    } finally {
      setMyListingsLoading(false);
    }
  }, [account, chainSlug, collectionSlug]);

  useEffect(() => {
    void loadMyListings();
  }, [loadMyListings]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // isGood: never let a "not indexed yet" response lock out a real
        // one for the full 30-minute swr window -- the exact stale-empty-
        // poisons-cache failure mode swr-fetch.ts's own isGood guard exists
        // for (see its header comment on the vault-58 bug). Indexing is a
        // one-off background job (scripts/index-foreign-rarity.ts), so a
        // collection can go from unindexed to indexed between two page
        // loads within the same swr window.
        const rarityUrl = `/api/market/multichain/rarity?chainSlug=${chainSlug}&collectionSlug=${encodeURIComponent(collectionSlug)}`;
        const apply = (data: {
          byTokenId?: Record<string, { name: string; tier: string; rank: number; percentile: number; score?: number }>;
          sampleSize?: number;
          partial?: boolean;
        }) => {
          const map = new Map<string, RarityLookup>();
          for (const [tokenId, v] of Object.entries(data.byTokenId ?? {})) {
            map.set(tokenId, { ...v, tier: normalizeRarityTier(v.tier), score: v.score });
          }
          if (map.size === 0) return false;
          setRarityFromIndex(true);
          setRarityMap(map);
          setRaritySample({ size: data.sampleSize ?? map.size, partial: Boolean(data.partial) });
          return true;
        };
        const data = await swrJson<{
          byTokenId: Record<string, { name: string; tier: string; rank: number; percentile: number; score?: number }>;
          indexed: boolean;
          sampleSize?: number;
          partial?: boolean;
        }>(rarityUrl, { ttlMs: 15_000, swrMs: 120_000, session: true, isGood: (d) => Boolean((d as { indexed?: boolean })?.indexed) });
        if (cancelled) return;
        const ready = apply(data);
        if (!ready) {
          for (const wait of [4_000, 8_000, 16_000]) {
            await new Promise((r) => setTimeout(r, wait));
            if (cancelled) return;
            invalidateSwr(rarityUrl);
            const again = await fetch(rarityUrl, { cache: "no-store" }).then((res) => res.json()).catch(() => null);
            if (again && apply(again)) break;
          }
        }
      } catch {
        /* keep any listing-local snapshot */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [chainSlug, collectionSlug]);

  useEffect(() => {
    if (rarityFromIndex) return;
    const items = listings
      .filter((l) => l.tokenId && (l.traits?.length ?? 0) > 0)
      .map((l) => ({ tokenId: l.tokenId, name: l.tokenName ?? null, traits: l.traits ?? [] }));
    if (items.length < 3) return;
    const snap = computeGenericRaritySnapshot(items);
    const map = new Map<string, RarityLookup>();
    for (const [tokenId, v] of snap.byTokenId) {
      map.set(tokenId, { name: v.name, tier: normalizeRarityTier(v.tier), rank: v.rank, percentile: v.percentile });
    }
    setRarityMap(map);
    setRaritySample({ size: snap.sampleSize, partial: true });
  }, [listings, rarityFromIndex]);

  const requireAccount = useCallback(async () => {
    if (account) return account;
    try {
      if (isSolana) {
        const { connectPhantomWallet } = await import("@/lib/market/multichain/trading/non-evm-wallet");
        const addr = await connectPhantomWallet();
        setNonEvmAccount(addr);
        return addr;
      }
      if (isBitcoin) {
        const { connectUnisatWallet } = await import("@/lib/market/multichain/trading/non-evm-wallet");
        const addr = await connectUnisatWallet();
        setNonEvmAccount(addr);
        return addr;
      }
      const addr = await connectWallet();
      adoptAccount(addr);
      return addr;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Wallet connection failed.");
      return null;
    }
  }, [account, adoptAccount, isSolana, isBitcoin]);

  /**
   * Accept a swap: deliver the items its maker asked for (plus any ETH
   * top-up and the marketplace fee) and receive what they offered, in one
   * Seaport fulfillment. Reuses fulfillMarketplankNativeSwapOrder, which
   * goes through the same fulfillOrder path every other native order type
   * already uses -- the caller needs the counterparty items approved, which
   * Seaport's own approval step in that flow handles.
   */
  /** Swaps whose offer OR consideration touches the collection being viewed. */
  const relevantSwaps = useMemo(() => {
    const contract = collection?.contractAddress?.toLowerCase();
    if (!contract) return [];
    return swaps.filter((s) =>
      [...s.offerItems, ...s.considerationItems].some((i) => i.contractAddress.toLowerCase() === contract)
    );
  }, [swaps, collection?.contractAddress]);

  const confirmAcceptSwap = useCallback(
    async (swapId: string) => {
      setSwapError(null);
      const who = await requireAccount();
      if (!who) return;
      try {
        setSwapAccepting(swapId);
        const { fulfillMarketplankNativeSwapOrder } = await import("@/lib/market/multichain/trading/native-fulfill");
        await fulfillMarketplankNativeSwapOrder(chainSlug, swapId);
        await loadSwaps();
        await loadOwned();
      } catch (e) {
        console.error("Swap accept failed:", e);
        setSwapError(e instanceof Error ? e.message : "Swap failed.");
      } finally {
        setSwapAccepting(null);
      }
    },
    [chainSlug, requireAccount, loadSwaps, loadOwned]
  );

  const confirmBuyBundle = useCallback(
    async (bundleId: string) => {
      setBundleError(null);
      const who = await requireAccount();
      if (!who) return;
      try {
        setBundleBuying(bundleId);
        const { fulfillMarketplankNativeBundleOrder } = await import("@/lib/market/multichain/trading/native-fulfill");
        await fulfillMarketplankNativeBundleOrder(chainSlug, bundleId);
        await loadBundles();
        await loadOwned();
      } catch (e) {
        console.error("Bundle buy failed:", e);
        setBundleError(e instanceof Error ? e.message : "Bundle purchase failed.");
      } finally {
        setBundleBuying(null);
      }
    },
    [chainSlug, requireAccount, loadBundles, loadOwned]
  );

  // Loaded eagerly (not just on Details-open) -- the trait FILTER bar below
  // needs the real category/value list to populate its dropdowns before the
  // viewer ever opens a single item's Details.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const idx = await swrJson<TraitIndexResponse>(
          `/api/market/multichain/trait-index?chainSlug=${chainSlug}&collectionSlug=${encodeURIComponent(collectionSlug)}`,
          { ttlMs: 15_000, swrMs: 120_000, session: true, isGood: (d) => Boolean((d as TraitIndexResponse)?.complete) }
        );
        if (!cancelled) {
          setTraitIndex(idx);
          if (idx.traits) {
            const derived: Record<string, Record<string, number>> = {};
            for (const [type, values] of Object.entries(idx.traits)) {
              derived[type] = {};
              for (const [value, ids] of Object.entries(values)) derived[type][value] = ids.length;
            }
            setTraitCounts((prev) => (prev && Object.keys(prev).length > 0 ? prev : derived));
            if (idx.complete) setSweepClauses((prev) => (prev.length > 0 ? prev : defaultFirstClause(idx.traits!) ? [defaultFirstClause(idx.traits!)!] : []));
          }
        }
      } catch {
        if (!cancelled && traitCounts == null) setTraitCounts({});
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [collectionSlug, chainSlug, isSolana, isBitcoin]);

  const browseAsListing = useCallback(
    (tokenId: string, imageUrl?: string | null, name?: string | null,
      animationUrl?: string | null, mediaType?: string | null): Listing => {
      const live = listings.find((l) => l.tokenId === tokenId);
      if (live) return { ...live, animationUrl: animationUrl ?? live.animationUrl,
        mediaType: mediaType ?? live.mediaType };
      return {
        id: `browse:${chainSlug}:${tokenId}`,
        collectionSlug,
        tokenId,
        maker: "0x0000000000000000000000000000000000000000",
        priceWei: "0",
        expiresAt: new Date(0).toISOString(),
        kind: "fixed",
        imageUrl: imageUrl ?? undefined,
        animationUrl: animationUrl ?? undefined,
        mediaType: mediaType ?? undefined,
        foreignChainSlug: chainSlug,
      };
    },
    [listings, chainSlug, collectionSlug]
  );

  const openDetails = useCallback(
    (tokenId: string) => {
      const token = tokens.find((t) => t.tokenId === tokenId);
      setDetailsTarget(browseAsListing(tokenId, token?.imageUrl, token?.name,
        token?.animationUrl, token?.mediaType));
    },
    [tokens, browseAsListing]
  );

  const openOffer = useCallback(
    async (listing: Listing) => {
      setOfferError(null);
      setOfferAmountEth("");
      setOfferTarget(listing);
    },
    []
  );

  const confirmOffer = useCallback(async () => {
    if (!offerTarget) return;
    if (!account) { await requireAccount(); return; }
    if (!isSolana && !collection?.contractAddress) return;
    setOfferError(null);
    try {
      setOfferBusy(true);
      const offerWei = BigInt(Math.round(Number(offerAmountEth) * 1e18));
      if (isSolana) {
        // offerTarget.tokenId IS the tokenMint for Solana rows (see
        // listings/route.ts's "solana" branch: tokenId: l.tokenMint) --
        // same identifier buySolanaListingNow already uses. priceLamports
        // unscale: offerAmountEth is really "SOL amount" here (the input
        // is generic, ForeignOfferConfirm just labels it SOL for this
        // branch), so 1 SOL = 1e9 lamports directly -- NOT the 1e18-wei
        // convention offerWei above uses for EVM currencies.
        const priceLamports = BigInt(Math.round(Number(offerAmountEth) * 1_000_000_000)).toString();
        const { placeSolanaOfferNow } = await import("@/lib/market/multichain/trading/foreign-fulfill");
        await placeSolanaOfferNow({ tokenMint: offerTarget.tokenId, priceLamports });
      } else {
        const { buildForeignOffer } = await import("@/lib/market/multichain/trading/foreign-offer");
        const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
        await buildForeignOffer({
          chainSlug,
          collectionAddress: collection!.contractAddress,
          tokenId: offerTarget.tokenId,
          offerWei,
          expiresAt,
          accountAddress: account,
        });
      }
      setOfferTarget(null);
      setStatus("Offer submitted.");
      invalidateSwr("/api/market/multichain/offers");
      await loadOffers();
    } catch (e) {
      console.error("Offer failed:", e);
      setOfferError(e instanceof Error ? e.message : "Offer failed.");
    } finally {
      setOfferBusy(false);
      setStatus(null);
    }
  }, [offerTarget, account, collection, isSolana, chainSlug, offerAmountEth, loadOffers, requireAccount]);

  const handleAcceptOffer = useCallback(
    async (offer: ForeignOffer) => {
      setAcceptError(null);
      const who = await requireAccount();
      if (!who) return;
      try {
        setAcceptingOrderHash(offer.orderHash);
        setStatus("Confirm in wallet…");
        if (isRobinhoodChainSlug(chainSlug)) {
          // Native path: same Seaport fulfillOrder RobinWood's own Offers
          // tab already uses, not the third-party-signer OpenSea flow below.
          const { acceptRobinhoodOfferNow } = await import("@/lib/market/multichain/trading/foreign-fulfill");
          await acceptRobinhoodOfferNow({ chainSlug, collectionSlug, orderHash: offer.orderHash });
        } else if (offer.native) {
          // Marketplank-native offer on a foreign EVM chain -- direct
          // Seaport fulfillment, not the router-based acceptForeignOffer
          // path below (that one is for THIRD-PARTY OpenSea offers only).
          const { fulfillMarketplankNativeOrder } = await import("@/lib/market/multichain/trading/native-fulfill");
          if (offer.tokenId) {
            // Plain single-token offer -- no criteria proof needed.
            await fulfillMarketplankNativeOrder(chainSlug, offer.orderHash, "offer");
          } else if (offer.criteriaTokenIds && offer.criteriaTokenIds.length > 0) {
            // TRAIT-criteria offer -- same real cross-check MarketView.tsx's
            // own handleAcceptTraitOffer/confirmAcceptTraitOffer already
            // proved for Robinhood Chain, just chain-parameterized. Picks
            // the first qualifying owned token automatically (a full
            // seller-facing picker is a real, bounded future enhancement,
            // not built in this pass).
            const owned = new Set(ownedTokenIds.map((id) => BigInt(id).toString()));
            const snapshot = new Set(offer.criteriaTokenIds.map((id) => BigInt(id).toString()));
            const qualifying = [...owned].filter((id) => snapshot.has(id)).sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1));
            if (qualifying.length === 0) {
              throw new Error("None of your owned items qualify for this trait offer.");
            }
            const chosenTokenId = qualifying[0];
            const rawOrderRes = await fetch(`/api/market/native-order?id=${encodeURIComponent(offer.orderHash)}&kind=offer`);
            if (!rawOrderRes.ok) throw new Error("This offer is no longer available.");
            const { rawOrder } = (await rawOrderRes.json()) as { rawOrder: unknown };
            const { validateOfferOrder } = await import("@/lib/market/order-validation");
            const { assertAcceptableTraitOffer } = await import("@/lib/market/seaport");
            const nativeCollection: MarketCollection = {
              slug: collection?.slug ?? `${chainSlug}:${collectionSlug}`,
              name: collection?.name ?? collectionSlug,
              contractAddress: collectionSlug,
              tokenStandard: "ERC721",
              image: collection?.image ?? "",
              trustBadges: [],
              feeBps: MARKETPLANK_NATIVE_LISTING_FEE_BPS,
              royaltyBps: 0,
              royaltyRecipient: "0x0000000000000000000000000000000000000000",
            };
            const derived = validateOfferOrder(rawOrder, nativeCollection, foreignOfferCurrency(chainSlug) ?? "", {
              criteriaTokenIds: offer.criteriaTokenIds,
            });
            const criteria = assertAcceptableTraitOffer(
              { priceWei: offer.priceWei, criteriaTokenIds: offer.criteriaTokenIds },
              derived,
              chosenTokenId
            );
            await fulfillMarketplankNativeOrder(chainSlug, offer.orderHash, "offer", [criteria]);
          } else {
            throw new Error("This offer is missing its token snapshot and cannot be accepted.");
          }
        } else {
          const { acceptForeignOffer } = await import("@/lib/market/multichain/trading/foreign-offer");
          const fillTokenId = offer.tokenId || (offer.isWildcard ? ownedTokenIds[0] : undefined);
          if (offer.isWildcard && !fillTokenId) {
            throw new Error("Own a token in this collection to accept a collection-wide bid.");
          }
          await acceptForeignOffer({
            chainSlug,
            orderHash: offer.orderHash,
            accountAddress: who,
            tokenId: fillTokenId ?? undefined,
          });
        }
        setStatus("Offer accepted.");
        invalidateSwr("/api/market/multichain/offers");
        invalidateSwr("/api/market/multichain/listings");
        invalidateSwr("/api/market/multichain/owned");
        await loadOffers();
        await loadOwned();
      } catch (e) {
        console.error("Accept offer failed:", e);
        setAcceptError(e instanceof Error ? e.message : "Accept failed.");
      } finally {
        setAcceptingOrderHash(null);
        setStatus(null);
      }
    },
    [chainSlug, collectionSlug, requireAccount, loadOffers, loadOwned]
  );

  const handleBuy = useCallback(
    async (listing: Listing) => {
      setError(null);
      if (!isCrossChainBuyable(listing)) return;
      setBuyTarget(listing);
    },
    []
  );

  const confirmBuy = useCallback(async () => {
    if (!buyTarget) return;
    if (!account) { await requireAccount(); return; }
    setError(null);
    try {
      setBuyBusy(true);
      setStatus("Confirm in wallet…");
      const { buyForeignListingNow } = await import("@/lib/market/multichain/trading/foreign-fulfill");
      await buyForeignListingNow({
        chainSlug: buyTarget.foreignChainSlug!,
        orderHash: buyTarget.foreignOrderHash!,
        collectionSlug,
        // Consumed by the Solana/Bitcoin branches as the price to submit,
        // AND by the EVM branch as the price the freshly-fetched signed
        // order is asserted against (audit finding C1 -- a third-party
        // order must never be fulfilled without checking it matches what
        // the user was shown).
        priceWei: buyTarget.priceWei,
        expectedContractAddress: collection?.contractAddress,
        expectedTokenId: buyTarget.tokenId,
        expectedMaker: buyTarget.maker,
        solanaEscrow: buyTarget.solanaEscrow,
      });
      setBuyTarget(null);
      setStatus("Purchase confirmed.");
      invalidateSwr("/api/market/multichain/listings");
      invalidateSwr("/api/market/multichain/owned");
      await load();
      await loadOwned();
    } catch (e) {
      console.error("Cross-chain buy failed:", e);
      setError(e instanceof Error ? e.message : "Purchase failed.");
    } finally {
      setBuyBusy(false);
      setStatus(null);
    }
  }, [buyTarget, load, loadOwned, account, requireAccount]);

  // AND-combined active trait clauses, derived from selectedTraits --
  // shared by the client-side grid filter and the server-side sweep call.
  const traitClauses = useMemo(
    () => Object.entries(selectedTraits).filter(([, value]) => value !== "").map(([traitType, value]) => ({ traitType, value })),
    [selectedTraits]
  );

  const rarityFor = useCallback(
    (tokenId: string) => {
      const hit = rarityMapGet(rarityMap, tokenId);
      if (hit) return hit;
      const listing = listings.find((l) => l.tokenId === tokenId);
      if (!listing?.traits?.length || !traitIndex?.traits || !raritySample?.size) return undefined;
      const traits = listing.traits;
      const knownScoresAsc = [...rarityMap.values()]
        .map((v) => v.score)
        .filter((n): n is number => typeof n === "number" && Number.isFinite(n))
        .sort((a, b) => a - b);
      const row = scoreTokenAgainstTraitIndex({
        tokenId,
        name: listing.tokenName ?? null,
        traits,
        traitIndex: traitIndex.traits,
        sampleSize: raritySample.size,
        knownScoresAsc,
      });
      return { name: row.name, tier: normalizeRarityTier(row.tier), rank: row.rank, percentile: row.percentile, score: row.score };
    },
    [rarityMap, listings, traitIndex, raritySample]
  );

  const filteredListings = useMemo(() => {
    const q = searchQuery.trim();
    const min = minPriceEth.trim() ? Number(minPriceEth) : null;
    const max = maxPriceEth.trim() ? Number(maxPriceEth) : null;
    const rows = listings.filter((l) => {
      if (q && !l.tokenId.toLowerCase().includes(q.toLowerCase()) && !(l.tokenName ?? "").toLowerCase().includes(q.toLowerCase())) return false;
      const priceEth = Number(l.priceWei) / 1e18;
      if (min !== null && priceEth < min) return false;
      if (max !== null && priceEth > max) return false;
      if (traitClauses.length > 0) {
        const has = (traitType: string, value: string) => (l.traits ?? []).some((t) => t.traitType === traitType && t.value === value);
        if (!traitClauses.every((c) => has(c.traitType, c.value))) return false;
      }
      const tierFilter = activeTiers.length > 0 ? activeTiers : activeTier !== "all" ? [activeTier] : [];
      if (tierFilter.length > 0) {
        const r = rarityFor(l.tokenId);
        if (!r || !tierFilter.includes(r.tier)) return false;
      }
      return true;
    });
    if (listingSort === "default" || listingSort === "price-asc" || listingSort === "price-desc") {
      const dir = listingSort === "price-desc" ? -1 : 1;
      return [...rows].sort((a, b) => (BigInt(a.priceWei) < BigInt(b.priceWei) ? -dir : BigInt(a.priceWei) > BigInt(b.priceWei) ? dir : 0));
    }
    if (listingSort === "rarity-asc" || listingSort === "rarity-desc") {
      const dir = listingSort === "rarity-asc" ? 1 : -1;
      return [...rows].sort((a, b) => {
        const ra = rarityFor(a.tokenId)?.rank ?? null;
        const rb = rarityFor(b.tokenId)?.rank ?? null;
        if (ra == null && rb == null) return 0;
        if (ra == null) return 1;
        if (rb == null) return -1;
        return (ra - rb) * dir;
      });
    }
    return rows;
  }, [listings, searchQuery, minPriceEth, maxPriceEth, traitClauses, activeTier, activeTiers, listingSort, rarityFor]);

  const listingByToken = useMemo(() => {
    const map = new Map<string, Listing>();
    for (const l of listings) {
      for (const k of tokenIdAliases(l.tokenId)) map.set(k, l);
    }
    return map;
  }, [listings]);

  const browseItems = useMemo(() => {
    if (bookFilter === "listed") {
      return filteredListings.map((listing) => ({ tokenId: listing.tokenId, name: null,
        imageUrl: listing.imageUrl ?? null, animationUrl: listing.animationUrl ?? null,
        mediaType: listing.mediaType ?? null, listing }));
    }
    const q = searchQuery.trim().toLowerCase();
    const fromTokens = tokens
      .filter((t) => {
        if (q && !t.tokenId.toLowerCase().includes(q) && !(t.name ?? "").toLowerCase().includes(q)) return false;
        if (traitClauses.length > 0) {
          const has = (traitType: string, value: string) =>
            (t.traits ?? []).some((trait) => trait.traitType === traitType && trait.value === value);
          if (!traitClauses.every((clause) => has(clause.traitType, clause.value))) return false;
        }
        const tierFilter = activeTiers.length > 0 ? activeTiers : activeTier !== "all" ? [activeTier] : [];
        if (tierFilter.length > 0) {
          const r = rarityFor(t.tokenId);
          if (!r || !tierFilter.includes(normalizeRarityTier(r.tier))) return false;
        }
        return true;
      })
      .map((t) => ({
      tokenId: t.tokenId,
      name: t.name,
      animationUrl: t.animationUrl,
      mediaType: t.mediaType,
      imageUrl:
        t.imageUrl ||
        catalogArtExtras(chainSlug, collection?.contractAddress || collectionSlug, t.tokenId)[0] ||
        null,
      listing: tokenIdAliases(t.tokenId).map((k) => listingByToken.get(k)).find(Boolean) ?? null,
    }));
    const rows = fromTokens;
    const tierPos = (id: string) => {
      const t = rarityFor(id)?.tier;
      const i = t ? TIER_ORDER.indexOf(t) : -1;
      return i < 0 ? TIER_ORDER.length : i;
    };
    if (listingSort === "rarity-asc" || listingSort === "rarity-desc") {
      const dir = listingSort === "rarity-asc" ? 1 : -1;
      rows.sort((a, b) => {
        const td = (tierPos(a.tokenId) - tierPos(b.tokenId)) * dir;
        if (td !== 0) return td;
        const ra = rarityFor(a.tokenId)?.rank ?? null;
        const rb = rarityFor(b.tokenId)?.rank ?? null;
        if (ra == null && rb == null) return 0;
        if (ra == null) return 1;
        if (rb == null) return -1;
        return (ra - rb) * dir;
      });
    } else {
      rows.sort((a, b) => {
        try {
          const na = BigInt(a.tokenId);
          const nb = BigInt(b.tokenId);
          return na < nb ? -1 : na > nb ? 1 : 0;
        } catch {
          return a.tokenId.localeCompare(b.tokenId);
        }
      });
    }
    return rows;
  }, [bookFilter, tokens, filteredListings, listingByToken, searchQuery, activeTier, activeTiers, traitClauses, rarityMap, collection?.contractAddress, collectionSlug, listingSort, rarityFor]);

  // URL persistence -- reflects real filter/sort state into the query
  // string (router.replace, not push, so browsing doesn't spam history),
  // same pattern PortfolioView.tsx's own ?wallet= param and
  // GlobalMarketHub.tsx's own filter state already establish.
  useEffect(() => {
    const params = new URLSearchParams();
    if (searchQuery.trim()) params.set("q", searchQuery.trim());
    if (minPriceEth.trim()) params.set("min", minPriceEth.trim());
    if (maxPriceEth.trim()) params.set("max", maxPriceEth.trim());
    if (traitClauses.length > 0) params.set("traits", JSON.stringify(selectedTraits));
    if (activeTier !== "all") params.set("tier", activeTier);
    if (listingSort !== "price-asc") params.set("sort", listingSort);
    if (bookFilter !== "listed") params.set("show", bookFilter);
    const qs = params.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- router/pathname are stable per Next.js contract.
  }, [searchQuery, minPriceEth, maxPriceEth, selectedTraits, traitClauses.length, activeTier, listingSort, bookFilter]);

  const openSweepPreview = useCallback(async () => {
    setError(null);
    // Preview from the trait-filtered set when a filter is active, so what
    // the confirm modal shows matches what the real sweep (below, via
    // fetchForeignTraitFilteredListings) will actually pull.
    let source = traitClauses.length > 0 ? filteredListings : listings;
    if (sweepScope === "tier" && activeTier !== "all") {
      source = source.filter((l) => rarityFor(l.tokenId)?.tier === activeTier);
    }
    if (sweepScope === "trait" && traitIndex?.traits && sweepClauses.length > 0) {
      const ids = new Set(resolveCriteriaTokenIds(traitIndex.traits, sweepClauses, traitIndex.rankings));
      source = source.filter((l) => {
        if (ids.has(l.tokenId)) return true;
        try {
          return ids.has(BigInt(l.tokenId).toString());
        } catch {
          return false;
        }
      });
    }
    const cheapest = [...source]
      .filter((l) => isCrossChainBuyable(l))
      .sort((a, b) => (BigInt(a.priceWei) < BigInt(b.priceWei) ? -1 : 1))
      .slice(0, sweepCount);
    if (cheapest.length === 0) {
      setError(
        sweepScope !== "floor" || traitClauses.length > 0
          ? "No cross-chain-buyable listings match the selected sweep scope right now."
          : "No cross-chain-buyable listings available to sweep right now."
      );
      return;
    }
    setSweepPreview(cheapest);
  }, [listings, filteredListings, traitClauses, sweepCount, sweepScope, activeTier, rarityMap, traitIndex, sweepClauses]);

  const confirmSweep = useCallback(async () => {
    if (!sweepPreview || sweepPreview.length === 0) return;
    if (!account) { await requireAccount(); return; }
    setError(null);
    setSweepStatuses(null);
    try {
      setSweepBusy(true);
      setStatus("Confirm in wallet…");
      if (isSolana) {
        // priceLamports unscale: same 1e9 convention buyForeignListingNow's
        // own Solana branch uses -- see that function's comment.
        // sweepSolanaListingsBatched (not the older sequential
        // sweepSolanaListingsNow) -- real single/minimum-signature batching
        // via instruction extraction+recombination, with an internal
        // per-item sequential fallback for anything it can't safely fold
        // into a shared transaction (see foreign-fulfill.ts's header).
        const { sweepSolanaListingsBatched } = await import("@/lib/market/multichain/trading/foreign-fulfill");
        const statuses = await sweepSolanaListingsBatched({
          listings: sweepPreview.map((l) => ({ tokenMint: l.foreignOrderHash ?? l.id, priceLamports: (BigInt(l.priceWei) / BigInt(1_000_000_000)).toString() })),
          onUpdate: setSweepStatuses,
        });
        const attempted = [...statuses.values()].filter((s) => s.state === "sent").length;
        setSweepPreview(null);
        setStatus(`Swept ${attempted} of ${sweepPreview.length} item(s).`);
      } else if (isBitcoin) {
        // priceSats unscale: same 1e10 convention buyForeignListingNow's own Bitcoin branch uses.
        const { sweepBitcoinListingsNow } = await import("@/lib/market/multichain/trading/foreign-fulfill");
        const statuses = await sweepBitcoinListingsNow({
          listings: sweepPreview.map((l) => ({ auctionId: l.foreignOrderHash ?? l.id, priceSats: (BigInt(l.priceWei) / BigInt(10_000_000_000)).toString() })),
          onUpdate: setSweepStatuses,
        });
        const attempted = [...statuses.values()].filter((s) => s.state === "sent").length;
        setSweepPreview(null);
        setStatus(`Swept ${attempted} of ${sweepPreview.length} item(s).`);
      } else {
        const { sweepForeignListings } = await import("@/lib/market/multichain/trading/foreign-fulfill");
        const result = await sweepForeignListings({
          chainSlug,
          collectionSlug,
          count: sweepPreview.length,
          traits: traitClauses.length > 0 ? traitClauses : undefined,
        });
        setSweepPreview(null);
        setStatus(`Swept ${result.attempted} item(s).`);
      }
      invalidateSwr("/api/market/multichain/listings");
      invalidateSwr("/api/market/multichain/owned");
      await load();
      await loadOwned();
    } catch (e) {
      console.error("Cross-chain sweep failed:", e);
      setError(e instanceof Error ? e.message : "Sweep failed.");
    } finally {
      setSweepBusy(false);
      setStatus(null);
    }
  }, [sweepPreview, chainSlug, collectionSlug, isSolana, isBitcoin, traitClauses, load, loadOwned, account, requireAccount]);

  const openCombinedPreview = useCallback(async () => {
    setCombinedError(null);
    const budget = Number(combinedBudgetEth);
    if (!(budget > 0)) {
      setCombinedError("Enter a budget greater than 0.");
      return;
    }
    const budgetWei = BigInt(Math.round(budget * 1e18));
    const source = traitClauses.length > 0 ? filteredListings : listings;
    const buyable = [...source].filter((l) => isCrossChainBuyable(l)).sort((a, b) => (BigInt(a.priceWei) < BigInt(b.priceWei) ? -1 : 1));

    const affordable: Listing[] = [];
    let spent = BigInt(0);
    for (const l of buyable) {
      const price = BigInt(l.priceWei);
      // No Marketplank fee on Solana/Bitcoin (same as the plain sweep/buy
      // flows for those chains) -- see confirmSweep's own feeBps=0 note.
      const fee = isNonEvm ? BigInt(0) : (price * BigInt(FOREIGN_FEE_BPS)) / BigInt(10_000);
      const cost = price + fee;
      if (spent + cost > budgetWei) break;
      affordable.push(l);
      spent += cost;
    }
    const remainder = buyable.slice(affordable.length, affordable.length + COMBINED_REMAINDER_CAP);

    if (affordable.length === 0 && remainder.length === 0) {
      setCombinedError(
        traitClauses.length > 0
          ? "No cross-chain-buyable listings match the selected traits right now."
          : "No cross-chain-buyable listings available right now."
      );
      return;
    }
    setCombinedPreview({ affordable, remainder });
  }, [combinedBudgetEth, listings, filteredListings, traitClauses, isNonEvm]);

  const confirmCombined = useCallback(async () => {
    if (!combinedPreview) return;
    if (!account) { await requireAccount(); return; }
    const { affordable, remainder } = combinedPreview;
    setCombinedError(null);
    setCombinedStatuses(null);
    try {
      setCombinedBusy(true);
      setStatus("Confirm in wallet…");

      // PART 1: sweep everything that fits the budget -- reuses the exact
      // same per-chain-family sweep functions confirmSweep itself calls,
      // just with the "affordable" subset instead of sweepPreview.
      let sweptCount = 0;
      if (affordable.length > 0) {
        if (isSolana) {
          const { sweepSolanaListingsBatched } = await import("@/lib/market/multichain/trading/foreign-fulfill");
          const statuses = await sweepSolanaListingsBatched({
            listings: affordable.map((l) => ({ tokenMint: l.foreignOrderHash ?? l.id, priceLamports: (BigInt(l.priceWei) / BigInt(1_000_000_000)).toString() })),
            onUpdate: setCombinedStatuses,
          });
          sweptCount = [...statuses.values()].filter((s) => s.state === "sent").length;
        } else if (isBitcoin) {
          const { sweepBitcoinListingsNow } = await import("@/lib/market/multichain/trading/foreign-fulfill");
          const statuses = await sweepBitcoinListingsNow({
            listings: affordable.map((l) => ({ auctionId: l.foreignOrderHash ?? l.id, priceSats: (BigInt(l.priceWei) / BigInt(10_000_000_000)).toString() })),
            onUpdate: setCombinedStatuses,
          });
          sweptCount = [...statuses.values()].filter((s) => s.state === "sent").length;
        } else {
          const { sweepForeignListings } = await import("@/lib/market/multichain/trading/foreign-fulfill");
          const result = await sweepForeignListings({
            chainSlug,
            collectionSlug,
            count: affordable.length,
            traits: traitClauses.length > 0 ? traitClauses : undefined,
          });
          sweptCount = result.attempted;
        }
      }

      // PART 2: offer for the rest, at COMBINED_OFFER_DISCOUNT_BPS below
      // each item's own listed price -- Bitcoin has no offer-placement
      // primitive at all (confirmed this session, see
      // foreign-fulfill.ts's placeSolanaOfferNow header), so it degrades
      // to sweep-only here rather than faking an offer.
      let offeredCount = 0;
      if (!isBitcoin) {
        for (const listing of remainder) {
          const offerPriceWei = (BigInt(listing.priceWei) * BigInt(10_000 - COMBINED_OFFER_DISCOUNT_BPS)) / BigInt(10_000);
          try {
            if (isSolana) {
              const { placeSolanaOfferNow } = await import("@/lib/market/multichain/trading/foreign-fulfill");
              await placeSolanaOfferNow({
                tokenMint: listing.foreignOrderHash ?? listing.id,
                priceLamports: (offerPriceWei / BigInt(1_000_000_000)).toString(),
              });
            } else if (collection?.contractAddress) {
              const { buildForeignOffer } = await import("@/lib/market/multichain/trading/foreign-offer");
              const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
              await buildForeignOffer({
                chainSlug,
                collectionAddress: collection.contractAddress,
                tokenId: listing.tokenId,
                offerWei: offerPriceWei,
                expiresAt,
                accountAddress: account!,
              });
            }
            offeredCount += 1;
          } catch (e) {
            // Same "one item's failure doesn't sink the batch" discipline
            // as every sweep function -- an offer that can't be placed
            // (already sold, wallet rejection) just isn't counted, the
            // rest of the remainder still gets tried.
            console.error(`Combined offer failed for #${listing.tokenId}:`, e);
          }
        }
      }

      setCombinedPreview(null);
      setStatus(
        isBitcoin
          ? `Bought ${sweptCount} item(s). Bitcoin has no offer path, so ${remainder.length} beyond budget were left alone.`
          : `Bought ${sweptCount} item(s), offered on ${offeredCount} more.`
      );
      invalidateSwr("/api/market/multichain/listings");
      invalidateSwr("/api/market/multichain/owned");
      invalidateSwr("/api/market/multichain/offers");
      await load();
      await loadOwned();
      await loadOffers();
    } catch (e) {
      console.error("Combined sweep+offer failed:", e);
      setCombinedError(e instanceof Error ? e.message : "Buy + offer failed.");
    } finally {
      setCombinedBusy(false);
      setStatus(null);
    }
  }, [combinedPreview, isSolana, isBitcoin, chainSlug, collectionSlug, collection, account, traitClauses, load, loadOwned, loadOffers, requireAccount]);

  const toggleSendSelection = useCallback((tokenId: string) => {
    setSelectedForSend((prev) => {
      const next = new Set(prev);
      if (next.has(tokenId)) next.delete(tokenId);
      else next.add(tokenId);
      return next;
    });
  }, []);

  const openSendConfirm = useCallback(
    async (tokenIds: string[]) => {
      setError(null);
      setSendTarget(tokenIds);
      setSendRecipient("");
      setSendFeeQuote(null);
      setSendFeeError(null);
      setSendStatuses(null);
      if (isNonEvm) {
        // No Marketplank fee on a Solana/Bitcoin send: SendFeeQuote's shape
        // is gas-PRICE-denominated (EVM's own gwei-market concept), which
        // has no equivalent on either chain (Solana's fee is a near-fixed
        // ~5000 lamports/signature; sendInscription's own `feeRate` option
        // already lets UniSat's wallet size the Bitcoin miner fee). A real
        // zero quote, not a fabricated non-zero one -- ForeignSendConfirm's
        // canConfirm gate just needs a non-null SendFeeQuote to enable the
        // button, and its own copy ("Send fee (N items)") reads correctly
        // as "0 Ξ" without implying a made-up cost.
        setSendFeeQuote({ itemCount: tokenIds.length, gasPriceWei: BigInt(0), totalFeeWei: BigInt(0), averagePerItemWei: BigInt(0), equivalentSingleSendsFeeWei: BigInt(0) });
        return;
      }
      try {
        const { quoteForeignSendFee } = await import("@/lib/market/multichain/trading/foreign-transfer");
        const quote = await quoteForeignSendFee(chainSlug, tokenIds.length);
        setSendFeeQuote(quote);
      } catch (e) {
        setSendFeeError(e instanceof Error ? e.message : "Could not estimate the send fee.");
      }
    },
    [chainSlug, isNonEvm]
  );

  const confirmSend = useCallback(async () => {
    if (!sendTarget) return;
    if (!account) { await requireAccount(); return; }
    if (!isNonEvm && !collection?.contractAddress) return;
    setError(null);
    try {
      setSendBusy(true);
      setStatus("Confirm in wallet…");
      if (isSolana) {
        // sendTarget carries tokenMint (item.tokenId === t.mintAddress for
        // every owned Solana row -- see owned/route.ts's "solana" branch).
        if (sendTarget.length === 1) {
          const { sendSolanaToken } = await import("@/lib/market/multichain/trading/solana-transfer");
          await sendSolanaToken(account, sendTarget[0], sendRecipient);
        } else {
          const { sendSolanaTokenBatch } = await import("@/lib/market/multichain/trading/solana-transfer");
          await sendSolanaTokenBatch(account, sendTarget, sendRecipient, (statuses) => setSendStatuses(statuses));
        }
      } else if (isBitcoin) {
        if (sendTarget.length === 1) {
          const { sendBitcoinInscription } = await import("@/lib/market/multichain/trading/bitcoin-transfer");
          await sendBitcoinInscription(account, sendTarget[0], sendRecipient);
        } else {
          const { sendBitcoinInscriptionBatch } = await import("@/lib/market/multichain/trading/bitcoin-transfer");
          await sendBitcoinInscriptionBatch(account, sendTarget, sendRecipient, (statuses) => setSendStatuses(statuses));
        }
      } else if (sendTarget.length === 1) {
        const { sendForeignNft } = await import("@/lib/market/multichain/trading/foreign-transfer");
        await sendForeignNft(chainSlug, collection!.contractAddress, sendTarget[0], sendRecipient, account);
      } else {
        const { sendForeignNftBatch } = await import("@/lib/market/multichain/trading/foreign-transfer");
        await sendForeignNftBatch(
          chainSlug,
          sendTarget.map((tokenId) => ({ chainSlug, collectionAddress: collection!.contractAddress, tokenId })),
          sendRecipient,
          account,
          (statuses) => setSendStatuses(statuses)
        );
      }
      setStatus("Sent.");
      setSendTarget(null);
      setSelectedForSend(new Set());
      invalidateSwr("/api/market/multichain/owned");
      await loadOwned();
    } catch (e) {
      console.error("Send failed:", e);
      setError(e instanceof Error ? e.message : "Send failed.");
    } finally {
      setSendBusy(false);
      setStatus(null);
    }
  }, [sendTarget, account, collection?.contractAddress, chainSlug, sendRecipient, isNonEvm, isSolana, isBitcoin, loadOwned, requireAccount]);

  const tokenOffers = useMemo(() => offers.filter((o) => o.acceptable && o.tokenId), [offers]);
  const collectionWideOffers = useMemo(() => offers.filter((o) => !o.acceptable), [offers]);

  if (loading) {
    // Skeleton shaped like the real page (stat bar + card grid), not bare
    // "Loading…" text -- a populated collection shouldn't flash empty/blank
    // on every visit, same rationale as ListingSkeleton.tsx.
    return (
      <div className="space-y-4 p-4">
        <SkeletonStatus>Loading {chainDisplayName(chainSlug)} listings</SkeletonStatus>
        <SkeletonStats count={4} columns="grid-cols-2 sm:grid-cols-4" />
        <SkeletonCardGrid columns="grid-cols-2 sm:grid-cols-3 lg:grid-cols-5" action />
      </div>
    );
  }
  if (loadError || !collection) {
    return <p className="p-6 text-center text-red-300">{loadError ?? "Collection not found."}</p>;
  }

  const buyableCount = listings.filter((l) => isCrossChainBuyable(l)).length;
  const filtersActive =
    searchQuery.trim() !== "" ||
    minPriceEth.trim() !== "" ||
    maxPriceEth.trim() !== "" ||
    traitClauses.length > 0 ||
    activeTier !== "all" ||
    listingSort !== "price-asc" ||
    bookFilter !== "listed" ||
    activeTiers.length > 0;

  // STAT BAR -- real numbers derived from data already loaded for this
  // page (no new API surface): floor = cheapest active listing, best offer
  // = top of the offers list, volume/highest sale = aggregated from the
  // real sale events in the activity feed (bounded to whatever activity/
  // route.ts returned, same honesty as everywhere else here -- this is
  // "volume in the loaded window," not an all-time indexed total).
  const floorWei =
    listings.length > 0
      ? listings.reduce((min, l) => (BigInt(l.priceWei) < BigInt(min) ? l.priceWei : min), listings[0].priceWei)
      : supplyStats?.floorPriceWei ?? null;
  // Real max across BOTH sources merged by this route (native offers first,
  // then OpenSea-sourced offers -- see offers/route.ts's header) -- offers[0]
  // alone was wrong whenever a native offer existed alongside a higher-priced
  // OpenSea offer, since only the OpenSea slice is internally price-sorted,
  // not the combined array. Honestly null (via an empty `offers` array) for
  // Solana/Bitcoin, where no real collection-wide bids source exists yet.
  const bestOfferWei = offers.length > 0 ? offers.reduce((max, o) => (BigInt(o.priceWei) > BigInt(max) ? o.priceWei : max), offers[0].priceWei) : null;
  const saleEvents = activity.filter((e) => e.type === "sale" && e.priceWei);
  const pricedSaleEvents = saleEvents.filter((e) => e.priceUsd != null);
  const activityVolumeUsd = pricedSaleEvents.length > 0
    ? pricedSaleEvents.reduce((sum, e) => sum + e.priceUsd!, 0)
    : null;
  const activityTotalsByCurrency = new Map<string, number>();
  for (const event of saleEvents) {
    const amount = Number(event.priceAmount);
    if (!event.priceSymbol || !Number.isFinite(amount)) continue;
    activityTotalsByCurrency.set(event.priceSymbol, (activityTotalsByCurrency.get(event.priceSymbol) ?? 0) + amount);
  }
  const activityVolumeDisplay = [...activityTotalsByCurrency.entries()]
    .map(([symbol, amount]) => `${amount.toLocaleString(undefined, { maximumFractionDigits: 4 })} ${symbol}`)
    .join(" + ");
  const currenciesInLoadedSales = new Set(saleEvents.map((e) => e.priceSymbol).filter(Boolean));
  const volumeWei =
    saleEvents.length > 0 && currenciesInLoadedSales.size === 1 && [...currenciesInLoadedSales][0] === nativeCurrencySymbol(chainSlug, isSolana, isBitcoin)
      ? saleEvents.reduce((sum, e) => sum + BigInt(e.priceWei!), BigInt(0)).toString()
      : marketStatsWindow === "7d"
        ? marketStats?.volume7dWei ?? null
        : marketStatsWindow === "30d"
          ? marketStats?.volume30dWei ?? null
          : marketStats?.volume24hWei ?? null;
  const highestSale = pricedSaleEvents.length > 0
    ? pricedSaleEvents.reduce((max, e) => e.priceUsd! > max.priceUsd! ? e : max, pricedSaleEvents[0])
    : null;
  const statCurrencySymbol = nativeCurrencySymbol(chainSlug, isSolana, isBitcoin);
  const statUsd = (weiStr: string | null): number | null => toUsd(weiStr, statCurrencySymbol);
  const floorCurrencySymbol = listings.length > 0 ? statCurrencySymbol : (supplyStats?.floorPriceCurrency ?? statCurrencySymbol);
  const floorUsd = (weiStr: string | null): number | null => toUsd(weiStr, floorCurrencySymbol);

  return (
    <div className="space-y-4 p-4">
      <MarketBreadcrumb variant="collection" chainSlug={chainSlug} collectionName={collection.name} />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-3">
            {collection.image ? (
              <div className="relative h-12 w-12 shrink-0 overflow-hidden rounded-md border border-line bg-wood-900">
                <CollectionArtImage src={collection.image} alt="" width={256} variant="thumb" />
              </div>
            ) : null}
            <div className="min-w-0">
          <h2 className="truncate font-display text-xl text-gold-300" title={collection.name}>
            {collection.name}
          </h2>
          <p className="text-xs text-foreground/50">
            {supplyStats?.listedCount != null
              ? `${supplyStats.listedCount.toLocaleString()} listed of ${supplyStats.totalSupply != null ? supplyStats.totalSupply.toLocaleString() : "—"} on ${chainDisplayName(chainSlug)}${listingsUnavailable ? " · UniSat book delayed" : ""}`
              : `${listings.length} listing${listings.length === 1 ? "" : "s"} on ${chainDisplayName(chainSlug)}${catalogMeta?.partial ? ` · ${catalogMeta.projectedCount.toLocaleString()} indexed so far` : ""}`}
          </p>
          <p className="truncate font-mono text-[0.62rem] text-foreground/40" title={collection.contractAddress}>
            {collection.contractAddress}
          </p>
            </div>
          </div>
        </div>
      </div>

      <dl className="flex gap-px overflow-x-auto rounded-xl border border-line bg-gold-500/20 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden sm:grid sm:grid-cols-7 sm:overflow-hidden">
        <div className="min-w-[7rem] flex-1 bg-panel px-3 py-2 text-center sm:min-w-0">
          <dt className="text-[0.6rem] font-bold uppercase tracking-wider text-foreground/45">Floor price</dt>
          <dd className="font-display text-base text-gold-300 tabular-nums sm:text-lg">
            {floorWei ? <>{formatTokenAmount(floorWei, 18, 4)} <span className="font-sans text-[0.58rem] font-black text-foreground/55">{floorCurrencySymbol}</span></> : "—"}
            {floorWei && floorUsd(floorWei) != null && <span className="block font-sans text-[0.68rem] font-semibold text-cream-muted/90">{formatUsdCompact(floorUsd(floorWei)!)}</span>}
          </dd>
        </div>
        <div className="min-w-[7rem] flex-1 bg-panel px-3 py-2 text-center sm:min-w-0">
          <dt className="text-[0.6rem] font-bold uppercase tracking-wider text-foreground/45">Items</dt>
          <dd className="font-display text-base text-gold-300 tabular-nums sm:text-lg">
            {supplyStats?.totalSupply != null
              ? supplyStats.totalSupply.toLocaleString()
              : catalogMeta
                ? `${catalogMeta.projectedCount.toLocaleString()}${catalogMeta.partial ? "+" : ""}`
                : "—"}
          </dd>
        </div>
        <div className="min-w-[7rem] flex-1 bg-panel px-3 py-2 text-center sm:min-w-0">
          <dt className="text-[0.6rem] font-bold uppercase tracking-wider text-foreground/45">Listed</dt>
          <dd className="font-display text-base text-gold-300 tabular-nums sm:text-lg">
            {supplyStats?.totalSupply != null
              ? `${(supplyStats.listedCount ?? listings.length).toLocaleString()} / ${supplyStats.totalSupply.toLocaleString()}`
              : (supplyStats?.listedCount ?? listings.length).toLocaleString()}
          </dd>
        </div>
        <div className="min-w-[7rem] flex-1 bg-panel px-3 py-2 text-center sm:min-w-0">
          <dt className="text-[0.6rem] font-bold uppercase tracking-wider text-foreground/45">Holders</dt>
          <dd className="font-display text-base text-gold-300 tabular-nums sm:text-lg">
            {supplyStats?.holderCount != null ? supplyStats.holderCount.toLocaleString() : "—"}
          </dd>
        </div>
        <div className="min-w-[7rem] flex-1 bg-panel px-3 py-2 text-center sm:min-w-0">
          <dt className="text-[0.6rem] font-bold uppercase tracking-wider text-foreground/45">Best offer</dt>
          <dd className="font-display text-base text-gold-300 tabular-nums sm:text-lg">
            {bestOfferWei ? formatTokenAmount(bestOfferWei, 18, 4) : "—"}
            {bestOfferWei && statUsd(bestOfferWei) != null && <span className="block font-sans text-[0.62rem] text-foreground/50">{formatUsdCompact(statUsd(bestOfferWei)!)}</span>}
          </dd>
        </div>
        <div className="min-w-[7rem] flex-1 bg-panel px-3 py-2 text-center sm:min-w-0">
          <dt className="text-[0.6rem] font-bold uppercase tracking-wider text-foreground/45">Volume</dt>
          <dd className="font-display text-base text-gold-300 tabular-nums sm:text-lg">
            {activityVolumeDisplay || (volumeWei ? <>{formatTokenAmount(volumeWei, 18, 3)} <span className="font-sans text-[0.58rem] font-black text-foreground/55">{statCurrencySymbol}</span></> : marketStats?.sales24h != null ? `${marketStats.sales24h} sales` : "—")}
            {activityVolumeUsd != null ? <span className="block font-sans text-[0.68rem] font-semibold text-cream-muted/90">{formatUsdCompact(activityVolumeUsd)}</span> : volumeWei && statUsd(volumeWei) != null ? <span className="block font-sans text-[0.68rem] font-semibold text-cream-muted/90">{formatUsdCompact(statUsd(volumeWei)!)}</span> : null}
          </dd>
        </div>
        <div className="min-w-[7rem] flex-1 bg-panel px-3 py-2 text-center sm:min-w-0">
          <dt className="text-[0.6rem] font-bold uppercase tracking-wider text-foreground/45">Highest sale</dt>
          <dd className="font-display text-base text-gold-300 tabular-nums sm:text-lg">
            {highestSale ? <>{highestSale.priceAmount} <span className="font-sans text-[0.58rem] font-black text-foreground/55">{highestSale.priceSymbol}</span></> : "—"}
            {highestSale?.priceUsd != null && <span className="block font-sans text-[0.62rem] text-foreground/50">{formatUsdCompact(highestSale.priceUsd)}</span>}
          </dd>
        </div>
      </dl>
      {supplyStats?.holderCount != null && (
        <p className="text-[0.65rem] text-foreground/45">
          Unique holders {supplyStats.holderCount.toLocaleString()}
          {supplyStats.totalSupply != null && supplyStats.totalSupply > 0
            ? ` · ${((supplyStats.holderCount / supplyStats.totalSupply) * 100).toFixed(1)}% of supply`
            : ""}
        </p>
      )}

      {/*
       * Real 24h/7d/30d volume/sales, distinct from the "Volume" stat above
       * (which is aggregated on the fly from whatever activity page happens
       * to be loaded -- see that stat's own header comment). This strip is
       * OpenSea's own indexed multi-window figures (rarity-index-runner.ts),
       * EVM-only: Solana/Bitcoin/Robinhood-native collections show "—" for
       * every window here rather than a fabricated number, because neither
       * Magic Eden's nor UniSat's API exposes row-level sale history to sum
       * a real window from. Same "24h | 7d | 30d" button-group styling as
       * GlobalMarketHub.tsx's rankings-table window toggle.
       */}
      {marketStats &&
        (marketStats.volume24hWei != null ||
          marketStats.volume7dWei != null ||
          marketStats.volume30dWei != null ||
          marketStats.sales24h != null ||
          marketStats.sales7d != null ||
          marketStats.sales30d != null) && (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-line bg-panel px-3 py-2 text-xs">
          <div className="flex items-center gap-1.5">
            {(["24h", "7d", "30d"] as const).map((w) => (
              <button
                key={w}
                type="button"
                onClick={() => setMarketStatsWindow(w)}
                aria-pressed={marketStatsWindow === w}
                className={`min-h-8 rounded-md border px-2.5 font-bold transition-colors duration-150 ${
                  marketStatsWindow === w
                    ? "border-gold-400 bg-gold-400/15 text-gold-300"
                    : "border-line text-foreground/50 hover:border-line-strong hover:text-foreground/70"
                }`}
              >
                {w}
              </button>
            ))}
          </div>
          {(() => {
            const vol = marketStatsWindow === "7d" ? marketStats.volume7dWei : marketStatsWindow === "30d" ? marketStats.volume30dWei : marketStats.volume24hWei;
            const sales = marketStatsWindow === "7d" ? marketStats.sales7d : marketStatsWindow === "30d" ? marketStats.sales30d : marketStats.sales24h;
            return (
              <span className="font-mono tabular-nums text-foreground/70">
                {vol ? `${formatTokenAmount(vol, 18, 3)} ${statCurrencySymbol}` : "—"}
                {sales != null ? ` · ${sales} sales` : ""}
              </span>
            );
          })()}
        </div>
      )}

      <MarketTabRail
        navigation={
          <MarketNav
            active={tab}
            onChange={setTab}
            tabs={tabs}
            counts={{
              "buy-sell": listings.length,
              offers: offers.length,
              "my-nfts": ownedItems.length,
              positions: myListings.length,
            }}
          />
        }
      />

      {error && (
        <p role="alert" className="rounded-lg border border-red-500/35 bg-red-950/25 px-3 py-2.5 text-sm text-red-100">
          {error}
        </p>
      )}

      <MarketTabPanel id="buy-sell" active={tab === "buy-sell"}>
        <MarketBrowseLayout
          summary={
            bookFilter === "listed"
              ? `${filteredListings.length} on the market`
              : catalogMeta && catalogMeta.projectedCount > browseItems.length
                ? `${browseItems.length.toLocaleString()} loaded · ${catalogMeta.projectedCount.toLocaleString()} indexed${catalogMeta.partial ? " and syncing" : ""}`
                : `${browseItems.length.toLocaleString()} items${catalogMeta?.partial ? " · syncing" : ""}`
          }
          lead={
            listings.length > 0 ? (
              <>
              {rarityMap.size > 0 && raritySample && (
                <p className="px-0.5 text-[0.58rem] text-foreground/40">
                  Information-content rarity on {raritySample.size.toLocaleString()} indexed pieces
                  {raritySample.partial ? " · sample (ranks improve as indexing continues)" : ""}
                </p>
              )}
              <RarityFloorStrip
                listings={listings}
                rarity={rarityMap}
                activeTier={activeTier}
                onSelectTier={(t) => {
                  setActiveTier(t);
                  setActiveTiers(t === "all" ? [] : [t]);
                }}
                currencySymbol={statCurrencySymbol}
                chainSlug={chainSlug}
                usdValueFor={(wei) => toUsd(wei == null ? null : wei.toString(), statCurrencySymbol)}
                listedTotal={supplyStats?.listedCount ?? null}
                catalogCounts={countTiers(rarityMap)}
              />
              </>
            ) : undefined
          }
          filters={
            <div className="space-y-3">
              <div className="mb-3">
                <p className="mb-1 text-[0.55rem] font-black uppercase tracking-wide text-foreground/45">Show</p>
                <div className="flex flex-wrap gap-1.5">
                  {(["all", "listed"] as const).map((mode) => (
                    <button
                      key={mode}
                      type="button"
                      onClick={() => setBookFilter(mode)}
                      aria-pressed={bookFilter === mode}
                      className={`min-h-8 rounded-md border px-2.5 text-xs font-bold ${
                        bookFilter === mode ? "border-gold-400 bg-gold-400/15 text-gold-300" : "border-line text-foreground/55 hover:text-gold-300"
                      }`}
                    >
                      {mode === "all" ? "All items" : "Listed only"}
                    </button>
                  ))}
                </div>
              </div>
              <FilterBar
                filters={{ query: searchQuery, minEth: minPriceEth, maxEth: maxPriceEth, tier: activeTier, tiers: activeTiers }}
                onChange={(next: MarketFilters) => {
                  setSearchQuery(next.query);
                  setMinPriceEth(next.minEth);
                  setMaxPriceEth(next.maxEth);
                  setActiveTier(next.tier);
                  setActiveTiers(next.tiers ?? []);
                }}
                onClearAll={() => {
                  setSearchQuery("");
                  setMinPriceEth("");
                  setMaxPriceEth("");
                  setSelectedTraits({});
                  setActiveTier("all");
                  setActiveTiers([]);
                }}
                additionalDirty={Object.values(selectedTraits).some(Boolean)}
                resultCount={bookFilter === "listed" ? filteredListings.length : browseItems.length}
                rarityAvailable={rarityMap.size > 0}
                orientation="sidebar"
                tierCounts={Object.fromEntries(
                  TIER_ORDER.map((tier) => [
                    tier,
                    bookFilter === "listed"
                      ? listings.filter((l) => rarityFor(l.tokenId)?.tier === tier).length
                      : countTiers(rarityMap)[tier] ?? 0,
                  ])
                )}
                searchLabel="Find a token"
                searchPlaceholder="Token ID"
                priceLegend={`Price in ${statCurrencySymbol}`}
              />

              {/* Trait values are directly inspectable like rarity tiers.
                  One value per category, AND across categories: this preserves
                  the resolver's real criteria semantics without implying an
                  unsupported OR query. Collapsible groups keep a 248px rail
                  dense while every value remains keyboard/touch accessible. */}
              {traitCounts && Object.keys(traitCounts).length > 0 && (
                <fieldset>
                  <legend className="mb-2 text-[0.62rem] font-black uppercase tracking-wider text-gold-300">
                    Traits
                  </legend>
                  {Object.keys(selectedTraits).length > 0 && (
                    <div className="mb-2 flex flex-wrap gap-1" aria-label="Active trait filters">
                      {Object.entries(selectedTraits).filter(([, value]) => value).map(([traitType, value]) => (
                        <button
                          key={traitType}
                          type="button"
                          onClick={() => setSelectedTraits((prev) => ({ ...prev, [traitType]: "" }))}
                          className="min-h-9 max-w-full rounded-full border border-gold-500/40 bg-gold-500/10 px-2 text-[0.62rem] font-bold text-gold-300"
                          aria-label={`Remove ${traitType}: ${value}`}
                        >
                          <span className="block max-w-[11rem] truncate">{traitType}: {value} ×</span>
                        </button>
                      ))}
                    </div>
                  )}
                  <div className="space-y-1.5">
                    {Object.entries(traitCounts)
                      .sort(([a], [b]) => a.localeCompare(b))
                      .map(([traitType, values], index) => {
                        const selected = selectedTraits[traitType] ?? "";
                        const sortedValues = Object.entries(values).sort(([, ca], [, cb]) => cb - ca);
                        return (
                          <details
                            key={traitType}
                            open={openTraitGroups[traitType] ?? (index === 0 || Boolean(selected))}
                            onToggle={(event) => {
                              const open = event.currentTarget.open;
                              setOpenTraitGroups((prev) => prev[traitType] === open ? prev : { ...prev, [traitType]: open });
                            }}
                            className="rounded-md border border-line bg-wood-950/60"
                          >
                            <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 px-2 text-xs font-bold text-foreground marker:hidden">
                              <span className="min-w-0 flex-1 truncate">{traitType}</span>
                              {selected && <span className="max-w-20 truncate text-gold-300">{selected}</span>}
                              <span className="rounded-full bg-foreground/10 px-1.5 py-0.5 text-[0.58rem] tabular-nums text-foreground/55">{sortedValues.length}</span>
                              <span aria-hidden="true" className="text-foreground/45">⌄</span>
                            </summary>
                            <div className="max-h-52 overflow-y-auto border-t border-line p-1">
                              {sortedValues.map(([value, count]) => (
                                <label key={value} title={`${traitType}: ${value} · ${count.toLocaleString()} items`} className="flex min-h-9 cursor-pointer items-center gap-2 rounded-md px-2 text-xs text-foreground/75 hover:bg-gold-500/10">
                                  <input
                                    type="checkbox"
                                    checked={selected === value}
                                    onChange={() => setSelectedTraits((prev) => ({ ...prev, [traitType]: selected === value ? "" : value }))}
                                    className="accent-gold-500"
                                  />
                                  <span className="min-w-0 flex-1 truncate">{value}</span>
                                  <span className="rounded-full bg-foreground/10 px-1.5 py-0.5 text-[0.58rem] tabular-nums text-foreground/55">{count}</span>
                                </label>
                              ))}
                            </div>
                          </details>
                        );
                      })}
                  </div>
                </fieldset>
              )}
              {(!traitCounts || Object.keys(traitCounts).length === 0) && (
                <fieldset>
                  <legend className="mb-2 text-[0.62rem] font-black uppercase tracking-wider text-gold-300">Traits</legend>
                  <p className="rounded-md border border-line bg-wood-950/60 px-2.5 py-2 text-[0.65rem] leading-relaxed text-foreground/50" role="status">
                    {!traitIndex || traitIndex.building || !traitIndex.complete
                      ? `Indexing verified traits${traitIndex?.scanned ? ` · ${traitIndex.scanned.toLocaleString()}${traitIndex.totalSupply ? ` / ${traitIndex.totalSupply.toLocaleString()}` : ""}` : ""}…`
                      : "No verified trait metadata is available for this collection yet."}
                  </p>
                </fieldset>
              )}

              {filtersActive && (
                <button
                  type="button"
                  onClick={() => {
                    setSearchQuery("");
                    setMinPriceEth("");
                    setMaxPriceEth("");
                    setSelectedTraits({});
                    setActiveTier("all");
                    setActiveTiers([]);
                    setListingSort("price-asc");
                    setBookFilter("listed");
                  }}
                  className="min-h-10 w-full rounded-md border border-line px-3 text-xs font-bold text-foreground/60 hover:border-gold-400 hover:text-gold-300"
                >
                  Clear filters
                </button>
              )}
            </div>
          }
          toolbar={
            <>
              <button
                type="button"
                onClick={() => setBrowseMode((mode) => mode === "art" ? "intelligence" : "art")}
                aria-pressed={browseMode === "intelligence"}
                className={`min-h-10 shrink-0 rounded-lg border px-3 text-xs font-bold transition ${
                  browseMode === "intelligence" ? "border-purple-400 bg-purple-500/15 text-purple-200" : "border-line-strong text-gold-300 hover:border-gold-400"
                }`}
              >
                {browseMode === "intelligence" ? "Art & listings" : "Intelligence"}
              </button>
              <button
                type="button"
                onClick={() => setSweepOpen((v) => !v)}
                aria-pressed={sweepOpen}
                className={`min-h-10 shrink-0 rounded-lg border px-3 text-xs font-bold transition ${
                  sweepOpen ? "border-gold-400 bg-gold-500/15 text-gold-200" : "border-line-strong text-gold-300 hover:border-gold-400"
                }`}
              >
                Sweep floorboards
              </button>
              {!isNonEvm && (
                <button
                  type="button"
                  onClick={() => setCriteriaOpen((v) => !v)}
                  aria-pressed={criteriaOpen}
                  className={`min-h-10 shrink-0 rounded-lg border px-3 text-xs font-bold transition ${
                    criteriaOpen ? "border-gold-400 bg-gold-500/15 text-gold-200" : "border-line-strong text-gold-300 hover:border-gold-400"
                  }`}
                >
                  Bid by criteria
                </button>
              )}
              <label className="flex items-center gap-1.5">
                <span className="sr-only">Sort listings</span>
                <select
                  value={listingSort}
                  onChange={(e) => setListingSort(e.target.value as ListingSort)}
                  className="min-h-10 max-w-[12rem] rounded-md border border-line bg-wood-950 px-2 text-xs text-foreground"
                >
                  <option value="default">Token ID</option>
                  <option value="price-asc">Price: low to high</option>
                  <option value="price-desc">Price: high to low</option>
                  {rarityMap.size > 0 && <option value="rarity-asc">Rarest first</option>}
                  {rarityMap.size > 0 && <option value="rarity-desc">Common first</option>}
                </select>
              </label>
            </>
          }
        >
          {browseMode === "intelligence" ? (
            <CollectionIntelligence
              name={collection?.name ?? collectionSlug}
              chain={chainDisplayName(chainSlug)}
              supply={supplyStats?.totalSupply ?? null}
              holders={supplyStats?.holderCount ?? null}
              indexed={catalogMeta?.projectedCount ?? tokens.length}
              rarityCovered={rarityMap.size}
              rarityTiers={countTiers(rarityMap)}
              listings={listings.map((listing) => ({
                priceWei: listing.priceWei,
                maker: listing.maker,
                tokenId: listing.tokenId,
              }))}
              sales={saleEvents}
            />
          ) : (
          <>
          {criteriaOpen && !isNonEvm && collection && (
            <div className="mb-3">
              {isForeignEvm && bidVenue === "native" ? (
                <NativeForeignOfferForm
                  chainSlug={chainSlug}
                  currencySymbol={statCurrencySymbol}
                  account={account}
                  collection={collection}
                  listings={listings}
                  onSubmitted={() => {
                    invalidateSwr("/api/market/multichain/offers");
                    void loadOffers();
                    setCriteriaOpen(false);
                  }}
                  onConnect={() => void requireAccount()}
                />
              ) : (
                <ForeignOfferForm
                  chainSlug={chainSlug}
                  currencySymbol={statCurrencySymbol}
                  account={account}
                  collection={collection}
                  listings={listings}
                  onSubmitted={() => {
                    invalidateSwr("/api/market/multichain/offers");
                    void loadOffers();
                    setCriteriaOpen(false);
                  }}
                  onConnect={() => void requireAccount()}
                />
              )}
            </div>
          )}
          {sweepOpen && (
            <div className="mb-3 rounded-xl border border-line bg-wood-900/80 p-3">
              <div className="mb-2 flex flex-wrap items-center gap-1.5">
                <span className="text-[0.62rem] font-black uppercase tracking-wider text-foreground/50">Sweep</span>
                {(
                  [
                    { id: "floor" as const, label: "All" },
                    { id: "tier" as const, label: "Rarity" },
                    { id: "trait" as const, label: "Trait / combo" },
                  ] as const
                ).map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    onClick={() => setSweepScope(m.id)}
                    aria-pressed={sweepScope === m.id}
                    className={`min-h-8 rounded-md border px-2 text-[0.65rem] font-bold ${
                      sweepScope === m.id ? "border-gold-400 bg-gold-500/15 text-gold-300" : "border-line text-foreground/55"
                    }`}
                  >
                    {m.label}
                  </button>
                ))}
                <span className="text-[0.58rem] text-foreground/40">
                  {filteredListings.filter((l) => isCrossChainBuyable(l)).length} listed · max {SWEEP_MAX}
                  {sweepScope === "trait" && sweepClauses.length > 0 ? ` · ${formatCriteriaLabel(sweepClauses)}` : ""}
                </span>
              </div>
              {sweepScope === "trait" && (
                <div className="mb-2 rounded-md border border-line bg-panel p-2">
                  <TraitCriteriaPicker
                    traits={traitIndex?.traits ?? null}
                    rankings={traitIndex?.rankings}
                    complete={Boolean(traitIndex?.complete && traitIndex.traits)}
                    clauses={sweepClauses}
                    onChange={setSweepClauses}
                  />
                </div>
              )}
              <div className="flex flex-wrap items-center gap-1.5">
                {SWEEP_SIZE_OPTIONS.map((n) => (
                  <button
                    key={n}
                    type="button"
                    onClick={() => {
                      setSweepCount(n);
                      setSweepCustom("");
                    }}
                    className={`min-h-8 rounded-md border px-2.5 text-xs font-bold ${
                      sweepCount === n && !sweepCustom ? "border-gold-400 bg-gold-400/15 text-gold-300" : "border-line text-foreground/60"
                    }`}
                  >
                    {n}
                  </button>
                ))}
                <input
                  type="number"
                  min={1}
                  max={SWEEP_MAX}
                  value={sweepCustom}
                  onChange={(e) => {
                    setSweepCustom(e.target.value);
                    const n = Number(e.target.value);
                    if (Number.isFinite(n) && n >= 1) setSweepCount(Math.min(SWEEP_MAX, Math.floor(n)));
                  }}
                  placeholder="N"
                  className="min-h-8 w-14 rounded-md border border-line bg-panel px-2 text-xs"
                />
                <button
                  type="button"
                  onClick={() => void openSweepPreview()}
                  disabled={buyableCount === 0}
                  className="min-h-8 rounded-lg border border-line-strong bg-gold-500 px-3 text-xs font-bold text-wood-950 hover:bg-gold-400 disabled:opacity-40"
                >
                  Sweep {sweepCount} {sweepScope === "floor" ? "floor" : sweepScope === "tier" ? activeTier : "by traits"}
                </button>
              </div>
            </div>
          )}
          {browseItems.length === 0 ? (
            <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-line bg-panel-strong px-4 py-10 text-center">
              <PackageOpen size={28} strokeWidth={1.75} className="text-gold-400/70" aria-hidden />
              <p className="text-sm font-bold text-foreground/75">
                {catalogBuilding ? "Preparing this collection’s pieces…" : filtersActive ? "No items match your search." : bookFilter === "listed" ? "No live listings in this page." : "No items loaded for this collection yet."}
              </p>
              <p className="text-xs text-foreground/45">
                {catalogBuilding ? "The live indexer is prioritizing this exact contract. This page will update automatically." : filtersActive ? "Try widening your price range or clearing a filter." : "Identity and tools stay on this page. Instant Swap vaults for foreign collections come later."}
              </p>
            </div>
          ) : (
            <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
              {browseItems.map((item) => {
                const pieceRarity = rarityFor(item.tokenId);
                return item.listing ? (
                <ListingCard
                  key={item.listing.id}
                  listing={item.listing}
                  collection={collection}
                  onBuy={(l) => void handleBuy(l)}
                  onOffer={foreignOfferCurrency(chainSlug) || isSolana ? (l) => void openOffer(l) : undefined}
                  onSelect={(tokenId) => void openDetails(tokenId)}
                  rarity={pieceRarity}
                  currencySymbol={statCurrencySymbol}
                  chainSlug={chainSlug}
                  usdValue={statUsd(item.listing.priceWei)}
                  isFloor={Boolean(floorWei) && item.listing.priceWei === floorWei}
                />
                ) : (
                  <li
                    key={item.tokenId}
                    className={`overflow-hidden rounded-lg border bg-panel ${pieceRarity ? tierAnimationClass(pieceRarity.tier) : "border-line"}`}
                    style={pieceRarity ? { ...tierCardStyle(pieceRarity.tier), boxShadow: tierGlow(pieceRarity.tier) } : undefined}
                  >
                    <div className="relative aspect-square bg-wood-900">
                      <CollectionArtImage
                        src={item.imageUrl}
                        extras={catalogArtExtras(chainSlug, collection?.contractAddress || collectionSlug, item.tokenId)}
                        alt=""
                        width={512}
                        variant="tile"
                      />
                      {pieceRarity && (
                        <span
                          className="tier-badge absolute left-2 top-2 rounded-full px-2 py-1 text-[0.55rem] font-black uppercase tracking-wide"
                          style={{ color: tierColor(pieceRarity.tier) }}
                        >
                          {pieceRarity.tier}
                        </span>
                      )}
                    </div>
                    <div className="space-y-1 p-2">
                      <p className="truncate text-xs font-bold text-foreground">{item.name ?? `#${item.tokenId.slice(0, 8)}`}</p>
                      <p className="text-[0.6rem] uppercase tracking-wide text-foreground/40">Unlisted</p>
                      <div className="flex gap-1">
                        <button
                          type="button"
                          onClick={() => void openDetails(item.tokenId)}
                          className="min-h-8 flex-1 rounded-md border border-line px-2 text-[0.65rem] font-bold text-foreground/70 hover:border-gold-400 hover:text-gold-300"
                        >
                          Details
                        </button>
                        {(foreignOfferCurrency(chainSlug) || isSolana) && (
                          <button
                            type="button"
                          onClick={() => void openOffer(browseAsListing(item.tokenId, item.imageUrl, item.name,
                            item.animationUrl, item.mediaType))}
                            className="min-h-8 flex-1 rounded-md border border-line px-2 text-[0.65rem] font-bold text-foreground/70 hover:border-gold-400 hover:text-gold-300"
                          >
                            Offer
                          </button>
                        )}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
          {bookFilter === "all" && tokenLimit < surface.catalogCap && tokens.length >= Math.min(tokenLimit, surface.catalogCap) && (
            <div className="mt-3 flex justify-center">
              <button
                type="button"
                onClick={() => setTokenLimit((n) => Math.min(surface.catalogCap, n + surface.catalogPageSize))}
                className="min-h-10 rounded-md border border-gold-400/50 px-4 text-xs font-bold text-gold-300 hover:bg-gold-400/10"
              >
                Load more
                {catalogMeta?.projectedCount ? ` · ${tokens.length.toLocaleString()} of ${catalogMeta.projectedCount.toLocaleString()} indexed shown` : ""}
              </button>
            </div>
          )}
          </>
          )}
        </MarketBrowseLayout>

        {/* Open swaps touching this collection -- see loadSwaps on why the
            fetch is per-chain and the filter is client-side. */}
        {isForeignEvm && !swapsLoading && relevantSwaps.length > 0 && (
          <div className="mt-6 space-y-2">
            <h3 className="font-display text-xl text-gold-300">Open swaps</h3>
            <p className="text-xs text-foreground/55">
              Trade your items directly for theirs. One signature, settled atomically.
            </p>
            {swapError && (
              <p className="text-center text-xs text-red-300" role="alert">
                {swapError}
              </p>
            )}
            <ul className="space-y-2">
              {relevantSwaps.map((s) => {
                const isMine = account?.toLowerCase() === s.maker.toLowerCase();
                const topUp = BigInt(s.considerationNativeWei || "0");
                return (
                  <li key={s.id} className="rounded-lg border border-line bg-panel p-3">
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                      <span className="text-foreground/80">
                        <span className="font-bold text-gold-300">Gives</span>{" "}
                        {s.offerItems.map((i) => `#${i.tokenId}`).join(", ")}
                      </span>
                      <span className="text-foreground/40">→</span>
                      <span className="text-foreground/80">
                        <span className="font-bold text-gold-300">Wants</span>{" "}
                        {s.considerationItems.map((i) => `#${i.tokenId}`).join(", ")}
                        {topUp > 0n && ` + ${formatTokenAmount(topUp.toString(), 18, 4)} ${statCurrencySymbol}`}
                      </span>
                    </div>
                    <div className="mt-2 flex items-center justify-between gap-2">
                      <span className="truncate text-[0.65rem] text-foreground/40">
                        by {s.maker.slice(0, 6)}…{s.maker.slice(-4)}
                      </span>
                      <button
                        type="button"
                        disabled={isMine || swapAccepting === s.id}
                        onClick={() => void confirmAcceptSwap(s.id)}
                        title={isMine ? "This is your own swap" : undefined}
                        className="min-h-9 shrink-0 rounded-md bg-gold-500 px-3 text-xs font-bold text-wood-950 transition hover:bg-gold-400 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {swapAccepting === s.id ? "Confirming…" : isMine ? "Your swap" : "Accept swap"}
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        {isForeignEvm && bundles.length > 0 && (
          <div className="mt-6 space-y-2">
            <h3 className="font-display text-xl text-gold-300">Bundles for sale</h3>
            <p className="text-xs text-foreground/55">Multiple items, one price, one transaction -- direct with Marketplank.</p>
            {bundleError && (
              <p role="alert" className="rounded-lg border border-red-500/35 bg-red-950/25 px-3 py-2.5 text-sm text-red-100">
                {bundleError}
              </p>
            )}
            {bundlesLoading ? (
              <SkeletonRows rows={2} columns={["w-32", "w-24", "w-16"]} />
            ) : (
              <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {bundles.map((b) => (
                  <li key={b.id} className="dense-card space-y-2 p-3">
                    <p className="text-sm font-bold text-foreground">{b.tokenIds.length} items</p>
                    <p className="truncate text-xs text-foreground/55" title={b.tokenIds.map((id) => `#${id}`).join(", ")}>
                      {b.tokenIds.slice(0, 6).map((id) => `#${id}`).join(", ")}
                      {b.tokenIds.length > 6 ? `, +${b.tokenIds.length - 6} more` : ""}
                    </p>
                    <p className="text-sm font-extrabold tabular-nums text-emerald-300">
                      {formatTokenAmount(b.priceWei, 18, 4)} {statCurrencySymbol}
                      {statUsd(b.priceWei) != null && <span className="ml-1 text-[0.65rem] font-normal text-foreground/40">{formatUsdCompact(statUsd(b.priceWei)!)}</span>}
                    </p>
                    <p className="text-[0.65rem] text-foreground/50">by {shortAddress(b.maker)}</p>
                    <button
                      type="button"
                      disabled={bundleBuying === b.id || b.maker.toLowerCase() === account?.toLowerCase()}
                      onClick={() => void confirmBuyBundle(b.id)}
                      className="min-h-9 w-full rounded-md bg-gold-500 text-xs font-bold text-wood-950 hover:bg-gold-400 disabled:opacity-50"
                    >
                      {bundleBuying === b.id
                        ? "Confirm…"
                        : b.maker.toLowerCase() === account?.toLowerCase()
                          ? "Your bundle"
                          : "Buy bundle"}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </MarketTabPanel>

      <MarketTabPanel id="swap" active={tab === "swap"}>
        <ForeignSwapComingSoon collectionName={collection.name} />
      </MarketTabPanel>

      <MarketTabPanel id="offers" active={tab === "offers"}>
        <div className="space-y-3">
          {acceptError && (
            <p role="alert" className="rounded-lg border border-red-500/35 bg-red-950/25 px-3 py-2.5 text-sm text-red-100">
              {acceptError}
            </p>
          )}
          {/* Same grid shape as native's Offers tab: sticky criteria-bid builder in a fixed left column, everything else in the flexible right column. */}
          <div className="grid items-start gap-3 lg:grid-cols-[360px_minmax(0,1fr)]">
            <div className="lg:sticky lg:top-[8.75rem]">
              {isNonEvm ? (
                // No Seaport-equivalent offer/bid-placement flow is wired for
                // either venue in this pass -- see offers/route.ts's own
                // comment on why even VIEWING collection-wide bids isn't
                // available yet for Solana/Bitcoin. Honest unavailable state,
                // matching the same "Browse only" posture GlobalMarketHub.tsx
                // already uses for tradeable:false Solana rows.
                <p className="rounded-lg border border-line bg-panel p-3 text-xs text-foreground/55">
                  Making offers isn't available for {chainDisplayName(chainSlug)} yet.
                </p>
              ) : (
                <div className="space-y-2">
                  {isForeignEvm && (
                    <div className="flex gap-1.5" role="radiogroup" aria-label="Bid venue">
                      {(
                        [
                          { id: "native" as const, label: "Marketplank (direct)" },
                          { id: "opensea" as const, label: "OpenSea" },
                        ] as const
                      ).map((v) => (
                        <button
                          key={v.id}
                          type="button"
                          role="radio"
                          aria-checked={bidVenue === v.id}
                          onClick={() => setBidVenue(v.id)}
                          className={`min-h-9 flex-1 rounded-md border px-2.5 text-xs font-bold transition ${
                            bidVenue === v.id ? "border-gold-400 bg-gold-500/15 text-gold-300" : "border-line text-foreground/60 hover:border-gold-400"
                          }`}
                        >
                          {v.label}
                        </button>
                      ))}
                    </div>
                  )}
                  {isForeignEvm && bidVenue === "native" ? (
                    <NativeForeignOfferForm
                      chainSlug={chainSlug}
                      currencySymbol={nativeCurrencySymbol(chainSlug, isSolana, isBitcoin)}
                      account={account}
                      collection={collection}
                      listings={listings}
                      onSubmitted={() => {
                        invalidateSwr("/api/market/multichain/offers");
                        void loadOffers();
                      }}
                      onConnect={() => void requireAccount()}
                    />
                  ) : (
                    <ForeignOfferForm
                      chainSlug={chainSlug}
                      currencySymbol={nativeCurrencySymbol(chainSlug, isSolana, isBitcoin)}
                      account={account}
                      collection={collection}
                      listings={listings}
                      onSubmitted={() => {
                        invalidateSwr("/api/market/multichain/offers");
                        void loadOffers();
                      }}
                      onConnect={() => void requireAccount()}
                    />
                  )}
                </div>
              )}
            </div>
            <div className="min-w-0 space-y-3">
              <section aria-labelledby="mc-open-bids">
                <div className="mb-2 flex items-end justify-between gap-3">
                  <div>
                    <h3 id="mc-open-bids" className="font-display text-xl text-gold-300">
                      Open criteria bids
                    </h3>
                    <p className="text-xs text-foreground/55">
                      Rarity, trait, and combo orders. Marketplank-native bids are acceptable directly if you own a
                      qualifying item; OpenSea-sourced ones stay view-only (see Offer form's own note on why).
                    </p>
                  </div>
                  {collectionWideOffers.length > 0 && (
                    <span className="rounded-full border border-line px-2 py-1 text-[0.65rem] text-gold-300">{collectionWideOffers.length} active</span>
                  )}
                </div>
                {offersLoading ? (
                  <SkeletonRows rows={3} columns={["w-24", "w-32", "w-16"]} />
                ) : collectionWideOffers.length === 0 ? (
                  <div className="flex items-center gap-2 rounded-lg border border-dashed border-line bg-panel-strong px-4 py-6">
                    <Tag size={18} strokeWidth={1.75} className="shrink-0 text-gold-400/60" aria-hidden />
                    <p className="text-xs text-foreground/50">No open criteria bids right now.</p>
                  </div>
                ) : (
                  <ul className="space-y-2">
                    {collectionWideOffers.map((o) => {
                      const canAcceptHere =
                        (o.native &&
                          !o.tokenId &&
                          Boolean(o.criteriaTokenIds?.length) &&
                          ownedTokenIds.some((id) => o.criteriaTokenIds!.map((c) => BigInt(c).toString()).includes(BigInt(id).toString()))) ||
                        (Boolean(o.isWildcard) && o.acceptable && ownedTokenIds.length > 0);
                      return (
                        <li key={o.orderHash} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line bg-panel px-3 py-2">
                          <div className="min-w-0">
                            <p
                              className="truncate text-sm font-bold text-foreground"
                              title={o.isWildcard ? `Any ${collection.name} token` : "Trait-scoped bid"}
                            >
                              {o.isWildcard ? `Any ${collection.name} token` : "Trait-scoped bid"}
                              {o.native && <span className="ml-1.5 rounded-full border border-gold-400/40 px-1.5 py-0.5 text-[0.55rem] font-black uppercase text-gold-300">Marketplank</span>}
                            </p>
                            <p className="text-xs text-foreground/60">by {shortAddress(o.maker)}</p>
                          </div>
                          <div className="flex shrink-0 items-center gap-2">
                            <p className="whitespace-nowrap text-sm font-extrabold tabular-nums text-emerald-300">
                              {formatTokenAmount(o.priceWei, 18, 4)} {statCurrencySymbol}
                              {statUsd(o.priceWei) != null && <span className="ml-1 text-[0.65rem] font-normal text-foreground/40">{formatUsdCompact(statUsd(o.priceWei)!)}</span>}
                            </p>
                            {canAcceptHere && (
                              <button
                                type="button"
                                disabled={acceptingOrderHash === o.orderHash}
                                onClick={() => void handleAcceptOffer(o)}
                                className="min-h-8 rounded-md bg-gold-500 px-2.5 text-xs font-bold text-wood-950 hover:bg-gold-400 disabled:opacity-50"
                              >
                                {acceptingOrderHash === o.orderHash ? "Confirm…" : "Accept"}
                              </button>
                            )}
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </section>

              <section aria-labelledby="mc-single-token-offers">
                <div className="mb-2">
                  <h3 id="mc-single-token-offers" className="font-display text-xl text-gold-300">
                    Single-token offers
                  </h3>
                  <p className="text-xs text-foreground/55">Offers tied to one exact token ID.</p>
                </div>
                {offersLoading ? (
                  <SkeletonCardGrid count={4} columns="grid-cols-2 sm:grid-cols-3 lg:grid-cols-4" action />
                ) : tokenOffers.length === 0 ? (
                  <div className="flex items-center gap-2 rounded-lg border border-dashed border-line bg-panel-strong px-4 py-6">
                    <Tag size={18} strokeWidth={1.75} className="shrink-0 text-gold-400/60" aria-hidden />
                    <p className="text-xs text-foreground/50">No single-token offers right now.</p>
                  </div>
                ) : (
                  <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
                    {tokenOffers.map((o) => (
                      <ListingCard
                        key={o.orderHash}
                        listing={{
                          id: o.orderHash,
                          collectionSlug,
                          tokenId: o.tokenId!,
                          maker: o.maker,
                          priceWei: o.priceWei,
                          expiresAt: o.expiresAt,
                          kind: "fixed",
                          imageUrl: o.imageUrl ?? undefined,
                          // Absence of venue means "ours" (see Listing.venue's
                          // own doc comment) -- a native offer isn't an
                          // OpenSea order and must not be badged as one.
                          ...(o.native ? {} : { venue: "opensea" as const }),
                        }}
                        collection={collection}
                        variant="offer"
                        buyLabel={acceptingOrderHash === o.orderHash ? "Confirm…" : "Accept"}
                        canFill={acceptingOrderHash !== o.orderHash}
                        onBuy={() => void handleAcceptOffer(o)}
                        rarity={rarityFor(o.tokenId!)}
                        currencySymbol={statCurrencySymbol}
                        chainSlug={chainSlug}
                        usdValue={statUsd(o.priceWei)}
                      />
                    ))}
                  </ul>
                )}
              </section>
            </div>
          </div>
        </div>
      </MarketTabPanel>

      <MarketTabPanel id="activity" active={tab === "activity"}>
        <ForeignActivityFeed events={activity} loading={activityLoading} chainSlug={chainSlug} rarity={rarityMap} onSelectToken={(tokenId) => void openDetails(tokenId)} />
      </MarketTabPanel>

      <MarketTabPanel id="my-nfts" active={tab === "my-nfts"}>
        {!account ? (
          <p className="p-6 text-center text-foreground/45">Connect a wallet to see what you own in this collection.</p>
        ) : (
          // Bottom padding grows with the selection, same reason MyNfts.tsx's
          // own comment gives: a sticky action bar over the grid's tail rows
          // makes them unclickable otherwise -- confirmed live there, not
          // a hypothetical.
          <div className={`space-y-3 ${selectedForSend.size > 0 ? "pb-64 sm:pb-4" : "pb-4"}`}>
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div>
                <h3 className="font-display text-xl text-gold-300">Your {collection.name}</h3>
                <p className="text-xs text-foreground/55">
                  {ownedTokenIds.length} owned · {selectedForSend.size} selected on {chainDisplayName(chainSlug)}
                </p>
              </div>
            </div>
            {ownedLoading ? (
              <SkeletonCardGrid count={6} columns="grid-cols-[repeat(auto-fill,minmax(140px,1fr))]" />
            ) : ownedTokenIds.length === 0 ? (
              <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-line bg-panel-strong px-4 py-10 text-center">
                <PackageOpen size={28} strokeWidth={1.75} className="text-gold-400/70" aria-hidden />
                <p className="text-sm font-bold text-foreground/75">
                  You don't own any {collection.name} on {chainDisplayName(chainSlug)}.
                </p>
              </div>
            ) : (
              <ul className="grid grid-cols-[repeat(auto-fill,minmax(140px,1fr))] gap-2">
                {ownedItems.map((item) => {
                  const isSelected = selectedForSend.has(item.tokenId);
                  const r = rarityFor(item.tokenId);
                  return (
                    <li
                      key={item.tokenId}
                      className={`dense-card relative flex flex-col overflow-hidden p-0 transition-[transform,border-color] duration-150 hover:-translate-y-0.5 ${
                        isSelected ? "ring-2 ring-gold-400" : ""
                      } ${r ? tierAnimationClass(r.tier) : ""}`}
                      style={r ? { ...tierCardStyle(r.tier), boxShadow: tierGlow(r.tier) } : undefined}
                    >
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          openDetails(item.tokenId);
                        }}
                        aria-label={`View details for #${item.tokenId}`}
                        className="absolute bottom-1.5 right-1.5 z-[3] flex h-6 w-6 items-center justify-center rounded-full bg-black/90 text-gold-300 transition hover:bg-black hover:text-gold-200"
                      >
                        i
                      </button>
                      <button
                        type="button"
                        aria-pressed={isSelected}
                        aria-label={`${isSelected ? "Deselect" : "Select"} #${item.tokenId}`}
                        // Send is real for every chain family now: Solana
                        // via solana-transfer.ts's plain SPL transfer, Bitcoin
                        // via bitcoin-transfer.ts's window.unisat.sendInscription
                        // (see that module's header for why it's safe -- the
                        // wallet does UTXO selection itself, no hand-rolled
                        // PSBT here).
                        onClick={() => toggleSendSelection(item.tokenId)}
                        className="relative block aspect-square w-full cursor-pointer bg-wood-900 outline-none transition focus-visible:ring-2 focus-visible:ring-gold-400/60"
                      >
                        <Image
                          src={withImageWidth(item.imageUrl, 256) || collection.image}
                          alt={`${collection.name} #${item.tokenId}`}
                          fill
                          sizes="(min-width: 1024px) 20vw, 50vw"
                          className="object-cover"
                          unoptimized={Boolean(item.imageUrl)}
                        />
                        {isSelected && (
                          <span className="card-overlay absolute right-1.5 top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-gold-500 text-wood-950">✓</span>
                        )}
                        {r && (
                          <span
                            className="tier-badge absolute left-1.5 top-1.5 rounded-full px-1.5 py-0.5 text-[0.55rem] font-bold uppercase tracking-wide"
                            style={{ color: tierColor(r.tier) }}
                            title={`Rank #${r.rank} · ${r.percentile.toFixed(0)}th percentile`}
                          >
                            {r.tier}
                          </span>
                        )}
                      </button>
                      <div className="flex flex-1 flex-col gap-0.5 p-2 leading-tight">
                        <span
                          className="truncate text-[0.6rem] font-bold text-foreground"
                          title={r?.name ?? item.name ?? `#${item.tokenId}`}
                        >
                          {r?.name ?? item.name ?? `#${item.tokenId}`}
                        </span>
                        <span className="truncate text-[0.55rem] text-foreground/50">
                          #{item.tokenId}
                          {r ? ` · R${r.rank}` : ""}
                        </span>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}

            {selectedForSend.size > 0 && (
              <div className="fixed inset-x-0 bottom-0 z-40 border-t border-line bg-panel-strong p-3 backdrop-blur sm:sticky sm:rounded-xl sm:border">
                <div className="mx-auto flex max-w-2xl items-center justify-between gap-3">
                  <p className="text-sm font-bold text-foreground">
                    {selectedForSend.size} selected on {chainDisplayName(chainSlug)}
                  </p>
                  <div className="flex gap-2">
                    <button type="button" onClick={() => setSelectedForSend(new Set())} className="text-xs font-bold text-foreground/50 hover:text-gold-300">
                      Clear
                    </button>
                    <button
                      type="button"
                      onClick={() => void openSendConfirm([...selectedForSend])}
                      className="min-h-10 rounded-md bg-gold-500 px-4 text-xs font-bold text-wood-950 hover:bg-gold-400"
                    >
                      Send {selectedForSend.size}
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
      </MarketTabPanel>

      {canSell && (
        <MarketTabPanel id="sell" active={tab === "sell"}>
          {isSolana ? (
            collection && (
              <NativeSolanaListForm
                account={account}
                collection={collection}
                ownedItems={ownedItems}
                ownedLoading={ownedLoading}
                onListed={() => void loadOwned()}
                onConnect={() => void requireAccount()}
                floorWei={floorWei}
              />
            )
          ) : (
            <>
              {collection && (
                <NativeForeignListForm
                  chainSlug={chainSlug}
                  currencySymbol={statCurrencySymbol}
                  account={account}
                  collection={collection}
                  ownedItems={ownedItems}
                  ownedLoading={ownedLoading}
                  onListed={() => void loadOwned()}
                  onConnect={() => void requireAccount()}
                  floorWei={floorWei}
                  relistPreset={relistPreset}
                  onRelistConsumed={() => setRelistPreset(null)}
                />
              )}
              {collection && !ownedLoading && ownedItems.length >= 2 && (
                <div className="mt-4">
                  <NativeBundleListForm
                    chainSlug={chainSlug}
                    currencySymbol={statCurrencySymbol}
                    account={account}
                    collection={collection}
                    ownedItems={ownedItems}
                    onListed={() => {
                      void loadOwned();
                      void loadBundles();
                    }}
                    onConnect={() => void requireAccount()}
                  />
                </div>
              )}
              {collection && !ownedLoading && ownedItems.length >= 1 && (
                <div className="mt-4">
                  <NativeSwapForm
                    chainSlug={chainSlug}
                    account={account}
                    collection={collection}
                    ownedItems={ownedItems}
                    onListed={() => {
                      void loadOwned();
                      void loadSwaps();
                    }}
                    onConnect={() => void requireAccount()}
                  />
                </div>
              )}
            </>
          )}
        </MarketTabPanel>
      )}

      <MarketTabPanel id="positions" active={tab === "positions"}>
        {!account ? (
          <p className="p-6 text-center text-foreground/45">Connect a wallet to see your active listings.</p>
        ) : (
          <div className="space-y-2 rounded-lg border border-line bg-panel p-3">
            <h3 className="text-xs font-black uppercase tracking-wide text-foreground/60">
              My listings {myListings.length > 0 ? `(${myListings.length})` : ""}
            </h3>
            {myListingsLoading ? (
              <SkeletonRows rows={3} columns={["w-16", "w-24"]} />
            ) : myListings.length === 0 ? (
              <div className="flex items-center gap-2 rounded-lg border border-dashed border-line bg-panel-strong px-3 py-5">
                <Tag size={16} strokeWidth={1.75} className="shrink-0 text-gold-400/60" aria-hidden />
                <p className="text-xs text-foreground/50">You have no active listings in {collection.name}.</p>
              </div>
            ) : (
              <ul className="space-y-1.5">
                {myListings.map((l) => (
                  <li key={l.orderHash} className="flex items-center justify-between gap-2 text-xs">
                    <span className="shrink-0 font-bold text-foreground">#{l.tokenId}</span>
                    <span className="flex items-center gap-2">
                      <span className="whitespace-nowrap text-foreground/60 tabular-nums">
                        {formatTokenAmount(l.priceWei, 18, 4)} {statCurrencySymbol}
                        {statUsd(l.priceWei) != null && <span className="ml-1 text-[0.65rem] text-foreground/40">{formatUsdCompact(statUsd(l.priceWei)!)}</span>}
                      </span>
                      {/* Relist: only for Marketplank-native listings on a
                          foreign EVM chain -- a foreign-venue (OpenSea) row
                          isn't ours to relist, same reasoning
                          isMarketplankRelistRequired's own doc comment
                          gives for the native Robinhood-chain path. Jumps to
                          the Sell tab with this item + its current price
                          pre-filled so the seller can adjust and re-sign in
                          one click, rather than re-entering everything by
                          hand. */}
                      {l.native && isForeignEvm && (
                        <button
                          type="button"
                          onClick={() => {
                            setRelistPreset({ tokenId: l.tokenId, priceWei: l.priceWei });
                            setTab("sell");
                          }}
                          className="min-h-7 shrink-0 rounded-md border border-line-strong px-2 text-[0.6rem] font-bold text-gold-300 transition hover:border-gold-400"
                        >
                          Relist
                        </button>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </MarketTabPanel>

      {buyTarget && (
        <BuyConfirm
          listing={buyTarget}
          collection={collection}
          verifiedPriceWei={buyTarget.priceWei}
          busy={buyBusy || status !== null}
          error={error}
          onConfirm={confirmBuy}
          onCancel={() => {
            setError(null);
            setBuyTarget(null);
          }}
          crossChain={{ chainLabel: `${chainDisplayName(chainSlug)} via ${venueLabel(buyTarget)}`, feeBps: FOREIGN_FEE_BPS }}
        />
      )}

      {sweepPreview && (
        <ForeignSweepConfirm
          items={sweepPreview}
          collectionName={collection.name}
          chainLabel={chainLabel}
          // No Marketplank fee on a Solana/Bitcoin sweep -- each item is a
          // raw per-venue buy (buySolanaListingNow/buyBitcoinListingNow),
          // same as the single-item Buy flow already charges no added fee
          // for these two venues.
          feeBps={isNonEvm ? 0 : FOREIGN_FEE_BPS}
          busy={sweepBusy || status !== null}
          error={error}
          statuses={isNonEvm ? sweepStatuses : null}
          // Bitcoin is still genuinely N sequential PSBTs (no real combining
          // path exists -- re-verified this session). Solana now runs
          // through sweepSolanaListingsBatched, which is real
          // single/minimum-signature batching, not sequential -- so this no
          // longer overstates a one-prompt-per-item guarantee for Solana.
          sequential={isBitcoin}
          onConfirm={confirmSweep}
          onCancel={() => {
            setError(null);
            setSweepPreview(null);
            setSweepStatuses(null);
          }}
        />
      )}

      {combinedPreview && (
        <ForeignCombinedSweepConfirm
          affordable={combinedPreview.affordable}
          remainder={combinedPreview.remainder}
          collectionName={collection.name}
          chainLabel={chainLabel}
          feeBps={isNonEvm ? 0 : FOREIGN_FEE_BPS}
          offerDiscountBps={COMBINED_OFFER_DISCOUNT_BPS}
          offersUnavailable={isBitcoin}
          busy={combinedBusy || status !== null}
          error={combinedError}
          statuses={isNonEvm ? combinedStatuses : null}
          sequential={isBitcoin}
          onConfirm={confirmCombined}
          onCancel={() => {
            setCombinedError(null);
            setCombinedPreview(null);
            setCombinedStatuses(null);
          }}
        />
      )}

      {sendTarget && (
        <ForeignSendConfirm
          chainLabel={chainDisplayName(chainSlug)}
          tokenIds={sendTarget}
          feeQuote={sendFeeQuote}
          feeQuoteError={sendFeeError}
          recipient={sendRecipient}
          onRecipientChange={setSendRecipient}
          busy={sendBusy || status !== null}
          error={error}
          statuses={sendStatuses}
          onConfirm={confirmSend}
          onCancel={() => {
            setError(null);
            setSendTarget(null);
          }}
        />
      )}

      {detailsTarget && (
        <ForeignDetailsModal
          listing={detailsTarget}
          collectionName={collection.name}
          traitCounts={traitCounts}
          isSolana={isSolana}
          onClose={() => setDetailsTarget(null)}
          currencySymbol={statCurrencySymbol}
          chainSlug={chainSlug}
          rarity={rarityFor(detailsTarget.tokenId) ?? null}
        />
      )}

      {offerTarget && (
        <ForeignOfferConfirm
          chainLabel={chainDisplayName(chainSlug)}
          tokenId={offerTarget.tokenId}
          currencySymbol={nativeCurrencySymbol(chainSlug, isSolana, isBitcoin)}
          nativeCurrency={isSolana}
          amountEth={offerAmountEth}
          onAmountChange={setOfferAmountEth}
          busy={offerBusy || status !== null}
          error={offerError}
          onConfirm={confirmOffer}
          onCancel={() => {
            setOfferError(null);
            setOfferTarget(null);
          }}
        />
      )}
    </div>
  );
}
