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
 * foreign collections would otherwise fan out unboundedly. Capped to
 * MAX_COLLECTIONS distinct collections per request (by owned-token order) --
 * same bounding discipline as listings/route.ts's MAX_ART_LOOKUPS. If a
 * wallet is truncated, `truncated: true` is returned so the UI can say so
 * rather than silently showing a partial picture as if it were complete.
 *
 * THE CEILING BEHIND THAT HONEST FLAG, REMOVED 2026-09-11
 * ------------------------------------------------------
 * `truncated: true` was true and useless. There was no continuation
 * parameter of any kind, so a wallet holding NFTs across 11+ collections saw
 * offers and listings for its first 10 and collections 11..N were unreachable
 * FOREVER -- not with a different query, not at a different URL, not by any
 * sequence of calls. Honest and unrecoverable is still a ceiling; this repo
 * already paid for the identical mistake in the foreign listings book (see
 * test/market/listings-cursor-uncapped.test.ts, which says "Honest and useless
 * is still useless" about `complete: false`).
 *
 * MAX_COLLECTIONS survives untouched, because it IS pacing: each collection in
 * the window costs one OpenSea contract->slug lookup plus a listings call plus
 * an offers call, and the wallet-summary rate limit is 15/min. What changed is
 * that the window now MOVES. `?offset=N` starts the fan-out at the Nth distinct
 * collection, and the response reports `collectionOffset`, `nextOffset` (null
 * iff this window reached the end) and `distinctCollectionCount`, so a client
 * can walk every collection it holds.
 *
 * The offset applies to the DISTINCT-COLLECTION list, which is derived from
 * owned tokens in a stable order (chain registry order, then Alchemy's own
 * per-chain ordering, then the tracked-collection list for Robinhood Chain).
 * Ownership changes between calls can shift that list, exactly as it can for
 * any offset pager over live data; the alternative -- no continuation at all --
 * was strictly worse.
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
import { edgeRead } from "@/lib/market/multichain/edge/read-gateway";
import { meteredFetch } from "@/lib/market/multichain/edge/provider-ledger";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const OPENSEA = "https://api.opensea.io/api/v2";
/** PACING, not a ceiling: the per-request fan-out width. Each unit of this is
 * ~3 vendor round trips (OpenSea slug resolve + listings + offers), so this
 * keeps one request inside its deadline and inside the key pool's quota. The
 * result set it pages over is unbounded -- see ?offset in the header. */
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
  const keyEntry = await pickAlchemyKey("live");
  const apiKey = keyEntry?.apiKey || "demo";
  const results = await Promise.all(
    FOREIGN_CHAINS.map(async (chain): Promise<OwnedItem[]> => {
      const subdomain = ALCHEMY_SUBDOMAIN[chain.chainSlug];
      if (!subdomain) return [];
      try {
        // Same edge cell owned-all/route.ts uses, so the two routes share one
        // Alchemy call per (chain, wallet) per TTL window.
        const { value } = await edgeRead<OwnedItem[]>(
          { kind: "owned", chainSlug: chain.chainSlug, subject: owner.toLowerCase(), variant: { scope: "all", pageSize: 50 } },
          async () => {
            const url = new URL(`https://${subdomain}.g.alchemy.com/nft/v3/${apiKey}/getNFTsForOwner`);
            url.searchParams.set("owner", owner);
            url.searchParams.set("withMetadata", "true");
            url.searchParams.set("pageSize", "50");
            const res = await meteredFetch(url.toString(), undefined, { source: "alchemy-nft", keyId: keyEntry?.id ?? null, chainSlug: chain.chainSlug, costUnits: 480 });
            if (!res.ok) throw new Error(`Alchemy ${res.status}`);
            const data = (await res.json()) as {
              ownedNfts?: Array<{ tokenId: string; contract?: { address: string; name?: string | null } }>;
            };
            return (data.ownedNfts ?? []).map((n) => ({
              chainSlug: chain.chainSlug,
              contractAddress: n.contract?.address ?? "",
              collectionName: n.contract?.name ?? null,
              tokenId: n.tokenId,
            }));
          },
          { provider: "alchemy" }
        );
        return value;
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
 *
 * WINDOWED, NOT CAPPED (2026-09-11): this slice used to start at 0 on every
 * call, so a deployment tracking more than MAX_COLLECTIONS Robinhood-Chain
 * collections could never report ownership in the ones past the tenth. It now
 * takes the same `?offset` the foreign fan-out takes, and reports
 * `trackedCount` so the caller can see the size of the list it is walking
 * rather than inferring it from a boolean.
 */
async function fetchOwnedRobinhood(
  owner: string,
  offset: number
): Promise<{ owned: OwnedItem[]; truncated: boolean; trackedCount: number; scannedThrough: number }> {
  const rpcUrl = ROBINHOOD_RPC_URLS[0];
  if (!rpcUrl) return { owned: [], truncated: false, trackedCount: 0, scannedThrough: offset };

  const tracked = await listTrackedCollections().catch(() => []);
  const robinhoodCollections = tracked.filter((c) => isRobinhoodChainSlug(c.chainSlug));
  const bounded = robinhoodCollections.slice(offset, offset + MAX_COLLECTIONS);
  const scannedThrough = offset + bounded.length;
  const truncated = scannedThrough < robinhoodCollections.length;

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
  return { owned: results.flat(), truncated, trackedCount: robinhoodCollections.length, scannedThrough };
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

  // The continuation the old `truncated: true` had no answer for. Absent or
  // junk means 0, so every existing caller gets byte-compatible behaviour for
  // the first window.
  const requestedOffset = Number(searchParams.get("offset"));
  const offset = Number.isFinite(requestedOffset) && requestedOffset > 0 ? Math.trunc(requestedOffset) : 0;

  try {
    const keyEntry = await pickOpenSeaKey("live");
    const key = keyEntry?.apiKey ?? null;
    const [foreignOwned, robinhoodOwned] = await Promise.all([fetchOwnedAll(owner), fetchOwnedRobinhood(owner, offset)]);
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

    // TWO LANES, ONE OFFSET -- and the offset must be applied to each lane
    // EXACTLY ONCE.
    //
    // fetchOwnedRobinhood already windowed its own lane: `owned` contains only
    // the tracked Robinhood-Chain collections in [offset, offset+MAX), because
    // that lane is bounded at ownership-resolution time (one raw-RPC scan per
    // tracked collection). The foreign lane is NOT pre-windowed: fetchOwnedAll
    // returns every collection Alchemy reports across all chains, and the bound
    // is applied here, at the vendor fan-out.
    //
    // So the foreign window must be taken over the FOREIGN entries alone. The
    // first draft of this fix sliced the merged list, which skipped the
    // Robinhood rows a second time -- the tail-eating bug the offset exists to
    // remove, reintroduced by the fix for it.
    const foreignEntries = collectionEntries.filter((c) => !isRobinhoodChainSlug(c.chainSlug));
    const foreignWindow = foreignEntries.slice(offset, offset + MAX_COLLECTIONS);
    const foreignScannedThrough = offset + foreignWindow.length;
    const foreignTruncated = foreignScannedThrough < foreignEntries.length;
    const bounded = foreignWindow;

    // Truncated iff EITHER lane has more behind it. A caller that stopped when
    // only one lane ran out would silently skip the other lane's tail.
    const truncated = foreignTruncated || robinhoodOwned.truncated;
    // Where to resume. Both lanes advance by at most MAX_COLLECTIONS per call
    // and share the one offset, so the next window starts one page on -- but
    // never before a lane that is already exhausted would have it, which is why
    // this is a max over the two scan positions rather than `offset + MAX`.
    const nextOffset = truncated
      ? Math.max(foreignScannedThrough, robinhoodOwned.scannedThrough, offset + 1)
      : null;
    // Robinhood-Chain collections are bounded independently by
    // fetchOwnedRobinhood itself (its own offset+MAX_COLLECTIONS window over
    // listTrackedCollections), so every Robinhood entry that reached `owned`
    // is already inside this request's window and all of them belong here.
    // `bounded` above is deliberately NOT the source: it is the foreign lane's
    // window and contains no Robinhood rows at all.
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
            // Contract -> OpenSea slug changes on human timescales: one call
            // per contract per collection-meta window, shared by every wallet
            // that holds it.
            const { value: data } = await edgeRead<{ collection?: string }>(
              { kind: "collection-meta", chainSlug: c.chainSlug, subject: c.contractAddress, variant: { fact: "opensea-slug" } },
              async () => {
                const res = await meteredFetch(`${OPENSEA}/chain/${chain.openSeaChain}/contract/${c.contractAddress}`, {
                  headers: { "x-api-key": key, accept: "application/json" },
                }, { source: "opensea", keyId: keyEntry?.id ?? null, chainSlug: c.chainSlug });
                if (!res.ok) throw new Error(`OpenSea ${res.status}`);
                return (await res.json()) as { collection?: string };
              },
              { provider: "opensea" }
            );
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
        // WHAT MAKES `truncated` ACTIONABLE. Before these three fields it was a
        // statement with no follow-up question the caller could ask.
        collectionOffset: offset,
        // Non-null means "more collections remain, call again with this".
        // Null means every collection this wallet touches has been covered.
        nextOffset,
        // The fan-out width this response used, so a caller sees the pacing
        // bound rather than guessing it from the row counts.
        collectionPageSize: MAX_COLLECTIONS,
        // Size of the tracked Robinhood-Chain roster being walked, for the same
        // reason collection-search returns totalCount: a bounded scan over an
        // unknown-sized list cannot be interpreted.
        robinhoodTrackedCount: robinhoodOwned.trackedCount,
        myListings,
        offers,
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    return publicError(error, "Failed to load your wallet's multichain summary");
  }
}
