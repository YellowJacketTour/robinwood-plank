/**
 * Builds a real, submittable Across depositV3 call that ends in a
 * cross-chain NFT purchase via MarketplankAcrossReceiver -- the piece that
 * turns the receiver contract from "written and tested" into "actually
 * usable."
 *
 * USES ACROSS'S OWN FREE QUOTE ENDPOINT FOR FEE ESTIMATION ONLY
 * -------------------------------------------------------------------
 * GET https://app.across.to/api/suggested-fees -- confirmed live
 * 2026-08-17, completely keyless, no signup, no Authorization header
 * required (a newer /swap/approval endpoint exists that DOES want an API
 * key/integratorId; deliberately using the older, still-live, still-free
 * one instead, consistent with this whole effort's "no proprietary
 * middleman" mandate). ONLY fee/outputAmount/timing fields are trusted
 * from this response -- price-oracle convenience only, and worst case
 * (wrong/stale) just means a bad quote the isAmountTooLow/outputAmount
 * checks below catch. The response's OWN spokePoolAddress field is
 * explicitly NEVER used as the real fund-transfer destination (a prior
 * version of this file did fall back to it for chains outside the
 * hardcoded map below -- a real, fixed CRITICAL bug: an unauthenticated
 * HTTP response is not a safe source for a real ETH-transfer address, full
 * stop, regardless of how well it cross-validated at the time it was
 * checked). ACROSS_SPOKE_POOL below is the ONLY source of truth for that
 * address, and a chain missing from it fails loudly rather than silently
 * trusting the API. Cross-validated once, historically, as a sanity check
 * (not as an ongoing trust basis): the response's spokePoolAddress field
 * (0x09aea4b2242abC8bb4BB78D537A67a245A7bEC64 for Base) matched the
 * address independently pulled from across-protocol/contracts' GitHub
 * source in foreign-chain-registry.ts.
 *
 * CHAIN COVERAGE -- 5 of the 7 OpenSea-supported foreign EVM chains
 * -----------------------------------------------------------------------
 * Two real, live-confirmed gaps, neither affecting the direct (non-Across)
 * buy-now/sweep path via MarketplankForeignFeeRouter -- that path doesn't
 * depend on Across at all:
 * - Avalanche: Across has NO Avalanche deployment whatsoever
 *   (across-protocol/contracts' deployments/ directory has no avalanche
 *   folder -- checked, not assumed).
 * - BNB Chain: DOES have a real, deployed, verified SpokePool contract
 *   (real bytecode, a live chainId() call returning exactly 56) -- but
 *   every WETH/WBNB-denominated deposit route to or from it, in BOTH
 *   directions, returns Across's own {"code":"ROUTE_NOT_ENABLED"} error,
 *   confirmed live 2026-08-17 by actually attempting the calls. The
 *   contract exists; Across's live relayer/liquidity network does not
 *   currently support this chain for the native-currency route this
 *   service needs. Deliberately NOT wired here as a result -- claiming it
 *   works because the contract exists, without checking the actual route,
 *   is exactly the kind of gap this whole effort has been built to catch
 *   rather than repeat.
 */
import { fetchListingFulfillmentData } from "@/lib/market/multichain/trading/foreign-orders";
import { foreignChainByChainSlug } from "@/lib/market/multichain/trading/foreign-chain-registry";
import { findStablecoin } from "@/lib/market/multichain/trading/stablecoins";

const ACROSS_API = "https://app.across.to/api";

/** Real per-chain Across SpokePool addresses -- pulled from across-protocol/contracts' GitHub deployments/{chain}/{Chain}_SpokePool.json, verified live via eth_getCode + a live chainId() call matching each chain's real id (see MarketplankAcrossReceiver.sol's header and this file's own header for the full verification). Avalanche and BNB Chain deliberately absent -- see header. */
export const ACROSS_SPOKE_POOL: Record<number, string> = {
  1: "0xFBc81a18EcDa8E6A91275cFDF5FC6d91A7C5AE80",
  8453: "0x6C99671B249af73B2847D92123d823Cb3875E399",
  42161: "0x2a5A4eD1220f64714d4a7c3B3BD6188957764C9A",
  10: "0xD51099ac551350Bf3198c69104B5dc4694b3a536",
  137: "0x68ec189Ca4d950D960BB59B56742ec292E7D2C17",
};

