/**
 * Real, fulfillable Seaport orders from OpenSea's orderbook for a foreign
 * (non-Robinhood-Chain) collection -- the data source this app never had
 * before, since it only ever ran its own orderbook for its own chain.
 *
 * CRITICAL, verified live 2026-08-17 end-to-end against a fork of real Base
 * mainnet chain state (scripts/verify-foreign-fee-router-fork.ts): the
 * `signature` field on EVERY order returned by fetchBestForeignListing /
 * fetchForeignFloorListings / fetchForeignAllListings / etc. is
 * SYSTEMATICALLY NULL -- checked across 9 different real, currently-active
 * top-volume Base collections, not one anomalous seller. Those functions
 * are DISCOVERY/DISPLAY endpoints (what's listed, roughly what it costs),
 * not execution data. The real, genuinely fulfillable, signed order MUST
 * be fetched via fetchListingFulfillmentData() immediately before building
 * a transaction, using the actual connected wallet's address -- proven via
 * a full real transaction on a forked chain: real order -> real signature
 * -> real Seaport fulfillment -> real NFT transfer -> real fee to
 * treasury, zero balance left in the router.
 *
 * TWO MORE REAL QUIRKS THIS MODULE NORMALIZES (found via that same live
 * run, not assumed from docs):
 * - zoneHash sometimes comes back with one extra byte of zero-padding (68
 *   hex chars instead of a real bytes32's 64) -- normalizeZoneHash() below
 *   fixes this once, for every caller.
 * - A caller executing against a LOCAL FORK (for testing) must also
 *   correct two more things Seaport itself is strict about: the fork's
 *   chainId must match the real chain (Seaport recomputes its EIP-712
 *   domain separator from block.chainid, so a mismatched fork chainId
 *   makes every real signature fail InvalidSigner()), and the fork's next
 *   block timestamp must be advanced to real wall-clock time (a forked
 *   chain's mined-block timestamp does not track real time on its own,
 *   and Seaport's own InvalidTime() will reject an order whose startTime
 *   the fork hasn't "reached" yet even though it has on the real chain).
 *   Both are handled in the verification script; a live UI calling the
 *   REAL chain via a REAL wallet never hits either issue, since a real
 *   chain always reports its own correct chainId and timestamp.
 *
 * NOT YET WIRED TO A UI. This module fetches and shapes order data; a
 * client-side "Buy Now"/"Sweep"/"Offer" component calling
 * MarketplankForeignFeeRouter with a connected wallet (the same
 * server-prepares/client-signs split lib/market/seaport.ts's own
 * confirmBuy already uses on Robinhood Chain) is the next step.
 */
import { getOpenSeaApiKey } from "@/lib/market/opensea";
import { foreignChainByChainSlug, FOREIGN_SEAPORT_ADDRESS } from "@/lib/market/multichain/trading/foreign-chain-registry";

const BASE = "https://api.opensea.io/api/v2";

/** The subset of Seaport's OrderParameters this app actually needs downstream -- not OpenSea's full response shape. */
export type SeaportOrderParameters = {
  offerer: string;
  offer: Array<{ itemType: number; token: string; identifierOrCriteria: string; startAmount: string; endAmount: string }>;
  consideration: Array<{ itemType: number; token: string; identifierOrCriteria: string; startAmount: string; endAmount: string; recipient: string }>;
  startTime: string;
  endTime: string;
  orderType: number;
  zone: string;
  zoneHash: string;
  salt: string;
  conduitKey: string;
  totalOriginalConsiderationItems: number;
  counter: number;
};

export type ForeignSeaportOrder = {
  orderHash: string;
  chain: string;
  parameters: SeaportOrderParameters;
  signature: string | null;
};

async function openSeaFetch<T>(path: string): Promise<T | null> {
  const key = await getOpenSeaApiKey();
  if (!key) {
    throw new Error("foreign-orders: no OpenSea API key available (set OPENSEA_API_KEY or let the managed-key cron issue one)");
  }
  const res = await fetch(`${BASE}${path}`, { headers: { "x-api-key": key, accept: "application/json" } });
  if (res.status === 404) return null; // no order exists -- a real, expected state, not an error
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`foreign-orders: OpenSea ${res.status} fetching ${path} -- ${body.slice(0, 200)}`);
  }
  return (await res.json()) as T;
}

