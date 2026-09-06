/**
 * Real, cross-chain-buyable listings for ONE collection on a foreign chain,
 * normalized into the shared Listing shape (lib/market/types.ts) so the SAME
 * ListingCard/BuyConfirm/foreign-fulfill machinery already built and proven
 * for Marketplank's own collection works here unmodified.
 *
 * Server-side for the same reason as the sibling fulfillment-data/
 * floor-listings routes: the OpenSea key must never reach a client bundle.
 *
 * Deliberately a NEW surface, not merged into /api/market/orders (that
 * endpoint is scoped to ONE collection, Marketplank's own RobinWood plank --
 * these are entirely different collections on entirely different chains).
 *
 * WHY THIS ALSO RETURNS COLLECTION METADATA AND PER-TOKEN ART
 * ---------------------------------------------------------------
 * A first version returned bare orders with no imageUrl, on the assumption
 * the caller could resolve art itself. Loading the real page in a real
 * browser proved otherwise: every card rendered <Image src="">, producing
 * 120 console errors and an art-less grid -- for an NFT marketplace, the
 * art IS the product (the same lesson lib/market/types.ts's own Listing
 * .imageUrl comment already records for the Robinhood-chain path: "showing
 * the collection logo for every item makes a grid look broken or fake").
 * So this route now resolves, server-side and in parallel:
 *   - the collection's real name + logo (one /collections/{slug} call), and
 *   - each DISTINCT listed token's own artwork.
 * Distinct-token dedup matters more than it looks: a real collection
 * frequently has many listings across only a handful of tokens (GRiBBiTS
 * live had 5 listings across 2 tokens), so this is typically a couple of
 * calls, not one per listing.
 */
import { NextRequest, NextResponse } from "next/server";
import { fetchForeignAllListingsPaged, priceForeignOrder, resolveOpenSeaCollectionSlug } from "@/lib/market/multichain/trading/foreign-orders";
import { chainManifest } from "@/lib/market/multichain/chains/manifest";
import { foreignChainByChainSlug } from "@/lib/market/multichain/trading/foreign-chain-registry";
import {
  fetchAllOpenSeaListings,
  normaliseOpenSeaListings,
  readCachedOpenSeaListingsForSlug,
  writeCachedOpenSeaListingsForSlug,
} from "@/lib/market/opensea";
import { pickOpenSeaKey } from "@/lib/market/multichain/discovery/opensea-key-pool";
import { getListings } from "@/lib/market/orders-store";
import { getCollectionSupplyStats, getCollectionMarketStats, getTrackedCollection } from "@/lib/market/multichain/store";
import { getCollectionAsync } from "@/lib/market/collections-server";
import { publicError, rateLimit } from "@/lib/security";
import { isSolanaChainSlug, isBitcoinChainSlug, isRobinhoodChainSlug } from "@/lib/market/multichain/trading/non-evm-chains";
import type { Listing } from "@/lib/market/types";
import { refreshPulpListings } from "@/lib/market/pulp";
import { mergeBook } from "@/lib/market/book";
import { fetchOrdNetListings, isOrdNetConfigured, ordNetSatsToPriceWei } from "@/lib/market/multichain/adapters/ordnet";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const OPENSEA = "https://api.opensea.io/api/v2";

/** Bounds the per-token art fan-out. Distinct tokens are usually few (see header); this only guards a pathological case. */
const MAX_ART_LOOKUPS = 30;

function mapBitcoinListings(
  collectionSlug: string,
  chainSlug: string,
  raw: Array<{ id: string; tokenId: string; maker: string; priceWei: string; imageUrl: string | null }>,
  buyable: boolean,
  venue: "unisat" | "ordinals-wallet" = "unisat"
): Listing[] {
  return [...raw]
    .sort((a, b) => (BigInt(a.priceWei) < BigInt(b.priceWei) ? -1 : 1))
    .map((l) => ({
      id: l.id,
      collectionSlug,
      tokenId: l.tokenId,
      maker: l.maker,
      priceWei: l.priceWei,
      expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
      kind: "fixed" as const,
      imageUrl: l.imageUrl ?? undefined,
      venue,
      externalUrl: venue === "unisat"
        ? `https://unisat.io/inscription/${l.tokenId}`
        : `https://ordinalswallet.com/inscription/${l.tokenId}`,
      foreignChainSlug: chainSlug,
      // UniSat auctionId only -- Ordinals Wallet escrow prices are display
      // overlays and cannot be filled via create_bid_prepare.
      foreignOrderHash: buyable ? l.id : undefined,
    }));
}

/** Hub identity (name/image/stats) for the collection page even when a listings venue is rate-limited or empty. */
async function collectionEnvelope(
  chainSlug: string,
  collectionSlug: string,
  overrides: { name?: string | null; imageUrl?: string | null } = {}
) {
  const tracked = await getTrackedCollection(chainSlug, collectionSlug).catch(() => null);
  const supply = await getCollectionSupplyStats(chainSlug, collectionSlug).catch(() => null);
  const marketStats = await getCollectionMarketStats(chainSlug, collectionSlug).catch(() => null);
  return {
    slug: collectionSlug,
    name: overrides.name || tracked?.name || collectionSlug,
    imageUrl: overrides.imageUrl ?? tracked?.imageUrl ?? null,
    contractAddress: tracked?.contractAddress ?? collectionSlug,
    listedCount: supply?.listedCount ?? null,
    totalSupply: supply?.totalSupply ?? null,
    holderCount: supply?.holderCount ?? null,
    floorPriceWei: supply?.floorPriceWei ?? null,
    volume24hWei: marketStats?.volume24hWei ?? null,
    sales24h: marketStats?.sales24h ?? null,
    volume7dWei: marketStats?.volume7dWei ?? null,
    sales7d: marketStats?.sales7d ?? null,
    volume30dWei: marketStats?.volume30dWei ?? null,
    sales30d: marketStats?.sales30d ?? null,
  };
}