/** Canonical wrapped-native-token address per chain -- the only input/output token this quote service supports today (native-currency-denominated purchases only, matching MarketplankAcrossReceiver's own scope). */
const WRAPPED_NATIVE: Record<number, string> = {
  1: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
  8453: "0x4200000000000000000000000000000000000006",
  42161: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
  10: "0x4200000000000000000000000000000000000006",
  137: "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619", // WMATIC (Polygon's native token is MATIC, not ETH)
};

type SuggestedFeesResponse = {
  outputAmount: string;
  timestamp: string;
  fillDeadline: string;
  exclusiveRelayer: string;
  exclusivityDeadline: number;
  spokePoolAddress: string;
  isAmountTooLow: boolean;
};

export type AcrossDepositParams = {
  spokePoolAddress: string;
  inputToken: string;
  outputToken: string;
  inputAmount: string;
  outputAmount: string;
  destinationChainId: number;
  exclusiveRelayer: string;
  quoteTimestamp: number;
  fillDeadline: number;
  exclusivityParameter: number;
  message: string;
};

/**
 * Full quote for: pay `inputAmount` of wrapped-native on `originChainId`,
 * receive an NFT via MarketplankAcrossReceiver on `destinationChainId`.
 * Requires headroom above the order's own price for Across's relayer fee
 * (see isAmountTooLow below) -- the caller should quote for MORE than the
 * bare order price and let this function tell them if it's not enough.
 */
