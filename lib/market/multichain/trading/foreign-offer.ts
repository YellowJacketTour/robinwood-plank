/**
 * Make an offer (bid) on a token in a foreign-chain collection -- the
 * genuine "Make offer" counterpart to buyForeignListingNow. Mirrors
 * lib/market/seaport.ts's buildOffer exactly (same seaport-js createOrder
 * call, same WETH-denominated-offer constraint, same executeActionsViaWallet
 * signing sequence) but connected to the CONNECTED WALLET's signer on
 * whichever foreign chain is targeted, using that chain's own Seaport
 * deployment (FOREIGN_SEAPORT_ADDRESS -- same address on every chain, see
 * foreign-chain-registry.ts) and its own WETH/WBNB/WAVAX address
 * (foreignOfferCurrency -- each verified live via eth_call, see there).
 *
 * NO ROUTER INVOLVEMENT: unlike buyNow/sweepBuy, creating an offer never
 * touches MarketplankForeignFeeRouter -- an offer is just a standard
 * signed Seaport order posted to OpenSea's real orderbook so any seller
 * (not only ones who found this app) can see and accept it.
 *
 * MARKETPLANK_FOREIGN_OFFER_FEE_BPS IS CAPTURED HERE (audit finding fix,
 * 2026-08-19; a prior version of this comment said offer creation earned
 * nothing -- that was wrong). The fee is a second WETH consideration item,
 * same token as the offer amount, paid to MARKET_FEE_RECIPIENT and baked
 * into the order's own signed parameters -- NOT dependent on controlling
 * accept-side fulfillment. Seaport's own matching delivers
 * (offerWei - feeWei) to whoever fulfills; acceptForeignOffer below needs
 * no special handling, it fulfills the order exactly as signed, same as
 * any listing that carries its fee in its own consideration array.
 *
 * Real endpoints verified live 2026-08-18:
 *   - POST /v2/offers/build (OpenSea) returns the real partial Seaport
 *     parameters (consideration item, zone, zoneHash) for a token-specific
 *     or collection-wide bid -- used here for TOKEN-specific bids only
 *     (collection-wide/criteria bids stay out of scope, same caution the
 *     native buildOffer applies: "wildcard root-0 form was never proven
 *     fillable").
 *   - POST /v2/orders/{chain}/seaport/offers is a real, validating
 *     endpoint for submitting the final signed order (confirmed via a real
 *     "Missing required field 'parameters'" validation error, not a 404).
 */
import { Seaport } from "@opensea/seaport-js";
import { ItemType } from "@opensea/seaport-js/lib/constants";
import { BrowserProvider, Interface } from "ethers";
import {
  foreignChainByChainSlug,
  foreignOfferCurrency,
  FOREIGN_SEAPORT_ADDRESS,
} from "@/lib/market/multichain/trading/foreign-chain-registry";
import { getEthereumProvider, ensureChain, sendForeignTransaction, waitForTransaction } from "@/lib/wallet";
import { chainDisplayName, foreignRpcUrls } from "@/lib/market/multichain/trading/foreign-chain-registry";
import { normalizeTokenIds } from "@/lib/market/criteria";
import { MARKET_FEE_RECIPIENT, MARKETPLANK_FOREIGN_OFFER_FEE_BPS } from "@/lib/constants";

type SeaportTransactionMethods = { buildTransaction: () => Promise<{ to?: string; data?: string; value?: bigint }> };
type SeaportAction = { type: string; transactionMethods?: SeaportTransactionMethods; createOrder?: () => Promise<unknown> };

/** The registry-sourced chain parameters every send on this chain uses -- one source of truth for ensureChain and sendForeignTransaction alike. */
function chainParamsFor(chainSlug: string) {
  const chain = foreignChainByChainSlug(chainSlug);
  if (!chain) throw new Error(`foreign-offer: "${chainSlug}" is not a supported foreign chain.`);
  return {
    chainSlug,
    chainId: chain.chainId,
    chainName: chainDisplayName(chainSlug),
    nativeCurrencySymbol: chain.nativeCurrencySymbol,
    rpcUrl: foreignRpcUrls(chainSlug)[0],
    blockExplorerUrl: chain.blockExplorerUrl,
  };
}