async function openSeaJson<T>(path: string, key: string, keyId?: string | null, chainSlug?: string | null): Promise<T | null> {
  const { meteredFetch } = await import("@/lib/market/multichain/edge/provider-ledger");
  const res = await meteredFetch(`${OPENSEA}${path}`, { headers: { "x-api-key": key, accept: "application/json" } }, { source: "opensea", keyId: keyId ?? null, chainSlug: chainSlug ?? null });
  if (!res.ok) return null;
  return (await res.json()) as T;
}

export async function GET(req: NextRequest) {
  const limited = rateLimit(req, { key: "market-multichain-listings", limit: 60, windowMs: 60_000 });
  if (limited) return limited;

  const { searchParams } = new URL(req.url);
  const chainSlug = searchParams.get("chainSlug");
  const collectionSlug = searchParams.get("collectionSlug");
  const limitParam = Number(searchParams.get("limit") ?? "24");
  const limit = Number.isFinite(limitParam) ? Math.min(Math.max(limitParam, 1), 200) : 24;

  if (!chainSlug || !collectionSlug) {
    return NextResponse.json({ error: "chainSlug and collectionSlug are required" }, { status: 400 });
  }

  // CryptoPunks predates ERC-721 and Seaport. Its canonical embedded market
  // is additive to aggregator venues and is read from our durable contract-
  // state projection, never inferred from an empty OpenSea response.
  const normalizedCollection = collectionSlug.toLowerCase();
  if (chainSlug === "eth-mainnet" && normalizedCollection === "0xb47e3cd837ddf8e4c57f05d70ab865de6e193bbb") {
    try {
      const { getCryptoPunksNativeBook, getCryptoPunksNativeBookStats, CRYPTOPUNKS_CONTRACT } = await import("@/lib/market/multichain/native-market-adapters/cryptopunks");
      // REAL BUG FIXED 2026-08-24: a transient Postgres hiccup on EITHER of
      // these two reads (same table this session already found failing
      // transiently for CryptoPunks elsewhere) used to throw the whole
      // route into the catch below (publicError, no listings, no stats at
      // all) even though collectionEnvelope() a few lines down has a real,
      // separately-cached listedCount/floorPriceWei for this exact
      // collection (getCollectionSupplyStats, backed by
      // plank_multichain_snapshots, updated on every past successful
      // native-book sync). A retry-once-then-degrade here matches the
      // fix already applied to this route's own RobinWood-native getListings
      // call: eliminate the transient-blip case outright, and only fall
      // back to the cached snapshot (empty live listings, but real stats)
      // if it's still failing after that.
      const readBookAndStats = async () => {
        try {
          return await Promise.all([getCryptoPunksNativeBook(limit), getCryptoPunksNativeBookStats()]);
        } catch {
          return await Promise.all([getCryptoPunksNativeBook(limit), getCryptoPunksNativeBookStats()]);
        }
      };
      let native: Awaited<ReturnType<typeof getCryptoPunksNativeBook>>;
      let nativeStats: Awaited<ReturnType<typeof getCryptoPunksNativeBookStats>> | null;
      try {
        [native, nativeStats] = await readBookAndStats();
      } catch {
        native = [];
        nativeStats = null;
      }
      if (nativeStats == null) {
        const envelope = await collectionEnvelope(chainSlug, normalizedCollection);
        return NextResponse.json({
          collection: { ...envelope, totalSupply: 10_000 },
          listings: [],
          listingsUnavailable: "cryptopunks-native-book-unavailable",
        }, { headers: { "Cache-Control": "no-store" } });
      }
      // REAL BUG FIXED 2026-08-24, flagged live ("listed only tab... never
      // loaded in"): this branch hardcoded the same dead larvalabs.com
      // hotlink the sync adapter (native-market-adapters/cryptopunks.ts)
      // was already fixed to stop using -- a second, independent copy of
      // the same broken URL that the earlier fix never touched, since this
      // route never reads from plank_collection_tokens at all for this
      // path. Join against the same canonical projection the "All items"
      // tab already reads (readProjectedTokensByIds), which now carries
      // the real on-chain-proxy image URL, so both tabs show the same real
      // art instead of "Listed only" silently reverting to a dead host.
      const { readProjectedTokensByIds } = await import("@/lib/market/multichain/collection-token-store");
      const projectedPunks = await readProjectedTokensByIds(
        chainSlug,
        CRYPTOPUNKS_CONTRACT,
        native.map((offer) => offer.tokenId)
      ).catch(() => new Map());
      const listings: Listing[] = native.map((offer) => {
        const token = projectedPunks.get(offer.tokenId);
        return {
          id: `cryptopunks-native:${offer.tokenId}`,
          collectionSlug,
          tokenId: offer.tokenId,
          tokenName: token?.name ?? `CryptoPunk #${offer.tokenId}`,
          maker: offer.seller,
          priceWei: offer.minValue,
          expiresAt: "9999-12-31T23:59:59.999Z",
          kind: "fixed",
          imageUrl: token?.imageUrl ?? `/api/onchain/cryptopunks-image?index=${offer.tokenId}`,
          venue: "cryptopunks-native",
          externalUrl: `https://www.cryptopunks.app/cryptopunks/details/${offer.tokenId}`,
          foreignChainSlug: chainSlug,
        };
      });
      const { prioritizeCollectionDemand } = await import("@/lib/market/multichain/collection-demand");
      void prioritizeCollectionDemand(chainSlug, normalizedCollection).catch(() => {});
      return NextResponse.json({
        collection: {
          ...(await collectionEnvelope(chainSlug, normalizedCollection)),
          // CryptoPunks is a fixed canonical 10,000-item universe. Do not let
          // an aggregator's temporarily incomplete token index redefine it.
          totalSupply: 10_000,
          listedCount: nativeStats.listedCount,
          floorPriceWei: nativeStats.floorWei,
        },
        listings,
      }, { headers: { "Cache-Control": "public, s-maxage=10, stale-while-revalidate=60" } });
    } catch (error) {
      return publicError(error, "Failed to load CryptoPunks native listings");
    }
  }

  // Robinhood Chain is deliberately absent from FOREIGN_CHAINS (see
  // foreign-chain-registry.ts's own header) -- it's Marketplank's own home
  // chain, not a foreign one, so its listings live in the native order
  // book (lib/market/orders-store.ts), not OpenSea. Auto-discovered
  // Robinhood-Chain collections (lib/market/multichain/discovery/
  // robinhood-chain-scan.ts) still need to render in THIS shared
  // MultichainCollectionView UI though (MarketView.tsx is hardcoded to
  // one curated collection, see getCollectionAsync's own header), so this
  // branch adapts the native Listing[] shape into the same response shape
  // the rest of this route already returns for real foreign chains.
  if (isRobinhoodChainSlug(chainSlug)) {
    try {
      const collection = await getCollectionAsync(collectionSlug);
      if (!collection) {
        return NextResponse.json({ error: "NOT_FOUND", message: "Unknown Robinhood-Chain collection." }, { status: 404 });
      }
      const openSeaSlug = await resolveOpenSeaCollectionSlug("robinhood", collection.contractAddress).catch(() => null);
      // "live" priority: a real page load competes for the LEAST-loaded key
      // in the pool, so background discovery/sync supervisors saturating
      // their own (most-loaded) key never starve this request.
      const liveKey = openSeaSlug ? await pickOpenSeaKey("live").catch(() => null) : null;
      const [nativeRows, pulp, openSeaPage] = await Promise.all([
        getListings(collectionSlug),
        // PulpMarket is collection-address scoped. The old client silently
        // hard-coded RobinWood, which made every other Robinhood collection
        // (including MUGS) report aggregate inventory without its orders.
        refreshPulpListings(collection.contractAddress).catch(() => []),
        openSeaSlug
          ? fetchAllOpenSeaListings(openSeaSlug, { apiKeyOverride: liveKey?.apiKey }).catch(() => null)
          : Promise.resolve(null),
      ]);
      const native: Listing[] = nativeRows.map(({ rawOrder: _rawOrder, ...listing }) => listing);
      // A partial cursor walk cannot safely participate in floor or rarity
      // projections: the missing next page may contain a cheaper token. But
      // dropping it to [] outright is what produced the observed "populates
      // then reverts to empty" flicker (mergeBook has nothing else to fall
      // back to for the OpenSea side of the book that poll) -- fall back to
      // the last REAL complete walk for this collection instead, so a
      // transient rate-limit/timeout on the shared OpenSea key pool degrades
      // to stale-but-real data, not a false zero.
      let openSeaIsPartial = false;
      let openSea: ReturnType<typeof normaliseOpenSeaListings> = [];
      if (openSeaPage?.complete) {
        openSea = normaliseOpenSeaListings(openSeaPage.listings);
        if (openSeaSlug) void writeCachedOpenSeaListingsForSlug(openSeaSlug, openSea).catch(() => {});
      } else if (openSeaSlug) {
        const cached = await readCachedOpenSeaListingsForSlug(openSeaSlug).catch(() => null);
        if (cached && cached.length > 0) {
          openSea = cached;
          openSeaIsPartial = true;
        } else if (openSeaPage?.listings?.length) {
          // REAL BUG FIXED 2026-08-23, flagged live ("mugs ... doesnt have
          // listings from all markets"): a walk that fails on even ONE page
          // (out of however many a real listing count needs -- likely under
          // heavy shared-OpenSea-key-pool load from this app's own many
          // background sync jobs) discarded the ENTIRE result to `[]`, with
          // no cache to fall back to either (caching only ever happened on a
          // fully complete walk) -- a real chicken-and-egg trap that could
          // leave a collection showing zero listings indefinitely even
          // though real, live, purchasable listings exist (confirmed live:
          // MUGS by 9mm.Pro genuinely has 231 real active OpenSea listings
          // on Robinhood Chain -- verified via a direct API call -- while
          // this route was returning an empty book for it). This partial-
          // but-real batch is still real, priced, purchasable listings; use
          // it for display and seed the cache with it so the NEXT
          // incomplete walk at least has something better than nothing to
          // fall back to. Never let this partial batch drive a "floor"
          // CLAIM though (see openSeaIsPartial's existing consumers) -- the
          // missing pages could still contain a cheaper token.
          openSea = normaliseOpenSeaListings(openSeaPage.listings);
          openSeaIsPartial = true;
          void writeCachedOpenSeaListingsForSlug(openSeaSlug, openSea).catch(() => {});
        }
      }
      const listings = mergeBook(
        native,
        [...pulp, ...openSea],
        collection.slug,
        undefined,
        collection.contractAddress
      );
      // Venue rows commonly omit per-token metadata. Joining the sparse book
      // to the canonical projection by token id prevents every missing image
      // from falling through to the collection logo (the MUGS identical-card
      // failure) while keeping the operation proportional to listed rows.
      const { readProjectedTokensByIds } = await import("@/lib/market/multichain/collection-token-store");
      const projected = await readProjectedTokensByIds(
        chainSlug,
        collection.contractAddress,
        listings.map((listing) => listing.tokenId)
      ).catch(() => new Map());
      const enrichedListings = listings.map((listing) => {
        const token = projected.get(String(listing.tokenId));
        if (!token) return listing;
        return {
          ...listing,
          tokenName: token.name ?? listing.tokenName,
          imageUrl: token.imageUrl ?? listing.imageUrl,
          animationUrl: token.animationUrl ?? listing.animationUrl,
          mediaType: token.mediaType ?? listing.mediaType,
          traits: token.traits.length ? token.traits : listing.traits,
        };
      });
      const supply = await getCollectionSupplyStats(chainSlug, collection.contractAddress).catch(() => null);
      const marketStats = await getCollectionMarketStats(chainSlug, collection.contractAddress).catch(() => null);
      return NextResponse.json(
        {
          collection: {
            slug: collection.slug,
            name: collection.name,
            imageUrl: collection.image ?? null,
            contractAddress: collection.contractAddress,
            listedCount: supply?.listedCount ?? null,
            totalSupply: supply?.totalSupply ?? null,
            holderCount: supply?.holderCount ?? null,
            volume24hWei: marketStats?.volume24hWei ?? null,
            sales24h: marketStats?.sales24h ?? null,
            volume7dWei: marketStats?.volume7dWei ?? null,
            sales7d: marketStats?.sales7d ?? null,
            volume30dWei: marketStats?.volume30dWei ?? null,
            sales30d: marketStats?.sales30d ?? null,
          },
          listings: enrichedListings,
          // `complete` is true only when THIS poll's own OpenSea cursor walk
          // finished. `partial` is the client-facing signal for "this specific
          // poll's OpenSea walk was incomplete, so the opensea rows shown here
          // (if any) are a fallback from a previous good walk, not fresh" --
          // distinct from a genuine complete-and-truly-empty result. See
          // opensea.ts's readCachedOpenSeaListingsForSlug/writeCachedOpenSea
          // ListingsForSlug for the fallback this flag describes.
          bookCoverage: {
            complete: Boolean(openSeaPage?.complete),
            partial: openSeaIsPartial,
            sources: {
              native: "durable",
              pulp: "upstream-unpaginated",
              opensea: openSeaPage?.complete
                ? "cursor-exhausted"
                : openSeaIsPartial
                  ? "incomplete-fallback-cached"
                  : "incomplete-excluded",
            },
          },
        },
        { headers: { "Cache-Control": "no-store" } }
      );
    } catch (error) {
      return publicError(error, "Failed to load Robinhood-Chain listings");
    }
  }

  // SOLANA -- real, keyless Magic Eden listings. Confirmed live 2026-08-18:
  // GET /v2/collections/{symbol}/listings needs no API key at all (unlike
  // the buy_now/sell endpoints magiceden-solana-trade.ts guards behind
  // MAGICEDEN_API_KEY), returning real tokenMint/seller/price rows with
  // real per-token art and traits already embedded (no separate art-lookup
  // fan-out needed the way the EVM/OpenSea branch below requires). `symbol`
  // is Magic Eden's own collection slug -- the SAME value magiceden-solana.ts's
  // discovery adapter already stores as `contractAddress` for every Solana
  // row in GlobalMarketHub, so collectionSlug here is that identical string.
  if (chainSlug && isSolanaChainSlug(chainSlug)) {
    try {
      type MeListing = {
        tokenMint: string;
        seller: string;
        price: number;
        expiry?: number;
        pdaAddress?: string;
        auctionHouse?: string;
        tokenAddress?: string;
        token?: { name?: string; image?: string; collectionName?: string; attributes?: Array<{ trait_type: string; value: string }> };
      };
      const pageSize = 20;
      // Real gap found live 2026-08-25 ("many visitors one fingerprint"
      // audit): this whole paginated fetch ran raw, on every single
      // request, with zero coalescing -- N concurrent visitors browsing
      // this same collection's listings each independently hammered Magic
      // Eden with their own full pagination loop. Wrapped in the same
      // getOrRefresh singleflight/SWR mechanism every other live upstream
      // call in this file already uses. Short soft TTL (real order book,
      // changes as people list/buy) still collapses any real concurrent
      // burst into one upstream walk; keyed on (collectionSlug, limit) so
      // the common "default page size" case coalesces across visitors even
      // when a few request a deeper page.
      const { getOrRefresh: getOrRefreshMe } = await import("@/lib/market/multichain/singleflight-cache");
      const raw = await getOrRefreshMe<MeListing[]>(
        `magiceden-listings:${collectionSlug}:${limit}`,
        { softTtlMs: 15_000, hardTtlMs: 2 * 60_000, provider: "magiceden" },
        async () => {
          const rows: MeListing[] = [];
          const seenMint = new Set<string>();
          for (let offset = 0; offset < limit; offset += pageSize) {
            const res = await fetch(
              `https://api-mainnet.magiceden.dev/v2/collections/${encodeURIComponent(collectionSlug)}/listings?limit=${pageSize}&offset=${offset}`,
              { headers: { accept: "application/json" }, signal: AbortSignal.timeout(15_000) }
            );
            if (!res.ok) {
              if (rows.length === 0) throw new Error(`Magic Eden ${res.status}`);
              break;
            }
            const page = (await res.json()) as MeListing[];
            if (!Array.isArray(page) || page.length === 0) break;
            for (const row of page) {
              if (!row.tokenMint || seenMint.has(row.tokenMint)) continue;
              seenMint.add(row.tokenMint);
              rows.push(row);
            }
            if (page.length < pageSize) break;
          }
          return rows;
        }
      );
      const listings: Listing[] = raw
        .filter((l) => l.tokenMint && typeof l.price === "number")
        .map((l) => {
          // Same 1e18-equivalent scaling convention as
          // magiceden-solana.ts's lamportsToScaledString -- keeps this row's
          // priceWei comparable in MAGNITUDE with every EVM chain's wei
          // figure for shared display code, while foreign-fulfill.ts's
          // buySolanaListingNow un-scales it back to real lamports before
          // ever calling Magic Eden's own buy_now endpoint (see that
          // function's own comment).
          const lamports = BigInt(Math.round(l.price * 1_000_000_000));
          const priceWei = (lamports * BigInt(1_000_000_000)).toString();
          return {
            id: l.tokenMint,
            collectionSlug,
            tokenId: l.tokenMint,
            tokenName: l.token?.name ?? undefined,
            maker: l.seller,
            priceWei,
            // ME's listings endpoint returns expiry -1 for "no expiry" --
            // honest 1-year-out placeholder ONLY for the UI's "expires"
            // display, never used to gate buyability (Magic Eden's own
            // program is the actual source of truth at fulfillment time).
            expiresAt:
              l.expiry && l.expiry > 0 ? new Date(l.expiry * 1000).toISOString() : new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
            kind: "fixed" as const,
            imageUrl: l.token?.image ?? undefined,
            traits: l.token?.attributes?.map((a) => ({ traitType: a.trait_type, value: a.value })) ?? undefined,
            venue: "magiceden" as const,
            externalUrl: `https://magiceden.io/item-details/${l.tokenMint}`,
            foreignChainSlug: chainSlug,
            foreignOrderHash: l.tokenMint,
            solanaEscrow:
              l.auctionHouse && l.tokenAddress
                ? { auctionHouse: l.auctionHouse, tokenAccount: l.tokenAddress, pdaAddress: l.pdaAddress }
                : undefined,
          };
        })
        .sort((a, b) => (BigInt(a.priceWei) < BigInt(b.priceWei) ? -1 : 1));

      return NextResponse.json(
        {
          collection: await collectionEnvelope(chainSlug, collectionSlug, {
            name: raw[0]?.token?.collectionName ?? null,
          }),
          listings,
        },
        { headers: { "Cache-Control": "no-store" } }
      );
    } catch (error) {
      return publicError(error, "Failed to load Solana listings");
    }
  }

  // BITCOIN ORDINALS -- real UniSat Marketplace listings, key-gated.
  // CORRECTED 2026-08-18: an earlier pass concluded no listing-query
  // endpoint existed for UniSat's Marketplace API and always returned an
  // empty grid here. Live-verified THIS pass (a real curl against
  // open-api.unisat.io/v3/market/collection/auction/list) that the endpoint
  // DOES exist -- it returned a real, specific "provide Authorization
  // header with format `Bearer {token}`" error, the exact same
  // Bearer-token-required shape unisat-ordinals-trade.ts's trade endpoints
  // already document (see solana-bitcoin-listings.ts's own header for the
  // full verification). So this now follows the SAME "fail closed on a
  // missing key, otherwise fetch real data" posture the OpenSea/EVM branch
  // below already uses, instead of claiming no source exists at all.
  if (chainSlug && isBitcoinChainSlug(chainSlug)) {
    try {
      const { fetchUniSatListings } = await import("@/lib/market/multichain/trading/solana-bitcoin-listings");
      const { fetchOrdinalsWalletCatalog } = await import("@/lib/market/multichain/adapters/ordinalswallet-catalog");
      const { fetchSatflowListings, resolveSatflowCollectionStats } = await import("@/lib/market/multichain/adapters/satflow-ordinals");
      const { fetchOkxOrdinalsListings, fetchOkxCollectionStats } = await import("@/lib/market/multichain/adapters/okx-ordinals");
      const [unisatResult, owResult, ordnetResult, satflowResult, okxResult] = await Promise.allSettled([
        process.env.UNISAT_API_KEY
          ? fetchUniSatListings(collectionSlug, Math.min(limit, 20))
          : Promise.resolve([]),
        fetchOrdinalsWalletCatalog(collectionSlug),
        isOrdNetConfigured() ? fetchOrdNetListings(collectionSlug, limit) : Promise.resolve([]),
        fetchSatflowListings(collectionSlug, limit),
        fetchOkxOrdinalsListings(collectionSlug, limit),
      ]);
      const unisat = unisatResult.status === "fulfilled" ? unisatResult.value : [];
      const ow = owResult.status === "fulfilled" ? owResult.value : { listings: [] };
      const ordnet = ordnetResult.status === "fulfilled" ? ordnetResult.value : [];
      const satflow = satflowResult.status === "fulfilled" ? satflowResult.value : [];
      const okx = okxResult.status === "fulfilled" ? okxResult.value : [];
      const candidates: Listing[] = [
        ...mapBitcoinListings(collectionSlug, chainSlug, unisat, true),
        ...mapBitcoinListings(collectionSlug, chainSlug, ow.listings, false, "ordinals-wallet"),
        ...ordnet.map((row): Listing => ({
          id: `ordnet:${row.listingId}`,
          collectionSlug,
          tokenId: row.inscriptionId,
          tokenName: row.inscriptionName,
          maker: row.sellerAddress,
          priceWei: ordNetSatsToPriceWei(row.priceSats),
          expiresAt: row.listingExpiresAt ?? "9999-12-31T23:59:59.999Z",
          kind: "fixed",
          venue: "ordnet",
          externalUrl: `https://ord.net/inscription/${row.inscriptionId}`,
          foreignChainSlug: chainSlug,
        })),
        // Satflow -- new venue 2026-08-24 (flagged live: YONDER trades
        // almost exclusively here, UniSat's own book for it is genuinely
        // empty). See satflow-ordinals.ts's own header for the real API
        // vs scrape-fallback distinction; fetchSatflowListings only ever
        // returns real per-listing rows via the documented API (empty
        // without a configured key, never a scraped approximation mixed
        // into individual listing rows).
        ...satflow.map((row): Listing => ({
          id: `satflow:${row.inscriptionId}`,
          collectionSlug,
          tokenId: row.inscriptionId,
          maker: row.sellerAddress ?? "unknown",
          priceWei: ordNetSatsToPriceWei(row.priceSats),
          expiresAt: "9999-12-31T23:59:59.999Z",
          kind: "fixed",
          imageUrl: `https://ordinals.com/content/${row.inscriptionId}`,
          venue: "satflow",
          externalUrl: `https://www.satflow.com/ordinals/${collectionSlug}`,
          foreignChainSlug: chainSlug,
        })),
        // OKX -- new venue 2026-08-24, owner's own explicit follow-up
        // request after Satflow ("help me get a key for satflow and okx
        // and weave them elegantly into total solution"). See
        // okx-ordinals.ts's own header for the real-vs-defensive field
        // name distinction; returns [] until real OKX credentials
        // (OKX_API_KEY/OKX_API_SECRET/OKX_API_PASSPHRASE) are configured.
        ...okx.map((row): Listing => ({
          id: `okx:${row.inscriptionId}`,
          collectionSlug,
          tokenId: row.inscriptionId,
          maker: row.sellerAddress ?? "unknown",
          priceWei: ordNetSatsToPriceWei(row.priceSats),
          expiresAt: "9999-12-31T23:59:59.999Z",
          kind: "fixed",
          imageUrl: `https://ordinals.com/content/${row.inscriptionId}`,
          venue: "okx",
          externalUrl: `https://web3.okx.com/nft/collection/btc/${collectionSlug}`,
          foreignChainSlug: chainSlug,
        })),
      ];
      // Real, immediate hydration on visit (see this session's standing
      // "no unpopulated spot" directive): when every listing source above
      // came back empty but Satflow's or OKX's own collection stats have
      // real, live floor/listed data, persist it now via the same
      // COALESCE-safe upsert every other floor-only source uses -- never
      // overwrites a real value from a richer source, only fills a real
      // gap (see YONDER: UniSat's own book is honestly empty, but a real
      // floor/listed figure exists on Satflow). Satflow is tried first
      // (its scrape fallback works today without any credentials at
      // all); OKX only contributes once real credentials exist.
      if (candidates.length === 0) {
        const satflowStats = await resolveSatflowCollectionStats(collectionSlug).catch(() => null);
        const stats = satflowStats ?? (await fetchOkxCollectionStats(collectionSlug).catch(() => null));
        const marketplace = satflowStats ? "satflow" : "okx";
        if (stats?.floorPriceSats != null) {
          const { updateCollectionFloorOnly } = await import("@/lib/market/multichain/store");
          void updateCollectionFloorOnly(chainSlug, collectionSlug, {
            floorPriceWei: ordNetSatsToPriceWei(stats.floorPriceSats),
            floorPriceCurrency: "BTC",
            floorPriceMarketplace: marketplace,
          }).catch(() => {});
        }
        if (stats?.listedCount != null) {
          const { updateCollectionSupplyFields } = await import("@/lib/market/multichain/store");
          void updateCollectionSupplyFields(chainSlug, collectionSlug, {
            listedCount: stats.listedCount,
            totalSupply: stats.totalSupply,
          }).catch(() => {});
        }
      }
      // One executable economic position per inscription in the grid; retain
      // the cheapest venue while source coverage remains visible below.
      const cheapest = new Map<string, Listing>();
      for (const listing of candidates) {
        const previous = cheapest.get(listing.tokenId);
        if (!previous || BigInt(listing.priceWei) < BigInt(previous.priceWei)) cheapest.set(listing.tokenId, listing);
      }
      const listings = [...cheapest.values()].sort((a, b) => {
        const left = BigInt(a.priceWei), right = BigInt(b.priceWei);
        return left < right ? -1 : left > right ? 1 : 0;
      }).slice(0, limit);
      return NextResponse.json(
        {
          collection: await collectionEnvelope(chainSlug, collectionSlug),
          listings,
          bookCoverage: {
            complete: false,
            sources: {
              unisat: !process.env.UNISAT_API_KEY ? "credential-missing" : unisatResult.status === "fulfilled" ? "queried" : "upstream-error",
              ordinalsWallet: owResult.status === "fulfilled" ? "catalog-overlay" : "upstream-error",
              ordnet: !isOrdNetConfigured() ? "wallet-session-missing" : ordnetResult.status === "fulfilled" ? "cursor-read" : "upstream-error",
              satflow: !process.env.SATFLOW_API_KEY ? "credential-missing" : satflowResult.status === "fulfilled" ? "queried" : "upstream-error",
              okx: !process.env.OKX_API_KEY ? "credential-missing" : okxResult.status === "fulfilled" ? "queried" : "upstream-error",
            },
          },
        },
        { headers: { "Cache-Control": "no-store" } }
      );
    } catch (error) {
      return publicError(error, "Failed to load Bitcoin Ordinals listings");
    }
  }

  const chain = chainSlug ? foreignChainByChainSlug(chainSlug) : null;
  if (!chain) {
    return NextResponse.json({ error: `"${chainSlug}" is not a supported foreign chain` }, { status: 400 });
  }

  try {
    // "live" priority -- see the Robinhood-chain branch above for why.
    const key = (await pickOpenSeaKey("live"))?.apiKey ?? null;
    if (!key) {
      return NextResponse.json({ error: "OpenSea API key is not configured on this deployment." }, { status: 503 });
    }

    // Every card that links here (GlobalMarketHub.tsx) uses the CONTRACT
    // ADDRESS as the URL's collectionSlug segment, but OpenSea's
    // /listings and /collections endpoints need OpenSea's own slug (e.g.
    // "basenames") -- see resolveOpenSeaCollectionSlug's own header for
    // the real, live-confirmed silent-empty-page bug this fixes. A
    // slug-shaped param (already resolved, e.g. from a search box) passes
    // through unresolved.
    // No OpenSea orderbook for this chain (zkSync today) -- there's no
    // OpenSea slug to resolve; fetchForeignAllListings below already
    // returns [] for this case, so the rest of this route degrades
    // naturally (empty orders, collection metadata falls back to the raw
    // address) rather than needing a separate early return here.
    const openSeaSlug =
      chain.openSeaChain && /^0x[0-9a-fA-F]{40}$/.test(collectionSlug)
        ? ((await resolveOpenSeaCollectionSlug(chain.openSeaChain, collectionSlug)) ?? collectionSlug)
        : collectionSlug;

    // REAL BUG: this collection-identity call had no caching at all --
    // every visible-page render of a foreign-EVM collection re-fetched
    // OpenSea's /collections/{slug} endpoint, live, uncoalesced. Same class
    // of bug as the Magic Eden stats fetch fixed in collection/route.ts.
    // Shares the SAME cache key namespace hydrate-stats/route.ts's own
    // collection-meta fetch uses (both resolve the identical endpoint for
    // the same collection, keyed on the same resolved slug) so a page view
    // and a background hydrate call coalesce into one upstream call, not two
    // independent caches. Name/image/contract mapping change on human
    // timescales at most.
    type OpenSeaCollectionMeta = { name?: string; image_url?: string; contracts?: Array<{ address: string; chain: string }> };
    const { getOrRefresh } = await import("@/lib/market/multichain/singleflight-cache");
    const [paged, collectionMeta] = await Promise.all([
      fetchForeignAllListingsPaged({ chainSlug, collectionSlug: openSeaSlug, limit }),
      getOrRefresh<OpenSeaCollectionMeta | null>(
        `opensea-collection-meta:${chain.openSeaChain}:${openSeaSlug}`,
        { softTtlMs: 5 * 60_000, hardTtlMs: 60 * 60_000, provider: "opensea" },
        async () => {
          const meta = await openSeaJson<OpenSeaCollectionMeta>(`/collections/${encodeURIComponent(openSeaSlug)}`, key);
          if (!meta) throw new Error(`opensea collection meta unavailable for ${openSeaSlug}`);
          return meta;
        }
      ).catch(() => null),
    ]);

    // ONE CARD PER TOKEN, CHEAPEST WINS.
    //
    // OpenSea's /listings/.../all returns every active order, and a single
    // token routinely carries several -- confirmed live in a real browser:
    // a 40-listing response rendered as #541 three times, #2943 four times,
    // same maker and same price each time (OpenSea re-signs/rotates an
    // order as it nears its ~11-minute expiry, so one economic listing
    // appears as many order hashes). Rendered undeduped, the grid looks
    // broken or spammy -- the same failure mode lib/market/sweep.ts's own
    // dedup already guards against for the Robinhood-chain path ("two
    // listings of the same plank can't both fill, so only the cheapest is
    // kept"). Same rule, same reason, applied here for display.
    // AUDIT lens 2 #1/#6 (2026-09-06): price every order in its own
    // currency. Only native / wrapped-native asks compete for "cheapest"
    // and the floor; orders priced in another token are excluded from the
    // grid rather than shown at a wrong number with the wrong icon.
    const rawOrders = paged.orders;
    const pagedComplete = paged.complete;
    const pricingChain = chainManifest(chainSlug) ?? { nativeCurrencySymbol: "ETH", offerCurrencyAddress: null, offerCurrencySymbol: "WETH" };
    const pricingOf = (o: (typeof rawOrders)[number]) => priceForeignOrder(o.parameters, pricingChain);
    let excludedNonNative = 0;
    const cheapestByToken = new Map<string, (typeof rawOrders)[number]>();
    for (const order of rawOrders) {
      const tokenId = order.parameters.offer[0]?.identifierOrCriteria;
      if (!tokenId) continue;
      const pricing = pricingOf(order);
      if (!pricing.nativeEquivalent) {
        excludedNonNative += 1;
        continue;
      }
      const existing = cheapestByToken.get(tokenId);
      if (!existing || pricing.priceAtomic < pricingOf(existing).priceAtomic) cheapestByToken.set(tokenId, order);
    }
    const orders = [...cheapestByToken.values()].sort((a, b) => {
      const pa = pricingOf(a).priceAtomic;
      const pb = pricingOf(b).priceAtomic;
      return pa < pb ? -1 : pa > pb ? 1 : 0;
    });

    // Polygon-specific OpenSea inconsistency, confirmed live 2026-08-18
    // (see rarity-index-runner.ts's own comment): this endpoint's
    // contracts[].chain returns "polygon" for the same chain the
    // /chain/{chain}/contract/ path segment calls "matic" everywhere
    // else. This route already had a fallback chain so it wasn't hard-
    // broken for Polygon, but the alias makes the FIRST match correct
    // instead of silently falling through.
    const chainAliases: Record<string, string[]> = { matic: ["matic", "polygon"] };
    const acceptableChainValues = chain.openSeaChain ? (chainAliases[chain.openSeaChain] ?? [chain.openSeaChain]) : [];
    const contractAddress =
      collectionMeta?.contracts?.find((c) => acceptableChainValues.includes(c.chain))?.address ??
      collectionMeta?.contracts?.[0]?.address ??
      orders[0]?.parameters.offer[0]?.token ??
      "";

    // Resolve each DISTINCT token's own art once (see header on why dedup matters).
    const distinctTokenIds = [
      ...new Set(orders.map((o) => o.parameters.offer[0]?.identifierOrCriteria).filter(Boolean) as string[]),
    ].slice(0, MAX_ART_LOOKUPS);

    // Per-token art was fetched live on every page render with no caching --
    // a token's name/image/traits are effectively immutable (metadata
    // doesn't change once minted), so this is a pure loss: every visitor to
    // a popular collection re-paid the same OpenSea NFT lookup for the same
    // tokens. Long TTL is safe here specifically because it's identity/art
    // data, not price data.
    type OpenSeaNft = { nft?: { name?: string; image_url?: string; traits?: Array<{ trait_type: string; value: string }> } };
    const artEntries = await Promise.all(
      distinctTokenIds.map(async (tokenId) => {
        const nft = await getOrRefresh<OpenSeaNft | null>(
          `opensea-nft-art:${chain.openSeaChain}:${contractAddress.toLowerCase()}:${tokenId}`,
          { softTtlMs: 5 * 60_000, hardTtlMs: 60 * 60_000, provider: "opensea" },
          async () => {
            const result = await openSeaJson<OpenSeaNft>(`/chain/${chain.openSeaChain}/contract/${contractAddress}/nfts/${tokenId}`, key);
            if (!result) throw new Error(`opensea nft art unavailable for ${contractAddress}/${tokenId}`);
            return result;
          }
        ).catch(() => null);
        return [
          tokenId,
          {
            name: nft?.nft?.name ?? null,
            imageUrl: nft?.nft?.image_url ?? null,
            traits: (nft?.nft?.traits ?? []).map((t) => ({ traitType: t.trait_type, value: t.value })),
          },
        ] as const;
      })
    );
    const artByToken = new Map(artEntries);

    const listings: Listing[] = orders.map((order) => {
      const item = order.parameters.offer[0];
      const tokenId = item?.identifierOrCriteria ?? "";
      const pricing = pricingOf(order);
      const priceWei = pricing.priceAtomic.toString();
      const art = artByToken.get(tokenId);
      return {
        id: order.orderHash,
        collectionSlug,
        tokenId,
        tokenName: art?.name ?? undefined,
        maker: order.parameters.offerer,
        priceWei,
        currencySymbol: pricing.currencySymbol,
        currencyAddress: pricing.currencyAddress,
        expiresAt: new Date(Number(order.parameters.endTime) * 1000).toISOString(),
        kind: "fixed",
        imageUrl: art?.imageUrl ?? undefined,
        traits: art?.traits ?? undefined,
        venue: "opensea",
        externalUrl: `https://opensea.io/assets/${chain.openSeaChain}/${contractAddress}/${tokenId}`,
        foreignChainSlug: chainSlug,
        foreignOrderHash: order.orderHash,
      };
    });

    const fromIndex = await collectionEnvelope(chainSlug, collectionSlug, {
      name: collectionMeta?.name ?? null,
      imageUrl: collectionMeta?.image_url ?? null,
    });
    return NextResponse.json(
      {
        collection: { ...fromIndex, contractAddress: contractAddress || fromIndex.contractAddress },
        listings,
        bookCoverage: {
          complete: pagedComplete,
          partial: !pagedComplete,
          sources: { opensea: pagedComplete ? "cursor-exhausted" : "truncated-at-limit" },
          excludedNonNativeCurrency: excludedNonNative,
        },
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (/429|rate limit|quota/i.test(msg)) {
      return NextResponse.json(
        {
          collection: await collectionEnvelope(chainSlug, collectionSlug),
          listings: [],
          listingsUnavailable: "opensea-rate-limit",
        },
        { headers: { "Cache-Control": "no-store" } }
      );
    }
    return publicError(error, "Failed to load multichain listings");
  }
}
