/**
 * Client-side wallet execution for foreign-chain trades -- the part
 * foreign-orders.ts (server-side order fetching) and
 * MarketplankForeignFeeRouter.sol (the contract) were both built for.
 *
 * DELIBERATELY CALLS OUR OWN API ROUTES, NEVER foreign-orders.ts DIRECTLY
 * ---------------------------------------------------------------------------
 * A first version of this file imported fetchListingFulfillmentData /
 * fetchForeignFloorListings from foreign-orders.ts directly. `next build`
 * caught the real bug that made: this is a client-side module (it signs
 * wallet transactions), and foreign-orders.ts's functions pull in
 * lib/market/opensea.ts -> lib/market/durable-kv.ts -> lib/postgres.ts
 * (the `pg` driver, Node-only) -- almost bundling a server-only dependency,
 * and the OpenSea key it needs, into the browser (see opensea.ts's own
 * header: "the key must never reach a client bundle"). Fixed by routing
 * through app/api/market/multichain/fulfillment-data and .../floor-listings
 * instead -- this file now does ONLY wallet interaction, never touches the
 * OpenSea key or Postgres itself.
 *
 * DELIBERATELY NOT lib/wallet.ts's sendTransaction()
 * -----------------------------------------------------
 * sendTransaction() hardcodes ensureRobinhoodChain() and rejects any other
 * chainId outright -- by design (see its own "CRITICAL: Only RH chain"
 * comment). Reusing it here would force-switch the wallet back to
 * Robinhood Chain mid-purchase and then reject the foreign router's own
 * address. This module is a parallel, foreign-chain-aware send path,
 * additive alongside sendTransaction rather than a modification of it --
 * same pattern this whole multichain effort has followed everywhere else.
 * It reuses lib/wallet.ts's newly-added ensureChain() (generalized,
 * additive alongside the untouched Robinhood-specific
 * switchToRobinhoodChain/ensureRobinhoodChain) for the actual network
 * switch, and applies the same "destination must be an allowlisted
 * address, fail closed on anything else" principle sendTransaction's own
 * assertSafeSwapDestination() uses -- just keyed per-chain instead of one
 * fixed address, since the router genuinely has a different address on
 * each chain once deployed.
 *
 * SIGNATURE FRESHNESS IS NOT OPTIONAL
 * --------------------------------------
 * Every function here fetches fulfillment data fresh from our API route
 * immediately before building the transaction -- it never accepts an
 * already-fetched order from a caller. Confirmed live (see
 * foreign-orders.ts's header): the summary/display data that populates a
 * listing card has no usable signature at all. A caller passing in stale
 * order data would silently repeat the exact "promising a fill we cannot
 * guarantee" failure that made Robinhood-Chain foreign listings View-only
 * in the first place (see lib/market/types.ts's Listing.venue doc).
 */
import { Contract, BrowserProvider } from "ethers";
import { foreignChainByChainSlug, foreignFeeRouterAddress } from "@/lib/market/multichain/trading/foreign-chain-registry";
import { getEthereumProvider, ensureChain } from "@/lib/wallet";

/** Mirrors foreign-orders.ts's ForeignSeaportOrder shape -- redeclared here rather than imported, since importing that module's types would pull the whole (server-only) module along with them under some bundler configurations. */
type ForeignSeaportOrderParameters = {
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
type ForeignSeaportOrder = {
  orderHash: string;
  chain: string;
  parameters: ForeignSeaportOrderParameters;
  signature: string | null;
};

async function fetchFulfillmentData(input: { chainSlug: string; orderHash: string; fulfillerAddress: string }): Promise<ForeignSeaportOrder> {
  const res = await fetch("/api/market/multichain/fulfillment-data", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `Failed to fetch fulfillment data (${res.status})`);
  }
  return (await res.json()) as ForeignSeaportOrder;
}

async function fetchFloorListingSummaries(input: { chainSlug: string; collectionSlug: string; count: number }): Promise<ForeignSeaportOrder[]> {
  const res = await fetch("/api/market/multichain/floor-listings", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `Failed to fetch floor listings (${res.status})`);
  }
  const { listings } = (await res.json()) as { listings: ForeignSeaportOrder[] };
  return listings;
}

const ROUTER_ABI = [
  "function feeBps() view returns (uint256)",
  "function buyNow((( address offerer,address zone,(uint8 itemType,address token,uint256 identifierOrCriteria,uint256 startAmount,uint256 endAmount)[] offer,(uint8 itemType,address token,uint256 identifierOrCriteria,uint256 startAmount,uint256 endAmount,address recipient)[] consideration,uint8 orderType,uint256 startTime,uint256 endTime,bytes32 zoneHash,uint256 salt,bytes32 conduitKey,uint256 totalOriginalConsiderationItems) parameters,uint120 numerator,uint120 denominator,bytes signature,bytes extraData) order,(uint256 orderIndex,uint8 side,uint256 index,uint256 identifier,bytes32[] criteriaProof)[] criteriaResolvers,bytes32 fulfillerConduitKey,uint256 orderPriceWei) payable",
  "function sweepBuy((( address offerer,address zone,(uint8 itemType,address token,uint256 identifierOrCriteria,uint256 startAmount,uint256 endAmount)[] offer,(uint8 itemType,address token,uint256 identifierOrCriteria,uint256 startAmount,uint256 endAmount,address recipient)[] consideration,uint8 orderType,uint256 startTime,uint256 endTime,bytes32 zoneHash,uint256 salt,bytes32 conduitKey,uint256 totalOriginalConsiderationItems) parameters,uint120 numerator,uint120 denominator,bytes signature,bytes extraData)[] orders,(uint256 orderIndex,uint8 side,uint256 index,uint256 identifier,bytes32[] criteriaProof)[][] criteriaResolvers,bytes32 fulfillerConduitKey,uint256[] orderPricesWei) payable returns (bool[] filled)",
];