async function openSeaPost<T>(path: string, body: unknown): Promise<T> {
  const key = await getOpenSeaApiKey();
  if (!key) {
    throw new Error("foreign-orders: no OpenSea API key available (set OPENSEA_API_KEY or let the managed-key cron issue one)");
  }
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "x-api-key": key, "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const responseBody = await res.text().catch(() => "");
    throw new Error(`foreign-orders: OpenSea ${res.status} posting ${path} -- ${responseBody.slice(0, 300)}`);
  }
  return (await res.json()) as T;
}

/**
 * Seaport's own zoneHash sometimes comes back from OpenSea with one extra
 * byte of zero-padding (68 hex chars instead of a real bytes32's 64) --
 * confirmed live 2026-08-17 against real GRiBBiTS orders on Base. Normalize
 * defensively here, once, rather than in every caller.
 */
function normalizeZoneHash(zoneHash: string): string {
  const hex = zoneHash.replace(/^0x/, "");
  return "0x" + hex.slice(-64).padStart(64, "0");
}

/**
 * THE REAL FULFILLABLE ORDER -- what actually gets signed and passed to
 * MarketplankForeignFeeRouter, as opposed to fetchBestForeignListing's
 * summary/display data.
 *
 * WHY THIS SEPARATE CALL EXISTS
 * -------------------------------
 * Confirmed live 2026-08-17, systematically, across every listing checked
 * on 9 different real, currently-active top-volume Base collections (not
 * one anomalous seller): /listings/collection/{slug}/best's protocol_data
 * ALWAYS returns signature: null. That endpoint is a summary/ranking view,
 * not a fulfillment source. OpenSea's own documented endpoint for this is
 * POST /listings/{listing_hash}/fulfillment_data (per docs.opensea.io),
 * which requires the REAL fulfiller's address and returns a genuinely
 * signed order -- verified live: a real 65-byte ECDSA signature, matching
 * this module's ForeignSeaportOrder shape exactly ({parameters,
 * signature} inside fulfillment_data.orders[0]).
 *
 * This is why fetchBestForeignListing/fetchForeignFloorListings/etc. exist
 * for DISCOVERY (what's listed, roughly what it costs) while THIS function
 * is the one that must be called immediately before actually building a
 * transaction, with the real connected wallet's address, since the
 * returned order is specific to that fulfiller.
 */
export async function fetchListingFulfillmentData(input: {
  chainSlug: string;
  orderHash: string;
  fulfillerAddress: string;
}): Promise<ForeignSeaportOrder> {
  const chain = foreignChainByChainSlug(input.chainSlug);
  if (!chain) {
    throw new Error(`foreign-orders: "${input.chainSlug}" is not in FOREIGN_CHAINS (see foreign-chain-registry.ts)`);
  }
  const result = await openSeaPost<{
    fulfillment_data: {
      orders: Array<{ parameters: SeaportOrderParameters; signature: string }>;
    };
  }>("/listings/fulfillment_data", {
    listing: { hash: input.orderHash, chain: chain.openSeaChain, protocol_address: FOREIGN_SEAPORT_ADDRESS },
    fulfiller: { address: input.fulfillerAddress },
  });
  const order = result.fulfillment_data.orders[0];
  if (!order) {
    throw new Error(`foreign-orders: fulfillment_data returned no orders for ${input.orderHash}`);
  }
  return {
    orderHash: input.orderHash,
    chain: chain.openSeaChain,
    parameters: { ...order.parameters, zoneHash: normalizeZoneHash(order.parameters.zoneHash) },
    signature: order.signature,
  };
}

/**
 * The cheapest currently-fulfillable buy-now listing for a collection on a
 * foreign chain, or null if none exists right now (not an error state --
 * most collections have quiet stretches with zero active listings).
 */
export async function fetchBestForeignListing(input: {
  chainSlug: string;
  collectionSlug: string;
}): Promise<ForeignSeaportOrder | null> {
  const chain = foreignChainByChainSlug(input.chainSlug);
  if (!chain) {
    throw new Error(`foreign-orders: "${input.chainSlug}" is not in FOREIGN_CHAINS (see foreign-chain-registry.ts)`);
  }
  const result = await openSeaFetch<{
    listings: Array<{
      order_hash: string;
      chain: string;
      protocol_data: { parameters: SeaportOrderParameters; signature: string | null };
    }>;
  }>(`/listings/collection/${encodeURIComponent(input.collectionSlug)}/best?chain=${chain.openSeaChain}&limit=1`);
  const first = result?.listings?.[0];
  if (!first) return null;
  return {
    orderHash: first.order_hash,
    chain: first.chain,
    parameters: first.protocol_data.parameters,
    signature: first.protocol_data.signature,
  };
}

