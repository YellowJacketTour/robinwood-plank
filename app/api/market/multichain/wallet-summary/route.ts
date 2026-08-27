/**
 * The wallet-scoped data behind the GLOBAL (all-chains) My NFTs, My
 * Listings, and Offers tabs -- one combined route so the fan-out bound
 * lives in exactly one place, server-side.
 *
 * WHY THIS FANS OUT AT ALL: owned-all/route.ts gives real owned tokens per
 * chain+contract, but fetchForeignCollectionOffers/fetchForeignAllListings
 * (the only real sources for offers/your-listings) are keyed by OpenSea
 * COLLECTION SLUG, not contract address. Confirmed live 2026-08-18: GET
 * /chain/{chain}/contract/{address} resolves a real contract to its real
 * slug (e.g. GRiBBiTS's Base address -> "gribbits"). So the real pipeline
 * is: owned tokens -> distinct (chain, contract) pairs -> resolve each to
 * a slug -> fetch that collection's offers + this wallet's own listings.
 *
 * BOUNDED, LOGGED-IN-COMMENT, NOT SILENT: a wallet that touches many
 * foreign collections would otherwise fan out unboundedly. Capped to the
 * first MAX_COLLECTIONS distinct collections (by owned-token order) --
 * same bounding discipline as listings/route.ts's MAX_ART_LOOKUPS. If a
 * wallet is truncated, `truncated: true` is returned so the UI can say so
 * rather than silently showing a partial picture as if it were complete.
 */
import { NextRequest, NextResponse } from "next/server";
import { FOREIGN_CHAINS, foreignChainByChainSlug } from "@/lib/market/multichain/trading/foreign-chain-registry";
import { fetchForeignAllListings, fetchForeignCollectionOffers } from "@/lib/market/multichain/trading/foreign-orders";
import { pickOpenSeaKey } from "@/lib/market/multichain/discovery/opensea-key-pool";
import { pickAlchemyKey } from "@/lib/market/multichain/discovery/alchemy-key-pool";
import { publicError, rateLimit } from "@/lib/security";
import { resolveOwnedTokenIds } from "@/lib/market/multichain/owned-token-resolver";
import { ROBINHOOD_RPC_URLS } from "@/lib/mint-contract";
import { listTrackedCollections } from "@/lib/market/multichain/store";
import { getListings, getOffers } from "@/lib/market/orders-store";
import { ROBINHOOD_CHAIN_SLUG, isRobinhoodChainSlug } from "@/lib/market/multichain/trading/non-evm-chains";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const OPENSEA = "https://api.opensea.io/api/v2";
const MAX_COLLECTIONS = 10;

const ALCHEMY_SUBDOMAIN: Record<string, string> = {
  "eth-mainnet": "eth-mainnet",
  "polygon-mainnet": "polygon-mainnet",
  "arb-mainnet": "arb-mainnet",
  "base-mainnet": "base-mainnet",
  "opt-mainnet": "opt-mainnet",
  "bnb-mainnet": "bnb-mainnet",
  "avax-mainnet": "avax-mainnet",
};

type OwnedItem = { chainSlug: string; contractAddress: string; collectionName: string | null; tokenId: string };

async function fetchOwnedAll(owner: string): Promise<OwnedItem[]> {
  const apiKey = (await pickAlchemyKey("live"))?.apiKey || "demo";
  const results = await Promise.all(
    FOREIGN_CHAINS.map(async (chain): Promise<OwnedItem[]> => {
      const subdomain = ALCHEMY_SUBDOMAIN[chain.chainSlug];
      if (!subdomain) return [];
      try {
        const url = new URL(`https://${subdomain}.g.alchemy.com/nft/v3/${apiKey}/getNFTsForOwner`);
        url.searchParams.set("owner", owner);
        url.searchParams.set("withMetadata", "true");
        url.searchParams.set("pageSize", "50");
        const res = await fetch(url.toString());
        if (!res.ok) return [];
        const data = (await res.json()) as {
          ownedNfts?: Array<{ tokenId: string; contract?: { address: string; name?: string | null } }>;
        };
        return (data.ownedNfts ?? []).map((n) => ({
          chainSlug: chain.chainSlug,
          contractAddress: n.contract?.address ?? "",
          collectionName: n.contract?.name ?? null,
          tokenId: n.tokenId,
        }));
      } catch {
        return [];
      }
    })
  );
  return results.flat();
}