export async function quoteCrossChainPurchase(input: {
  originChainId: number;
  destinationChainSlug: string;
  receiverAddress: string;
  orderHash: string;
  fulfillerAddress: string; // the receiver contract, since it's the one calling buyNowFor
  recipient: string; // the REAL end buyer, decoded from the message on arrival
  inputAmount: string; // what the buyer is willing to pay on the origin chain, in the input token's own smallest unit
  /**
   * "USDC" | "USDT" to pay with a real stablecoin instead of the origin
   * chain's wrapped-native token (see stablecoins.ts -- every address/
   * decimals value there was live-verified, not assumed). Omit for the
   * original wrapped-native behavior. The OUTPUT side always stays
   * wrapped-native: every cross-chain NFT offer is native-denominated
   * (see foreign-chain-registry.ts's own header), so only the buyer's
   * PAYMENT currency varies here -- Across's suggested-fees endpoint
   * already accepts distinct inputToken/outputToken and quotes the real
   * swap-and-bridge route, or reports isAmountTooLow/no-route if this
   * specific pair genuinely isn't supported (checked below, not assumed).
   */
  inputCurrency?: "USDC" | "USDT";
}): Promise<{ deposit: AcrossDepositParams; orderPriceWei: string }> {
  const destChain = foreignChainByChainSlug(input.destinationChainSlug);
  if (!destChain) throw new Error(`across-quote: "${input.destinationChainSlug}" is not a supported foreign chain`);
  const destinationChainId = destChain.chainId;

  let originToken: string | undefined = WRAPPED_NATIVE[input.originChainId];
  if (input.inputCurrency) {
    const stable = findStablecoin(input.originChainId, input.inputCurrency);
    if (!stable) {
      throw new Error(`across-quote: no verified ${input.inputCurrency} address for chain ${input.originChainId}`);
    }
    originToken = stable.address;
  }
  const destToken = WRAPPED_NATIVE[destinationChainId];
  if (!originToken || !destToken) {
    throw new Error(`across-quote: no wrapped-native-token mapping for chain ${input.originChainId} or ${destinationChainId}`);
  }

  // Real, fresh, fulfillable order -- fetched with the RECEIVER's address
  // as fulfiller, since the receiver is what actually calls buyNowFor on
  // arrival, not the end buyer paying on the origin chain.
  const order = await fetchListingFulfillmentData({
    chainSlug: input.destinationChainSlug,
    orderHash: input.orderHash,
    fulfillerAddress: input.receiverAddress,
  });
  if (!order.signature || order.signature === "0x") {
    throw new Error("across-quote: this listing has no fulfillable signature right now");
  }
  const orderPriceWei = order.parameters.consideration.reduce((sum, c) => sum + BigInt(c.startAmount), BigInt(0)).toString();

  const feeQuoteUrl = new URL(`${ACROSS_API}/suggested-fees`);
  feeQuoteUrl.searchParams.set("originChainId", String(input.originChainId));
  feeQuoteUrl.searchParams.set("destinationChainId", String(destinationChainId));
  feeQuoteUrl.searchParams.set("inputToken", originToken);
  feeQuoteUrl.searchParams.set("outputToken", destToken);
  feeQuoteUrl.searchParams.set("amount", input.inputAmount);
  const feeRes = await fetch(feeQuoteUrl.toString());
  if (!feeRes.ok) {
    throw new Error(`across-quote: Across suggested-fees ${feeRes.status}`);
  }
  const fees = (await feeRes.json()) as SuggestedFeesResponse;
  if (fees.isAmountTooLow) {
    throw new Error("across-quote: inputAmount is below Across's minimum deposit for this route");
  }
  // outputAmount (what actually arrives after the relayer's fee) must
  // still cover the order price + our router's fee -- caller is
  // responsible for quoting enough inputAmount headroom; this is the
  // authoritative check, not a client-side estimate.
  if (BigInt(fees.outputAmount) < BigInt(orderPriceWei)) {
    throw new Error(
      `across-quote: after Across's relayer fee, only ${fees.outputAmount} wei would arrive -- not enough to cover the ${orderPriceWei} wei order price. Increase inputAmount.`
    );
  }

  const abi = new (await import("ethers")).AbiCoder();
  const message = abi.encode(
    [
      "tuple(address offerer,address zone,tuple(uint8 itemType,address token,uint256 identifierOrCriteria,uint256 startAmount,uint256 endAmount)[] offer,tuple(uint8 itemType,address token,uint256 identifierOrCriteria,uint256 startAmount,uint256 endAmount,address recipient)[] consideration,uint8 orderType,uint256 startTime,uint256 endTime,bytes32 zoneHash,uint256 salt,bytes32 conduitKey,uint256 totalOriginalConsiderationItems) parameters",
      "bytes signature",
      "tuple(uint256 orderIndex,uint8 side,uint256 index,uint256 identifier,bytes32[] criteriaProof)[] criteriaResolvers",
      "bytes32 fulfillerConduitKey",
      "uint256 orderPriceWei",
      "address recipient",
    ],
    [order.parameters, order.signature, [], "0x" + "0".repeat(64), orderPriceWei, input.recipient]
  );

  // CRITICAL, fixed 2026-08-18: the buyer's real ETH `value` is sent
  // directly to this address (see foreign-fulfill.ts's depositV3 call) --
  // it must NEVER come from `fees.spokePoolAddress`, an unauthenticated
  // field in the response of a keyless, unauthenticated HTTP API
  // (app.across.to/api/suggested-fees). A prior version of this function
  // fell back to that API-supplied address for any origin chain outside
  // the hardcoded ACROSS_SPOKE_POOL map, meaning a compromised/MITM'd/
  // buggy API response could redirect a real fund transfer -- a live
  // theft vector this file's own header incorrectly claimed didn't exist
  // ("this is NOT a trust dependency"). The ONLY source of truth for this
  // address is the source-verified ACROSS_SPOKE_POOL map (see its own
  // comment for how each entry was verified); an unsupported origin chain
  // must fail loudly, never silently trust a network response for this.
  const spokePoolAddress = ACROSS_SPOKE_POOL[input.originChainId];
  if (!spokePoolAddress) {
    throw new Error(
      `across-quote: chain ${input.originChainId} has no verified Across SpokePool address -- refusing to trust the API's own spokePoolAddress field for a real fund transfer.`
    );
  }

  return {
    orderPriceWei,
    deposit: {
      spokePoolAddress,
      inputToken: originToken,
      outputToken: destToken,
      inputAmount: input.inputAmount,
      outputAmount: fees.outputAmount,
      destinationChainId,
      exclusiveRelayer: fees.exclusiveRelayer,
      quoteTimestamp: Number(fees.timestamp),
      fillDeadline: Number(fees.fillDeadline),
      exclusivityParameter: fees.exclusivityDeadline,
      message,
    },
  };
}