/**
 * The N cheapest listings for a collection on a foreign chain -- the
 * primitive a sweep needs (fetch several fulfillable orders, then hand them
 * to Seaport's fulfillAvailableAdvancedOrders the same way
 * lib/market/seaport.ts's sweepFloor() already does for Robinhood Chain).
 */
export async function fetchForeignFloorListings(input: {
  chainSlug: string;
  collectionSlug: string;
  count: number;
}): Promise<ForeignSeaportOrder[]> {
  const listings = await listingsRequest(input.chainSlug, input.collectionSlug, `limit=${input.count}`);
  return listings;
}

/** One trait clause, same shape as lib/market/trait-criteria.ts's TraitClause so callers can share one type across the Robinhood-chain and foreign-chain paths. */
export type ForeignTraitClause = { traitType: string; value: string };

function encodeTraits(traits: ForeignTraitClause[]): string {
  return encodeURIComponent(JSON.stringify(traits.map((t) => ({ traitType: t.traitType, value: t.value }))));
}

/**
 * OpenSea's /best listings endpoint PADS results with duplicate token ids
 * when fewer distinct matches exist than the requested limit -- confirmed
 * live 2026-08-17: requesting 5 trait-filtered GRiBBiTS listings with only
 * 2 real distinct matches returned [541, 541, 2943, 2943, 541]. Left
 * undeduped, a sweep built on this would attempt to buy the same NFT
 * twice. Every caller of listingsRequest goes through this dedup by
 * (token contract, identifierOrCriteria) so that bug class can't leak past
 * this module.
 */
function dedupeByToken(orders: ForeignSeaportOrder[]): ForeignSeaportOrder[] {
  const seen = new Set<string>();
  const result: ForeignSeaportOrder[] = [];
  for (const order of orders) {
    const item = order.parameters.offer[0];
    const key = item ? `${item.token.toLowerCase()}:${item.identifierOrCriteria}` : order.orderHash;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(order);
  }
  return result;
}

async function listingsRequest(chainSlug: string, collectionSlug: string, extraParams: string): Promise<ForeignSeaportOrder[]> {
  const chain = foreignChainByChainSlug(chainSlug);
  if (!chain) {
    throw new Error(`foreign-orders: "${chainSlug}" is not in FOREIGN_CHAINS (see foreign-chain-registry.ts)`);
  }
  const result = await openSeaFetch<{
    listings: Array<{
      order_hash: string;
      chain: string;
      protocol_data: { parameters: SeaportOrderParameters; signature: string | null };
    }>;
  }>(`/listings/collection/${encodeURIComponent(collectionSlug)}/best?chain=${chain.openSeaChain}&${extraParams}`);
  return dedupeByToken(
    (result?.listings ?? []).map((l) => ({
      orderHash: l.order_hash,
      chain: l.chain,
      parameters: l.protocol_data.parameters,
      signature: l.protocol_data.signature,
    }))
  );
}

/**
 * Fulfillable listings for a collection ON A FOREIGN CHAIN, narrowed to
 * items matching ALL given trait clauses (AND-combined -- confirmed live,
 * matches lib/market/trait-criteria.ts's existing AND semantics for
 * Robinhood Chain, so a "filtered sweep" behaves identically regardless of
 * which chain it's running against). Verified live 2026-08-17 against
 * GRiBBiTS on Base: filtering by {traitType:"Frog", value:"Purple Frog"}
 * correctly returned only the matching token (id 541), not the whole
 * collection's listings.
 */
export async function fetchForeignTraitFilteredListings(input: {
  chainSlug: string;
  collectionSlug: string;
  traits: ForeignTraitClause[];
  count: number;
}): Promise<ForeignSeaportOrder[]> {
  if (input.traits.length === 0) {
    return fetchForeignFloorListings({ chainSlug: input.chainSlug, collectionSlug: input.collectionSlug, count: input.count });
  }
  return listingsRequest(input.chainSlug, input.collectionSlug, `limit=${input.count}&traits=${encodeTraits(input.traits)}`);
}