/**
 * Robinhood-Chain counterpart of fetchOwnedAll -- the home chain has no
 * Alchemy NFT-API coverage (it's a private L3, see owned/route.ts's own
 * header), so ownership is resolved via the SAME raw-RPC path that route
 * already built for the single-collection "My tokens" tab
 * (resolveOwnedTokenIds, now exported from there rather than duplicated
 * here). Run once per Robinhood-Chain collection this deployment tracks
 * (plank_multichain_collections, via listTrackedCollections), bounded to
 * MAX_COLLECTIONS same as the foreign fan-out -- a wallet touching many
 * auto-discovered collections still can't blow up one request.
 */
async function fetchOwnedRobinhood(owner: string): Promise<{ owned: OwnedItem[]; truncated: boolean }> {
  const rpcUrl = ROBINHOOD_RPC_URLS[0];
  if (!rpcUrl) return { owned: [], truncated: false };

  const tracked = await listTrackedCollections().catch(() => []);
  const robinhoodCollections = tracked.filter((c) => isRobinhoodChainSlug(c.chainSlug));
  const truncated = robinhoodCollections.length > MAX_COLLECTIONS;
  const bounded = robinhoodCollections.slice(0, MAX_COLLECTIONS);

  const results = await Promise.all(
    bounded.map(async (c): Promise<OwnedItem[]> => {
      try {
        const tokenIds = await resolveOwnedTokenIds(rpcUrl, c.contractAddress, owner);
        return tokenIds.map((tokenId) => ({
          chainSlug: ROBINHOOD_CHAIN_SLUG,
          contractAddress: c.contractAddress,
          collectionName: c.name,
          tokenId,
        }));
      } catch {
        return [];
      }
    })
  );
  return { owned: results.flat(), truncated };
}

/**
 * Robinhood-Chain counterpart of the foreign myListings/offers fan-out.
 * Native orders (lib/market/orders-store.ts) are keyed by collection slug,
 * and for an auto-discovered collection that slug IS the contract address
 * (see getCollectionAsync's own comment on why) -- so no extra slug
 * resolution step is needed here the way the foreign branch needs OpenSea's
 * contract->slug lookup. `getListings`/`getOffers` never throw (proven in
 * test/market/multichain-robinhood-branch.test.ts), so no per-collection
 * try/catch is needed either.
 */
async function fetchRobinhoodMakerActivity(
  owner: string,
  collections: Array<{ contractAddress: string; name: string | null }>
): Promise<{
  myListings: Array<{ chainSlug: string; collectionName: string | null; tokenId: string; priceWei: string }>;
  offers: Array<{ chainSlug: string; collectionName: string | null; priceWei: string; maker: string }>;
}> {
  const perCollection = await Promise.all(
    collections.map(async (c) => {
      const [listings, collectionOffers] = await Promise.all([
        getListings(c.contractAddress),
        getOffers(c.contractAddress),
      ]);
      const mine = listings
        .filter((l) => l.maker.toLowerCase() === owner.toLowerCase())
        .map((l) => ({ chainSlug: ROBINHOOD_CHAIN_SLUG, collectionName: c.name, tokenId: l.tokenId, priceWei: l.priceWei }));
      // Every offer on a collection the wallet holds tokens in -- same
      // "offers on what you own" semantics the foreign branch already uses
      // (collectionOffers isn't filtered by maker, myListings is).
      const bids = collectionOffers.map((o) => ({
        chainSlug: ROBINHOOD_CHAIN_SLUG,
        collectionName: c.name,
        priceWei: o.priceWei,
        maker: o.maker,
      }));
      return { mine, bids };
    })
  );
  return {
    myListings: perCollection.flatMap((p) => p.mine),
    offers: perCollection.flatMap((p) => p.bids),
  };
}

