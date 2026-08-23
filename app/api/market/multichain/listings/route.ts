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
import { fetchForeignAllListings, resolveOpenSeaCollectionSlug } from "@/lib/market/multichain/trading/foreign-orders";
import { foreignChainByChainSlug } from "@/lib/market/multichain/trading/foreign-chain-registry";
import { fetchAllOpenSeaListings, getOpenSeaApiKey, normaliseOpenSeaListings } from "@/lib/market/opensea";
import { getListings } from "@/lib/market/orders-store";
import { getCollectionSupplyStats, getCollectionMarketStats, getTrackedCollection } from "@/lib/market/multichain/store";
import { getCollectionAsync } from "@/lib/market/collections-server";
import { publicError, rateLimit } from "@/lib/security";
import { isSolanaChainSlug, isBitcoinChainSlug, isRobinhoodChainSlug } from "@/lib/market/multichain/trading/non-evm-chains";
import type { Listing } from "@/lib/market/types";
import { refreshPulpListings } from "@/lib/market/pulp";
import { mergeBook } from "@/lib/market/book";

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

async function openSeaJson<T>(path: string, key: string): Promise<T | null> {
  const res = await fetch(`${OPENSEA}${path}`, { headers: { "x-api-key": key, accept: "application/json" } });
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
      const { getCryptoPunksNativeBook, getCryptoPunksNativeBookStats } = await import("@/lib/market/multichain/native-market-adapters/cryptopunks");
      const [native, nativeStats] = await Promise.all([
        getCryptoPunksNativeBook(limit),
        getCryptoPunksNativeBookStats(),
      ]);
      const listings: Listing[] = native.map((offer) => ({
        id: `cryptopunks-native:${offer.tokenId}`,
        collectionSlug,
        tokenId: offer.tokenId,
        tokenName: `CryptoPunk #${offer.tokenId}`,
        maker: offer.seller,
        priceWei: offer.minValue,
        expiresAt: "9999-12-31T23:59:59.999Z",
        kind: "fixed",
        imageUrl: `https://www.larvalabs.com/cryptopunks/cryptopunk${offer.tokenId}.png`,
        venue: "cryptopunks-native",
        externalUrl: `https://www.cryptopunks.app/cryptopunks/details/${offer.tokenId}`,
        foreignChainSlug: chainSlug,
      }));
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
      const [nativeRows, pulp, openSeaPage] = await Promise.all([
        getListings(collectionSlug),
        // PulpMarket is collection-address scoped. The old client silently
        // hard-coded RobinWood, which made every other Robinhood collection
        // (including MUGS) report aggregate inventory without its orders.
        refreshPulpListings(collection.contractAddress).catch(() => []),
        openSeaSlug ? fetchAllOpenSeaListings(openSeaSlug).catch(() => null) : Promise.resolve(null),
      ]);
      const native: Listing[] = nativeRows.map(({ rawOrder: _rawOrder, ...listing }) => listing);
      // A partial cursor walk cannot safely participate in floor or rarity
      // projections: the missing next page may contain a cheaper token.
      const openSea = openSeaPage?.complete
        ? normaliseOpenSeaListings(openSeaPage.listings)
        : [];
      const listings = mergeBook(
        native,
        [...pulp, ...openSea],
        collection.slug,
        undefined,
        collection.contractAddress
      );
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
          listings,
          bookCoverage: {
            complete: Boolean(openSeaPage?.complete),
            sources: {
              native: "durable",
              pulp: "upstream-unpaginated",
              opensea: openSeaPage?.complete ? "cursor-exhausted" : "incomplete-excluded",
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
      const raw: MeListing[] = [];
      const seenMint = new Set<string>();
      for (let offset = 0; offset < limit; offset += pageSize) {
        const res = await fetch(
          `https://api-mainnet.magiceden.dev/v2/collections/${encodeURIComponent(collectionSlug)}/listings?limit=${pageSize}&offset=${offset}`,
          { headers: { accept: "application/json" }, signal: AbortSignal.timeout(15_000) }
        );
        if (!res.ok) {
          if (raw.length === 0) return NextResponse.json({ error: `Magic Eden ${res.status}` }, { status: 502 });
          break;
        }
        const page = (await res.json()) as MeListing[];
        if (!Array.isArray(page) || page.length === 0) break;
        for (const row of page) {
          if (!row.tokenMint || seenMint.has(row.tokenMint)) continue;
          seenMint.add(row.tokenMint);
          raw.push(row);
        }
        if (page.length < pageSize) break;
      }
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
    if (!process.env.UNISAT_API_KEY) {
      return NextResponse.json({ error: "UniSat API key is not configured on this deployment." }, { status: 503 });
    }
    try {
      const { fetchUniSatListings } = await import("@/lib/market/multichain/trading/solana-bitcoin-listings");
      const raw = await fetchUniSatListings(collectionSlug, Math.min(limit, 20));
      const listings: Listing[] = mapBitcoinListings(collectionSlug, chainSlug, raw, true);
      if (listings.length === 0) {
        const { fetchOrdinalsWalletCatalog } = await import("@/lib/market/multichain/adapters/ordinalswallet-catalog");
        const ow = await fetchOrdinalsWalletCatalog(collectionSlug);
        return NextResponse.json(
          {
            collection: await collectionEnvelope(chainSlug, collectionSlug),
            listings: mapBitcoinListings(collectionSlug, chainSlug, ow.listings, false, "ordinals-wallet"),
            listingsUnavailable: ow.listings.length > 0 ? null : "unisat-rate-limit",
          },
          { headers: { "Cache-Control": "no-store" } }
        );
      }
      return NextResponse.json(
        {
          collection: await collectionEnvelope(chainSlug, collectionSlug),
          listings,
        },
        { headers: { "Cache-Control": "no-store" } }
      );
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (/403|rate limit|-2006/i.test(msg)) {
        const { fetchOrdinalsWalletCatalog } = await import("@/lib/market/multichain/adapters/ordinalswallet-catalog");
        const ow = await fetchOrdinalsWalletCatalog(collectionSlug).catch(() => ({ listings: [] }));
        return NextResponse.json(
          {
            collection: await collectionEnvelope(chainSlug, collectionSlug),
            listings: mapBitcoinListings(collectionSlug, chainSlug, ow.listings, false, "ordinals-wallet"),
            listingsUnavailable: "unisat-rate-limit",
          },
          { headers: { "Cache-Control": "no-store" } }
        );
      }
      return publicError(error, "Failed to load Bitcoin Ordinals listings");
    }
  }

  const chain = chainSlug ? foreignChainByChainSlug(chainSlug) : null;
  if (!chain) {
    return NextResponse.json({ error: `"${chainSlug}" is not a supported foreign chain` }, { status: 400 });
  }

  try {
    const key = await getOpenSeaApiKey();
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

    const [rawOrders, collectionMeta] = await Promise.all([
      fetchForeignAllListings({ chainSlug, collectionSlug: openSeaSlug, limit }),
      openSeaJson<{ name?: string; image_url?: string; contracts?: Array<{ address: string; chain: string }> }>(
        `/collections/${encodeURIComponent(openSeaSlug)}`,
        key
      ),
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
    const cheapestByToken = new Map<string, (typeof rawOrders)[number]>();
    for (const order of rawOrders) {
      const tokenId = order.parameters.offer[0]?.identifierOrCriteria;
      if (!tokenId) continue;
      const priceOf = (o: (typeof rawOrders)[number]) =>
        o.parameters.consideration.reduce((sum, c) => sum + BigInt(c.startAmount), BigInt(0));
      const existing = cheapestByToken.get(tokenId);
      if (!existing || priceOf(order) < priceOf(existing)) cheapestByToken.set(tokenId, order);
    }
    const orders = [...cheapestByToken.values()].sort((a, b) => {
      const pa = a.parameters.consideration.reduce((s, c) => s + BigInt(c.startAmount), BigInt(0));
      const pb = b.parameters.consideration.reduce((s, c) => s + BigInt(c.startAmount), BigInt(0));
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

    const artEntries = await Promise.all(
      distinctTokenIds.map(async (tokenId) => {
        const nft = await openSeaJson<{
          nft?: { name?: string; image_url?: string; traits?: Array<{ trait_type: string; value: string }> };
        }>(`/chain/${chain.openSeaChain}/contract/${contractAddress}/nfts/${tokenId}`, key);
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
      const priceWei = order.parameters.consideration
        .reduce((sum, c) => sum + BigInt(c.startAmount), BigInt(0))
        .toString();
      const art = artByToken.get(tokenId);
      return {
        id: order.orderHash,
        collectionSlug,
        tokenId,
        tokenName: art?.name ?? undefined,
        maker: order.parameters.offerer,
        priceWei,
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