/**
 * ALL currently-active listings for a collection on a foreign chain
 * (OpenSea's /listings/.../all, distinct from /best which is capped/sorted
 * for quick reads) -- for a true full-collection sweep rather than a
 * top-N-cheapest one. Confirmed live and structurally distinct from
 * fetchForeignFloorListings's /best call.
 */
export async function fetchForeignAllListings(input: {
  chainSlug: string;
  collectionSlug: string;
  limit?: number;
}): Promise<ForeignSeaportOrder[]> {
  const chain = foreignChainByChainSlug(input.chainSlug);
  if (!chain) {
    throw new Error(`foreign-orders: "${input.chainSlug}" is not in FOREIGN_CHAINS (see foreign-chain-registry.ts)`);
  }
  const result = await openSeaFetch<{
    listings: Array<{
      order_hash: string;
      chain: string;
      protocol_data: { parameters: SeaportOrderParameters; signature: string | null };
    }>;
  }>(`/listings/collection/${encodeURIComponent(input.collectionSlug)}/all?chain=${chain.openSeaChain}${input.limit ? `&limit=${input.limit}` : ""}`);
  return (result?.listings ?? []).map((l) => ({
    orderHash: l.order_hash,
    chain: l.chain,
    parameters: l.protocol_data.parameters,
    signature: l.protocol_data.signature,
  }));
}

/**
 * Collection-wide offers on a foreign chain (criteria orders -- a bidder
 * offering to buy ANY item in the collection, itemType 4/
 * ERC721_WITH_CRITERIA in the consideration, confirmed live). This is the
 * "offers" half of the trading surface: what a seller could accept right
 * now, as opposed to fetchBestForeignListing's "what a buyer could buy
 * right now."
 */
export async function fetchForeignCollectionOffers(input: {
  chainSlug: string;
  collectionSlug: string;
  limit?: number;
}): Promise<ForeignSeaportOrder[]> {
  const chain = foreignChainByChainSlug(input.chainSlug);
  if (!chain) {
    throw new Error(`foreign-orders: "${input.chainSlug}" is not in FOREIGN_CHAINS (see foreign-chain-registry.ts)`);
  }
  const result = await openSeaFetch<{
    offers: Array<{
      order_hash: string;
      chain: string;
      protocol_data: { parameters: SeaportOrderParameters; signature: string | null };
    }>;
  }>(`/offers/collection/${encodeURIComponent(input.collectionSlug)}?chain=${chain.openSeaChain}${input.limit ? `&limit=${input.limit}` : ""}`);
  return (result?.offers ?? []).map((o) => ({
    orderHash: o.order_hash,
    chain: o.chain,
    parameters: o.protocol_data.parameters,
    signature: o.protocol_data.signature,
  }));
}

/**
 * Trait-scoped offers on a foreign chain -- a bidder offering to buy any
 * item matching a specific trait (e.g. "any Purple Frog"), the offer-side
 * counterpart to fetchForeignTraitFilteredListings. Confirmed live: GET
 * /offers/collection/{slug}/traits with mode=STRING&type=&value= returns a
 * real (possibly empty -- most traits have no active bid at any moment,
 * which is expected market state, not an error) offers array.
 */
export async function fetchForeignTraitOffers(input: {
  chainSlug: string;
  collectionSlug: string;
  trait: ForeignTraitClause;
}): Promise<ForeignSeaportOrder[]> {
  const chain = foreignChainByChainSlug(input.chainSlug);
  if (!chain) {
    throw new Error(`foreign-orders: "${input.chainSlug}" is not in FOREIGN_CHAINS (see foreign-chain-registry.ts)`);
  }
  const result = await openSeaFetch<{
    offers: Array<{
      order_hash: string;
      chain: string;
      protocol_data: { parameters: SeaportOrderParameters; signature: string | null };
    }>;
  }>(
    `/offers/collection/${encodeURIComponent(input.collectionSlug)}/traits?chain=${chain.openSeaChain}` +
      `&mode=STRING&type=${encodeURIComponent(input.trait.traitType)}&value=${encodeURIComponent(input.trait.value)}`
  );
  return (result?.offers ?? []).map((o) => ({
    orderHash: o.order_hash,
    chain: o.chain,
    parameters: o.protocol_data.parameters,
    signature: o.protocol_data.signature,
  }));
}
