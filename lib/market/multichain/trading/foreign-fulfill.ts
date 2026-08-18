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
import { foreignChainByChainSlug, foreignFeeRouterAddress, foreignAcrossReceiverAddress, foreignDeBridgeExecutorAddress } from "@/lib/market/multichain/trading/foreign-chain-registry";
import { findStablecoin } from "@/lib/market/multichain/trading/stablecoins";
import { getEthereumProvider, ensureChain } from "@/lib/wallet";

/** Minimal ERC20 surface needed to approve a stablecoin spend before a cross-chain deposit -- both SpokePool.depositV3 and deBridge's DLN order pull the input token via transferFrom, which requires this first. */
const ERC20_APPROVE_ABI = ["function approve(address spender, uint256 amount) external returns (bool)"];

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

export type ForeignTraitClause = { traitType: string; value: string };

async function fetchFloorListingSummaries(input: {
  chainSlug: string;
  collectionSlug: string;
  count: number;
  traits?: ForeignTraitClause[];
}): Promise<ForeignSeaportOrder[]> {
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
  /** AND-combined, same semantics as fetchForeignTraitFilteredListings -- "sweep the N cheapest listings matching every clause." */
  traits?: ForeignTraitClause[];
}): Promise<ForeignSweepResult> {
  const { router, buyerAddress, feeBps } = await connectedRouter(input.chainSlug);

  const summaries = await fetchFloorListingSummaries({
    chainSlug: input.chainSlug,
    collectionSlug: input.collectionSlug,
    count: input.count,
    traits: input.traits,
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

const SPOKE_POOL_ABI = [
  "function depositV3(address depositor,address recipient,address inputToken,address outputToken,uint256 inputAmount,uint256 outputAmount,uint256 destinationChainId,address exclusiveRelayer,uint32 quoteTimestamp,uint32 fillDeadline,uint32 exclusivityParameter,bytes calldata message) external payable",
];

export type AcrossPurchaseResult = { txHash: string };

/**
 * Pay on ANY Across-supported origin chain, receive an NFT purchased on a
 * DIFFERENT (destination) chain via MarketplankAcrossReceiver -- the
 * genuinely open-source, no-proprietary-middleman cross-chain path (see
 * MarketplankAcrossReceiver.sol's header and lib/market/multichain/trading
 * /across-quote.ts for the full verification this is built on).
 *
 * Ends with a real depositV3 call directly to the real, canonical,
 * OpenZeppelin-audited Across SpokePool contract on the origin chain --
 * NOT to any proprietary API. The quote route
 * (app/api/market/multichain/across-quote) only builds calldata server-side
 * (it needs the OpenSea key, which must never reach this client-side
 * module -- same reason as fetchFulfillmentData/fetchFloorListingSummaries
 * above); it never executes or custodies anything.
 *
 * ETH sent directly as msg.value (Across's own depositV3 explicitly
 * supports this when inputToken is the chain's wrapped-native address --
 * confirmed from SpokePool.sol's own doc comment: "the caller can
 * optionally pass in native token as msg.value, provided msg.value =
 * inputTokenAmount"), so no separate WETH wrap/approve step is needed on
 * the origin chain.
 */
export async function buyCrossChainViaAcross(input: {
  originChainId: number;
  destinationChainSlug: string;
  orderHash: string;
  /** What the buyer is willing to pay on the origin chain, in the input token's own smallest unit -- must exceed the order price by enough to cover Across's relayer fee; across-quote.ts's own check will reject an insufficient amount rather than silently under-quoting. */
  inputAmountWei: string;
  /**
   * "USDC" | "USDT" to pay with a real, live-verified stablecoin instead
   * of the origin chain's wrapped-native token (see stablecoins.ts).
   * REAL GAP FOUND AND FIXED, 2026-08-18: this parameter existed on
   * across-quote.ts's own quoteCrossChainPurchase() and on the API route,
   * but was never threaded through from here -- meaning the stablecoin
   * payment path was unreachable from any real caller even though every
   * layer beneath it was built and address-verified. Also fixed here: an
   * ERC20 deposit needs the SpokePool to be pre-approved to pull
   * `inputAmount` (standard transferFrom pattern) and must NOT attach a
   * native `value` -- the original code always attached
   * `{value: input.inputAmountWei}` unconditionally, which would have
   * sent a stablecoin's raw integer amount as real ETH value the moment
   * this path was ever actually reached.
   */
  inputCurrency?: "USDC" | "USDT";
}): Promise<AcrossPurchaseResult> {
  const receiverAddress = foreignAcrossReceiverAddress(input.destinationChainSlug);
  if (!receiverAddress) {
    throw new Error(
      `foreign-fulfill: MarketplankAcrossReceiver is not yet deployed on ${input.destinationChainSlug} -- ` +
        "cross-chain purchase via Across is intentionally unavailable until that happens."
    );
  }

  const injected = getEthereumProvider();
  if (!injected) throw new Error("No wallet found.");
  await ensureChain({
    chainId: input.originChainId,
    name: `chain-${input.originChainId}`,
    nativeCurrencySymbol: "ETH",
    rpcUrl: "",
    blockExplorerUrl: "",
  });
  const browserProvider = new BrowserProvider(injected, { chainId: input.originChainId, name: `chain-${input.originChainId}` });
  const signer = await browserProvider.getSigner();
  const buyerAddress = await signer.getAddress();

  const res = await fetch("/api/market/multichain/across-quote", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      originChainId: input.originChainId,
      destinationChainSlug: input.destinationChainSlug,
      receiverAddress,
      orderHash: input.orderHash,
      recipient: buyerAddress,
      inputAmount: input.inputAmountWei,
      inputCurrency: input.inputCurrency,
    }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `Failed to build cross-chain quote (${res.status})`);
  }
  const { deposit } = (await res.json()) as { deposit: Record<string, unknown> };

  if (input.inputCurrency) {
    const stable = findStablecoin(input.originChainId, input.inputCurrency);
    if (!stable) throw new Error(`foreign-fulfill: no verified ${input.inputCurrency} address for chain ${input.originChainId}`);
    const token = new Contract(stable.address, ERC20_APPROVE_ABI, signer);
    const approveTx = await token.approve(deposit.spokePoolAddress as string, deposit.inputAmount as string);
    await approveTx.wait();
  }

  const spokePool = new Contract(deposit.spokePoolAddress as string, SPOKE_POOL_ABI, signer);
  const tx = await spokePool.depositV3(
    buyerAddress,
    receiverAddress,
    deposit.inputToken,
    deposit.outputToken,
    deposit.inputAmount,
    deposit.outputAmount,
    deposit.destinationChainId,
    deposit.exclusiveRelayer,
    deposit.quoteTimestamp,
    deposit.fillDeadline,
    deposit.exclusivityParameter,
    deposit.message,
    // Native `value` only when paying with the wrapped-native placeholder
    // -- an ERC20/stablecoin deposit is pulled via transferFrom (the
    // approve() above), attaching value there would be a real fund-safety
    // bug (sending unintended native ETH on top of the ERC20 pull).
    input.inputCurrency ? {} : { value: input.inputAmountWei }
  );
  await tx.wait();
  return { txHash: tx.hash };
}

/**
 * deBridge counterpart to buyCrossChainViaAcross -- pay WBNB on BNB Chain,
 * receive an NFT purchased on a different chain via
 * MarketplankDeBridgeExecutor. See that contract's header for why this
 * exists (Across has no live BNB Chain route) and debridge-quote.ts for
 * the real, live-verified request schema.
 *
 * Unlike Across's depositV3 (called directly on the SpokePool with
 * hand-built parameters), deBridge's own API returns a ready-to-send
 * {to, data, value} -- this function still fetches that server-side (same
 * OpenSea-key reason as buyCrossChainViaAcross) and submits it exactly as
 * returned, via the connected wallet, to deBridge's own real on-chain
 * contract (the "Crosschain Forwarder Proxy") -- never executed by our
 * server.
 */
export async function buyCrossChainViaDeBridge(input: {
  destinationChainSlug: string;
  orderHash: string;
  inputAmountWei: string;
  /** "USDC" | "USDT" on BNB Chain -- see buyCrossChainViaAcross's identical parameter for the full writeup on why this was previously unreachable dead code. */
  inputCurrency?: "USDC" | "USDT";
}): Promise<AcrossPurchaseResult> {
  const executorAddress = foreignDeBridgeExecutorAddress(input.destinationChainSlug);
  if (!executorAddress) {
    throw new Error(
      `foreign-fulfill: MarketplankDeBridgeExecutor is not yet deployed on ${input.destinationChainSlug} -- ` +
        "cross-chain purchase via deBridge is intentionally unavailable until that happens."
    );
  }

  const injected = getEthereumProvider();
  if (!injected) throw new Error("No wallet found.");
  const BNB_CHAIN_ID = 56;
  await ensureChain({
    chainId: BNB_CHAIN_ID,
    name: "bnb-mainnet",
    nativeCurrencySymbol: "BNB",
    rpcUrl: "",
    blockExplorerUrl: "",
  });
  const browserProvider = new BrowserProvider(injected, { chainId: BNB_CHAIN_ID, name: "bnb-mainnet" });
  const signer = await browserProvider.getSigner();
  const senderAddress = await signer.getAddress();

  const res = await fetch("/api/market/multichain/debridge-quote", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      executorAddress,
      orderHash: input.orderHash,
      destinationChainSlug: input.destinationChainSlug,
      recipient: senderAddress,
      senderAddress,
      inputAmountWei: input.inputAmountWei,
      inputCurrency: input.inputCurrency,
    }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `Failed to build deBridge quote (${res.status})`);
  }
  const { tx } = (await res.json()) as { tx: { to: string; data: string; value: string } };

  if (input.inputCurrency) {
    const BNB_CHAIN_ID_FOR_STABLE = 56;
    const stable = findStablecoin(BNB_CHAIN_ID_FOR_STABLE, input.inputCurrency);
    if (!stable) throw new Error(`foreign-fulfill: no verified ${input.inputCurrency} address for BNB Chain`);
    // Approve the exact contract deBridge's own API told us to call (tx.to,
    // the "Crosschain Forwarder Proxy") -- the standard integration pattern
    // for any aggregator that returns ready-to-send calldata: approve the
    // spender you are about to invoke, not a guessed/hardcoded address.
    const token = new Contract(stable.address, ERC20_APPROVE_ABI, signer);
    const approveTx = await token.approve(tx.to, input.inputAmountWei);
    await approveTx.wait();
  }

  const txResponse = await signer.sendTransaction({ to: tx.to, data: tx.data, value: tx.value });
  await txResponse.wait();
  return { txHash: txResponse.hash };
}
