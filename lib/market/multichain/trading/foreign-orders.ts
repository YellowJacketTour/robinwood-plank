/**
 * Real, fulfillable Seaport orders from OpenSea's orderbook for a foreign
 * (non-Robinhood-Chain) collection -- the data source this app never had
 * before, since it only ever ran its own orderbook for its own chain.
 *
 * Verified live 2026-08-17 (real key, not the free/scoped agent key): GET
 * /api/v2/listings/collection/{slug}/best?chain={openSeaChain} returns a
 * real order for GRiBBiTS on Base with a full protocol_data payload --
 * offerer, offer, consideration, conduitKey, salt, zone, etc. -- the exact
 * shape lib/market/seaport.ts's fulfillOrder() already knows how to
 * execute, because it IS a Seaport order (see foreign-chain-registry.ts's
 * header for why the same protocol/contracts work on every chain here).
 *
 * NOT YET WIRED TO EXECUTION. This module only fetches and shapes the order
 * data -- it does not sign, submit, or otherwise touch a wallet. Wiring a
 * "Buy Now" button on a foreign chain to lib/market/seaport.ts's
 * fulfillOrder() using this order data is the next step, deliberately kept
 * separate so this read path can be verified on its own first.
 */
import { getOpenSeaApiKey } from "@/lib/market/opensea";
import { foreignChainByChainSlug } from "@/lib/market/multichain/trading/foreign-chain-registry";

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
  }>(`/listings/collection/${encodeURIComponent(input.collectionSlug)}/best?chain=${chain.openSeaChain}&limit=${input.count}`);
  return (result?.listings ?? []).map((l) => ({
    orderHash: l.order_hash,
    chain: l.chain,
    parameters: l.protocol_data.parameters,
    signature: l.protocol_data.signature,
  }));
}