async function connectedSeaport(chainSlug: string) {
  const params = chainParamsFor(chainSlug);
  const injected = getEthereumProvider();
  if (!injected) throw new Error("No wallet found.");
  // AUDIT lens 3 #4 (2026-09-06): this used to add the chain to the wallet
  // with symbol "ETH" (wrong on Polygon/BNB/Avalanche), a "/v2/demo" RPC and
  // no explorer -- persisting a broken network into the user's wallet. Same
  // registry-sourced parameters the buy path uses (foreign-fulfill.ts).
  await ensureChain({
    chainId: params.chainId,
    name: params.chainName,
    nativeCurrencySymbol: params.nativeCurrencySymbol,
    rpcUrl: params.rpcUrl,
    blockExplorerUrl: params.blockExplorerUrl,
  });
  const browserProvider = new BrowserProvider(injected, { chainId: params.chainId, name: chainSlug });
  const signer = await browserProvider.getSigner();
  const seaport = new Seaport(signer as unknown as ConstructorParameters<typeof Seaport>[0], {
    overrides: { contractAddress: FOREIGN_SEAPORT_ADDRESS },
  });
  return { seaport, signer };
}

/**
 * Sequences seaport-js actions exactly like lib/market/seaport.ts's own
 * executeActionsViaWallet. AUDIT lens 3 #4 / D3 (2026-09-06): every on-chain
 * send (the WETH `approve(conduit)` before an offer signature, the token
 * approval before an accept) now goes through lib/wallet.ts
 * sendForeignTransaction -- chain re-check, destination allowlist
 * (Seaport / conduit / the chain's wrapped native / this collection), and
 * hard-fail pre-flight simulation -- instead of a raw signer.sendTransaction
 * that the wallet alone had to vet. Each tx is awaited to a receipt before
 * the next action because the next action is "create" (the signature
 * request), which must see the allowance already on-chain (bug fix
 * 2026-08-19: this loop once built the approval and never sent it).
 *
 * Signature actions ("create") still use seaport-js's own signer path --
 * that is an eth_signTypedData_v4 with the chainId-pinned domain, not a send.
 */
async function executeActions(
  actions: SeaportAction[],
  accountAddress: string,
  chainSlug: string,
  /** The ONE collection contract this action sequence is for (see assertSafeForeignMarketDestination). */
  contractAddress: string
): Promise<unknown | null> {
  const params = chainParamsFor(chainSlug);
  let order: unknown | null = null;
  for (const action of actions) {
    if (action.type === "create" && action.createOrder) {
      order = await action.createOrder();
      continue;
    }
    if (!action.transactionMethods) throw new Error(`Unsupported Seaport action "${action.type}".`);
    const tx = await action.transactionMethods.buildTransaction();
    if (!tx.to || !tx.data) throw new Error("Malformed Seaport approval transaction.");
    const hash = await sendForeignTransaction({
      to: tx.to,
      from: accountAddress,
      data: tx.data,
      value: tx.value !== undefined && tx.value !== null ? tx.value.toString() : undefined,
      ...params,
      contractAddress,
    });
    await waitForTransaction(hash, { label: action.type === "approval" ? "Approval" : "Order" });
  }
  return order;
}