export async function GET(req: NextRequest) {
  const limited = rateLimit(req, { key: "market-multichain-wallet-summary", limit: 15, windowMs: 60_000 });
  if (limited) return limited;

  const { searchParams } = new URL(req.url);
  const owner = searchParams.get("owner");
  if (!owner) {
    return NextResponse.json({ error: "owner is required" }, { status: 400 });
  }

  try {
    const key = (await pickOpenSeaKey("live"))?.apiKey ?? null;
    const [foreignOwned, robinhoodOwned] = await Promise.all([fetchOwnedAll(owner), fetchOwnedRobinhood(owner)]);
    const owned = [...foreignOwned, ...robinhoodOwned.owned];

    const distinctCollections = new Map<string, { chainSlug: string; contractAddress: string; collectionName: string | null }>();
    for (const item of owned) {
      if (!item.contractAddress) continue;
      const key2 = `${item.chainSlug}:${item.contractAddress.toLowerCase()}`;
      if (!distinctCollections.has(key2)) {
        distinctCollections.set(key2, { chainSlug: item.chainSlug, contractAddress: item.contractAddress, collectionName: item.collectionName });
      }
    }
    const collectionEntries = [...distinctCollections.values()];
    const truncated = collectionEntries.length > MAX_COLLECTIONS || robinhoodOwned.truncated;
    const bounded = collectionEntries.slice(0, MAX_COLLECTIONS);
    // Robinhood-Chain collections are bounded independently by
    // fetchOwnedRobinhood itself (its own MAX_COLLECTIONS pass over
    // listTrackedCollections) -- re-derive the maker-activity input from
    // THAT same bounded set rather than `bounded` above, since `bounded`
    // mixes both chains' entries under one shared cap and could otherwise
    // starve Robinhood Chain out entirely on a wallet with many foreign
    // holdings.
    const robinhoodMakerCollections = [...distinctCollections.values()]
      .filter((c) => isRobinhoodChainSlug(c.chainSlug))
      .map((c) => ({ contractAddress: c.contractAddress, name: c.collectionName }));

    let myListings: Array<{ chainSlug: string; collectionName: string | null; tokenId: string; priceWei: string }> = [];
    let offers: Array<{ chainSlug: string; collectionName: string | null; priceWei: string; maker: string }> = [];

    if (key && bounded.length > 0) {
      const resolved = await Promise.all(
        bounded.map(async (c) => {
          if (!foreignChainByChainSlug(c.chainSlug)) return null;
          const chain = foreignChainByChainSlug(c.chainSlug)!;
          // No OpenSea orderbook for this chain (zkSync today) -- would
          // otherwise silently degrade to a doomed `/chain/null/contract/...`
          // request; skip explicitly instead of wasting the round trip.
          if (!chain.openSeaChain) return null;
          try {
            const res = await fetch(`${OPENSEA}/chain/${chain.openSeaChain}/contract/${c.contractAddress}`, {
              headers: { "x-api-key": key, accept: "application/json" },
            });
            if (!res.ok) return null;
            const data = (await res.json()) as { collection?: string };
            if (!data.collection) return null;
            return { ...c, collectionSlug: data.collection };
          } catch {
            return null;
          }
        })
      );
      const withSlug = resolved.filter((r): r is NonNullable<typeof r> => r !== null);

      const perCollection = await Promise.all(
        withSlug.map(async (c) => {
          const [listings, collectionOffers] = await Promise.all([
            fetchForeignAllListings({ chainSlug: c.chainSlug, collectionSlug: c.collectionSlug, limit: 50 }).catch(() => []),
            fetchForeignCollectionOffers({ chainSlug: c.chainSlug, collectionSlug: c.collectionSlug, limit: 10 }).catch(() => []),
          ]);
          const mine = listings
            .filter((o) => o.parameters.offerer.toLowerCase() === owner.toLowerCase())
            .map((o) => ({
              chainSlug: c.chainSlug,
              collectionName: c.collectionName,
              tokenId: o.parameters.offer[0]?.identifierOrCriteria ?? "",
              priceWei: o.parameters.consideration.reduce((sum, cons) => sum + BigInt(cons.startAmount), BigInt(0)).toString(),
            }));
          const bids = collectionOffers.map((o) => ({
            chainSlug: c.chainSlug,
            collectionName: c.collectionName,
            priceWei: o.parameters.offer[0]?.startAmount ?? "0",
            maker: o.parameters.offerer,
          }));
          return { mine, bids };
        })
      );
      myListings = perCollection.flatMap((p) => p.mine);
      offers = perCollection.flatMap((p) => p.bids);
    }

    // Robinhood Chain never needs the OpenSea key gate the foreign branch
    // above is wrapped in -- native orders come from our own store, not
    // OpenSea -- so this runs unconditionally whenever the wallet holds any
    // tracked Robinhood-Chain collection.
    if (robinhoodMakerCollections.length > 0) {
      const robinhood = await fetchRobinhoodMakerActivity(owner, robinhoodMakerCollections);
      myListings = [...myListings, ...robinhood.myListings];
      offers = [...offers, ...robinhood.offers];
    }
    offers = offers.sort((a, b) => (BigInt(a.priceWei) < BigInt(b.priceWei) ? 1 : -1));

    return NextResponse.json(
      {
        ownedItems: owned,
        distinctCollectionCount: collectionEntries.length,
        truncated,
        myListings,
        offers,
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    return publicError(error, "Failed to load your wallet's multichain summary");
  }
}
