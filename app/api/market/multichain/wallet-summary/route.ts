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
import { getOpenSeaApiKey } from "@/lib/market/opensea";
import { publicError, rateLimit } from "@/lib/security";

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
  const apiKey = process.env.ALCHEMY_API_KEY?.trim() || "demo";
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

export async function GET(req: NextRequest) {
  const limited = rateLimit(req, { key: "market-multichain-wallet-summary", limit: 15, windowMs: 60_000 });
  if (limited) return limited;

  const { searchParams } = new URL(req.url);
  const owner = searchParams.get("owner");
  if (!owner) {
    return NextResponse.json({ error: "owner is required" }, { status: 400 });
  }

  try {
    const key = await getOpenSeaApiKey();
    const owned = await fetchOwnedAll(owner);

    const distinctCollections = new Map<string, { chainSlug: string; contractAddress: string; collectionName: string | null }>();
    for (const item of owned) {
      if (!item.contractAddress) continue;
      const key2 = `${item.chainSlug}:${item.contractAddress.toLowerCase()}`;
      if (!distinctCollections.has(key2)) {
        distinctCollections.set(key2, { chainSlug: item.chainSlug, contractAddress: item.contractAddress, collectionName: item.collectionName });
      }
    }
    const collectionEntries = [...distinctCollections.values()];
    const truncated = collectionEntries.length > MAX_COLLECTIONS;
    const bounded = collectionEntries.slice(0, MAX_COLLECTIONS);

    let myListings: Array<{ chainSlug: string; collectionName: string | null; tokenId: string; priceWei: string }> = [];
    let offers: Array<{ chainSlug: string; collectionName: string | null; priceWei: string; maker: string }> = [];

    if (key && bounded.length > 0) {
      const resolved = await Promise.all(
        bounded.map(async (c) => {
          if (!foreignChainByChainSlug(c.chainSlug)) return null;
          const chain = foreignChainByChainSlug(c.chainSlug)!;
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
      offers = perCollection.flatMap((p) => p.bids).sort((a, b) => (BigInt(a.priceWei) < BigInt(b.priceWei) ? 1 : -1));
    }

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