export async function buildForeignOffer(input: {
  chainSlug: string;
  collectionAddress: string;
  /** Exactly one of tokenId / criteriaTokenIds / collectionWildcard. */
  tokenId?: string;
  criteriaTokenIds?: string[];
  /** OpenSea collection offer (Seaport ERC721_WITH_CRITERIA identifier 0). Fulfillment requires the seller's chosen tokenId. */
  collectionWildcard?: boolean;
  offerWei: bigint;
  expiresAt: string;
  accountAddress: string;
}): Promise<{ orderHash: string }> {
  const modes = [Boolean(input.tokenId), Boolean(input.criteriaTokenIds?.length), Boolean(input.collectionWildcard)].filter(Boolean).length;
  if (modes !== 1) {
    throw new Error("Offer must be exactly one of: single token, trait snapshot, or collection-wide.");
  }
  // This function submits to OpenSea's own orderbook specifically -- fail
  // BEFORE signing anything for a chain with no OpenSea integration
  // (zkSync today), rather than build and sign an order that can never be
  // submitted anywhere. Marketplank's own native offers (a separate
  // pathway, lib/market/multichain/trading/native-fulfill.ts) work on this
  // chain regardless.
  const openSeaChain = foreignChainByChainSlug(input.chainSlug)?.openSeaChain;
  if (!openSeaChain) {
    throw new Error(`foreign-offer: "${input.chainSlug}" has no OpenSea orderbook -- use a native offer instead.`);
  }
  const currency = foreignOfferCurrency(input.chainSlug);
  if (!currency) {
    throw new Error(`foreign-offer: no offer currency configured for "${input.chainSlug}".`);
  }

  let considerationItem:
    | { itemType: ItemType.ERC721; token: string; identifier: string; recipient: string }
    | { itemType: ItemType.ERC721; token: string; identifiers: string[]; recipient: string }
    | { itemType: ItemType.ERC721_WITH_CRITERIA; token: string; identifier: string; recipient: string };
  if (input.tokenId) {
    considerationItem = {
      itemType: ItemType.ERC721,
      token: input.collectionAddress,
      identifier: input.tokenId,
      recipient: input.accountAddress,
    };
  } else if (input.criteriaTokenIds && input.criteriaTokenIds.length > 0) {
    considerationItem = {
      itemType: ItemType.ERC721,
      token: input.collectionAddress,
      identifiers: normalizeTokenIds(input.criteriaTokenIds),
      recipient: input.accountAddress,
    };
  } else {
    // Collection-wide: identifier 0 is Seaport/OpenSea's "any token in this
    // contract" criteria. Fill goes through OpenSea fulfillment_data with the
    // seller's chosen token_id -- not a homemade empty Merkle proof.
    considerationItem = {
      itemType: ItemType.ERC721_WITH_CRITERIA,
      token: input.collectionAddress,
      identifier: "0",
      recipient: input.accountAddress,
    };
  }

  const { seaport } = await connectedSeaport(input.chainSlug);
  const endTime = Math.floor(new Date(input.expiresAt).getTime() / 1000).toString();

  // Marketplank's fee on this offer, via seaport-js's own `fees` param --
  // same mechanism lib/market/seaport.ts's buildListing/buildOffer already
  // use for Robinhood-chain orders, not a hand-built consideration item.
  // seaport-js resolves this into a WETH/WBNB/WAVAX consideration item
  // (the offer's own currency) paid to MARKET_FEE_RECIPIENT, baked into
  // the order's own signed parameters -- Seaport's matching then delivers
  // (offerWei - feeWei) to whoever fulfills. See
  // MARKETPLANK_FOREIGN_OFFER_FEE_BPS's own comment in lib/constants.ts.
  const { actions } = await seaport.createOrder(
    {
      offer: [{ amount: input.offerWei.toString(), token: currency }],
      consideration: [considerationItem as never],
      fees: [{ recipient: MARKET_FEE_RECIPIENT, basisPoints: MARKETPLANK_FOREIGN_OFFER_FEE_BPS }],
      endTime,
    },
    input.accountAddress,
    /* exactApproval */ true
  );

  const order = (await executeActions(actions as unknown as SeaportAction[], input.accountAddress, input.chainSlug, input.collectionAddress)) as
    | { parameters: unknown; signature: string }
    | null;
  if (!order) throw new Error("Offer was not signed.");

  const chain = foreignChainByChainSlug(input.chainSlug)!;
  const res = await fetch("/api/market/multichain/submit-offer", {
    method: "POST",
    headers: { "content-type": "application/json" },
    signal: AbortSignal.timeout(15_000),
    body: JSON.stringify({
      openSeaChain: chain.openSeaChain,
      parameters: order.parameters,
      signature: order.signature,
      protocol_address: FOREIGN_SEAPORT_ADDRESS,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Offer signed but OpenSea rejected it (${res.status}): ${body.slice(0, 200)}`);
  }
  const submitted = (await res.json()) as { order_hash?: string };
  return { orderHash: submitted.order_hash ?? "" };
}

/** OpenSea `fulfillment_data.transaction` -- the exact call OpenSea resolved for this fulfiller (criteria resolvers included). */
export type OpenSeaFulfillmentTransaction = {
  function: string;
  to: string;
  value: number | string;
  /** Either hex calldata or OpenSea's decoded argument object (keys in ABI order). */
  input_data: unknown;
};

/**
 * Pure guard for the calldata OpenSea vends (AUDIT lens 3 #5 / D4): the
 * seller sends it verbatim, so the ONLY things this app can and must check
 * are (a) it targets Seaport itself and nothing else, (b) it moves no
 * native value out of the seller (accepting a bid costs gas only), and
 * (c) the signed order's bid equals the price the seller was shown.
 * Throws with a user-facing message; returns the normalized `to`/value.
 */
export function assertOfferFulfillmentCalldata(input: {
  to: string;
  value: number | string | null | undefined;
  /** Bid amount from the signed order's own offer item(s), wei. */
  orderBidWei: bigint | string;
  /** The price the UI displayed for this offer, wei. */
  expectedPriceWei: bigint | string;
  seaportAddress?: string;
}): { to: string; valueWei: bigint } {
  const seaport = (input.seaportAddress ?? FOREIGN_SEAPORT_ADDRESS).toLowerCase();
  if (typeof input.to !== "string" || input.to.toLowerCase() !== seaport) {
    throw new Error("Refusing to send: OpenSea's fulfillment transaction does not target Seaport.");
  }
  let valueWei: bigint;
  try {
    valueWei =
      input.value === null || input.value === undefined || input.value === ""
        ? BigInt(0)
        : typeof input.value === "number"
          ? BigInt(Math.trunc(input.value))
          : BigInt(input.value);
  } catch {
    throw new Error("Refusing to send: OpenSea's fulfillment transaction carries an unreadable value.");
  }
  if (valueWei !== BigInt(0)) {
    throw new Error("Refusing to send: accepting an offer must not send native value from your wallet.");
  }
  if (BigInt(input.orderBidWei) !== BigInt(input.expectedPriceWei)) {
    throw new Error("This offer's price no longer matches what was shown. Refresh and try again.");
  }
  return { to: input.to, valueWei };
}

function arrayifyArgs(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(arrayifyArgs);
  if (value && typeof value === "object") return Object.values(value as Record<string, unknown>).map(arrayifyArgs);
  return value;
}

/**
 * Pure: turn OpenSea's `transaction` into hex calldata. OpenSea returns
 * `input_data` as the decoded argument object keyed in ABI order (its
 * `function` field is the full signature with tuple types); when it is
 * already hex it is used verbatim.
 */
export function encodeOpenSeaFulfillmentCalldata(tx: Pick<OpenSeaFulfillmentTransaction, "function" | "input_data">): string {
  if (typeof tx.input_data === "string") {
    if (!/^0x[0-9a-fA-F]*$/.test(tx.input_data) || tx.input_data.length < 10) {
      throw new Error("OpenSea's fulfillment calldata is not hex.");
    }
    return tx.input_data;
  }
  const signature = tx.function.trim();
  const name = signature.slice(0, signature.indexOf("("));
  if (!name) throw new Error("OpenSea's fulfillment transaction has no function signature.");
  const iface = new Interface([`function ${signature}`]);
  const args = tx.input_data && typeof tx.input_data === "object" ? (arrayifyArgs(tx.input_data) as unknown[]) : [];
  return iface.encodeFunctionData(name, args);
}

/**
 * Accept an OpenSea offer -- the NFT owner becomes the Seaport fulfiller,
 * paying nothing and receiving the bid amount while Seaport pulls the token
 * from them.
 *
 * AUDIT lens 3 #5 / D4 + RESEARCH R3 (5) (2026-09-06): token-specific,
 * collection-wide (root 0) and trait (non-zero root) offers all go through
 * ONE path now -- OpenSea's `/offers/fulfillment_data` with
 * `consideration.{asset_contract_address, token_id}` resolves the criteria
 * proof server-side and returns `fulfillment_data.transaction`; this
 * function sends that calldata verbatim through sendForeignTransaction
 * after assertOfferFulfillmentCalldata (to == Seaport, value == 0, bid ==
 * displayed price). No homemade Merkle proof, ever.
 *
 * The seller's conduit approval for the token is a separate, ordinary
 * `setApprovalForAll`/`approve` the wallet must already hold (OpenSea's own
 * gotcha: "seller must have approved the conduit"); seaport-js's fulfillOrder
 * would insert it for a token-specific order, so for parity this function
 * builds that approval step via seaport-js first (approval only -- the
 * fulfillment itself is OpenSea's calldata, not seaport-js's).
 */
export async function acceptForeignOffer(input: {
  chainSlug: string;
  orderHash: string;
  accountAddress: string;
  /** The token the seller delivers -- required for collection-wide / trait offers, optional for a token-specific one. */
  tokenId?: string;
  /** The collection contract (OpenSea's consideration.asset_contract_address). */
  contractAddress: string;
  /** The price the UI showed for this offer, wei -- asserted against the signed order's bid. */
  expectedPriceWei: string;
}): Promise<{ txHash: string }> {
  const params = chainParamsFor(input.chainSlug);
  if (!/^0x[0-9a-fA-F]{40}$/.test(input.contractAddress)) throw new Error("A collection contract is required to accept this offer.");

  const fulfillRes = await fetch("/api/market/multichain/offer-fulfillment-data", {
    method: "POST",
    headers: { "content-type": "application/json" },
    signal: AbortSignal.timeout(15_000),
    body: JSON.stringify({
      chainSlug: input.chainSlug,
      orderHash: input.orderHash,
      fulfillerAddress: input.accountAddress,
      tokenId: input.tokenId,
      contractAddress: input.contractAddress,
    }),
  });
  if (!fulfillRes.ok) {
    const body = await fulfillRes.text().catch(() => "");
    let message = body.slice(0, 200);
    try {
      const parsed = JSON.parse(body) as { message?: string; error?: string };
      message = parsed.message ?? parsed.error ?? message;
    } catch {
      /* raw text */
    }
    throw new Error(`Could not fetch a fulfillable offer (${fulfillRes.status}): ${message}`);
  }
  const { parameters, signature, transaction } = (await fulfillRes.json()) as {
    parameters: { offer: Array<{ itemType: number | string; startAmount: string }> };
    signature: string;
    transaction: OpenSeaFulfillmentTransaction;
  };

  const orderBidWei = parameters.offer.reduce((sum, item) => {
    const t = Number(item.itemType);
    return t === 0 || t === 1 ? sum + BigInt(item.startAmount) : sum;
  }, BigInt(0));
  const checked = assertOfferFulfillmentCalldata({
    to: transaction.to,
    value: transaction.value,
    orderBidWei,
    expectedPriceWei: input.expectedPriceWei,
  });
  const data = encodeOpenSeaFulfillmentCalldata(transaction);

  // Approval step only (never seaport-js's own fulfillment transaction):
  // build the actions for this order so the collection approval -- if the
  // wallet lacks it -- is sent through the same allowlisted path first.
  const { seaport } = await connectedSeaport(input.chainSlug);
  const { actions } = await seaport.fulfillOrder({
    order: { parameters, signature } as Parameters<Seaport["fulfillOrder"]>[0]["order"],
    accountAddress: input.accountAddress,
    exactApproval: true,
  });
  const approvals = (actions as unknown as SeaportAction[]).filter((a) => a.type === "approval");
  await executeActions(approvals, input.accountAddress, input.chainSlug, input.contractAddress);

  const txHash = await sendForeignTransaction({
    to: checked.to,
    from: input.accountAddress,
    data,
    value: checked.valueWei.toString(),
    ...params,
    contractAddress: input.contractAddress,
  });
  await waitForTransaction(txHash, { label: "Accept offer" });
  return { txHash };
}