const ZERO_HASH = "0x" + "0".repeat(64);

/** Requires the FRESH order's own zoneHash, not stray/padded copies -- fetchListingFulfillmentData already normalizes this once, so no caller needs to. */
function considerationTotal(order: ForeignSeaportOrder): bigint {
  return order.parameters.consideration.reduce((sum, item) => sum + BigInt(item.startAmount), BigInt(0));
}

function requireRouter(chainSlug: string): { chainId: number; routerAddress: string } {
  const chain = foreignChainByChainSlug(chainSlug);
  if (!chain) throw new Error(`foreign-fulfill: "${chainSlug}" is not a supported foreign chain.`);
  const routerAddress = foreignFeeRouterAddress(chainSlug);
  if (!routerAddress) {
    throw new Error(
      `foreign-fulfill: MarketplankForeignFeeRouter is not yet deployed on ${chain.chainSlug} -- ` +
        "this chain's cross-chain Buy/Sweep is intentionally unavailable until that happens."
    );
  }
  return { chainId: chain.chainId, routerAddress };
}

async function connectedRouter(chainSlug: string): Promise<{ router: Contract; buyerAddress: string; feeBps: bigint }> {
  const { chainId, routerAddress } = requireRouter(chainSlug);
  const injected = getEthereumProvider();
  if (!injected) throw new Error("No wallet found.");

  await ensureChain({
    chainId,
    name: chainSlug,
    nativeCurrencySymbol: "ETH",
    rpcUrl: `https://${chainSlug}.g.alchemy.com/v2/demo`,
    blockExplorerUrl: "",
  });

  const browserProvider = new BrowserProvider(injected, { chainId, name: chainSlug });
  const signer = await browserProvider.getSigner();
  const buyerAddress = await signer.getAddress();
  const router = new Contract(routerAddress, ROUTER_ABI, signer);
  const feeBps: bigint = await router.feeBps();
  return { router, buyerAddress, feeBps };
}

export type ForeignBuyResult = { txHash: string };

/**
 * Buy one foreign-chain listing right now. Re-fetches the real fulfillable
 * order fresh (see module header) using the CONNECTED wallet's own address
 * -- OpenSea's fulfillment_data is specific to the requesting fulfiller.
 */
export async function buyForeignListingNow(input: {
  chainSlug: string;
  orderHash: string;
}): Promise<ForeignBuyResult> {
  const { router, buyerAddress, feeBps } = await connectedRouter(input.chainSlug);

  const order = await fetchFulfillmentData({
    chainSlug: input.chainSlug,
    orderHash: input.orderHash,
    fulfillerAddress: buyerAddress,
  });
  if (!order.signature || order.signature === "0x") {
    throw new Error("This listing has no fulfillable signature right now (it may rely on on-chain validation that hasn't happened, or has since sold). Try again in a moment.");
  }

  const price = considerationTotal(order);
  const fee = (price * feeBps) / BigInt(10_000);
  const value = price + fee;

  const tx = await router.buyNow(
    { parameters: order.parameters, numerator: 1, denominator: 1, signature: order.signature, extraData: "0x" },
    [],
    ZERO_HASH,
    price,
    { value }
  );
  await tx.wait();
  return { txHash: tx.hash };
}

export type ForeignSweepResult = { txHash: string; attempted: number };

/**
 * Sweep the current cheapest N foreign-chain listings for a collection in
 * one transaction. Re-fetches fresh fulfillment data for EACH item (same
 * freshness requirement as buyForeignListingNow) right before building the
 * batch -- a sweep spans more wall-clock time between "user clicked" and
 * "tx sent" than a single buy, so staleness risk is higher, not lower.
 */
export async function sweepForeignListings(input: {
  chainSlug: string;
  collectionSlug: string;
  count: number;
}): Promise<ForeignSweepResult> {
  const { router, buyerAddress, feeBps } = await connectedRouter(input.chainSlug);

  const summaries = await fetchFloorListingSummaries({
    chainSlug: input.chainSlug,
    collectionSlug: input.collectionSlug,
    count: input.count,
  });
  if (summaries.length === 0) throw new Error("No listings available to sweep right now.");

  const freshOrders: ForeignSeaportOrder[] = [];
  for (const summary of summaries) {
    try {
      const fresh = await fetchFulfillmentData({
        chainSlug: input.chainSlug,
        orderHash: summary.orderHash,
        fulfillerAddress: buyerAddress,
      });
      if (fresh.signature && fresh.signature !== "0x") freshOrders.push(fresh);
    } catch {
      // One listing failing to re-fetch (already sold, expired) just drops
      // it from the batch -- sweepBuy's own per-order try/catch handles the
      // remaining race window between fetch and mined block.
    }
  }
  if (freshOrders.length === 0) throw new Error("None of the current listings could be freshly re-signed -- try again.");

  const prices = freshOrders.map(considerationTotal);
  const totalValue = prices.reduce(
    (sum, price) => sum + price + (price * feeBps) / BigInt(10_000),
    BigInt(0)
  );

  const tx = await router.sweepBuy(
    freshOrders.map((o) => ({ parameters: o.parameters, numerator: 1, denominator: 1, signature: o.signature, extraData: "0x" })),
    freshOrders.map(() => []),
    ZERO_HASH,
    prices,
    { value: totalValue }
  );
  await tx.wait();
  return { txHash: tx.hash, attempted: freshOrders.length };
}
