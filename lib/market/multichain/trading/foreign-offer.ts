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
import { BrowserProvider } from "ethers";
import {
  foreignChainByChainSlug,
  foreignOfferCurrency,
  FOREIGN_SEAPORT_ADDRESS,
} from "@/lib/market/multichain/trading/foreign-chain-registry";
import { getEthereumProvider, ensureChain } from "@/lib/wallet";
import { normalizeTokenIds } from "@/lib/market/criteria";
import { MARKET_FEE_RECIPIENT, MARKETPLANK_FOREIGN_OFFER_FEE_BPS } from "@/lib/constants";

type SeaportTransactionMethods = { buildTransaction: () => Promise<{ to?: string; data?: string; value?: bigint }> };
type SeaportAction = { type: string; transactionMethods?: SeaportTransactionMethods; createOrder?: () => Promise<unknown> };

async function connectedSeaport(chainSlug: string) {
  const chain = foreignChainByChainSlug(chainSlug);
  if (!chain) throw new Error(`foreign-offer: "${chainSlug}" is not a supported foreign chain.`);
  const injected = getEthereumProvider();
  if (!injected) throw new Error("No wallet found.");
  await ensureChain({
    chainId: chain.chainId,
    name: chainSlug,
    nativeCurrencySymbol: "ETH",
    rpcUrl: `https://${chainSlug}.g.alchemy.com/v2/demo`,
    blockExplorerUrl: "",
  });
  const browserProvider = new BrowserProvider(injected, { chainId: chain.chainId, name: chainSlug });
  const signer = await browserProvider.getSigner();
  const seaport = new Seaport(signer as unknown as ConstructorParameters<typeof Seaport>[0], {
    overrides: { contractAddress: FOREIGN_SEAPORT_ADDRESS },
  });
  return { seaport, signer };
}

/** Sequences seaport-js actions exactly like lib/market/seaport.ts's own executeActionsViaWallet, minus the market-tx allowlist (that's Robinhood-Chain-specific) -- WETH approval sends go through the wallet's normal path here. */
async function executeActions(actions: SeaportAction[], signer: Awaited<ReturnType<typeof connectedSeaport>>["signer"]): Promise<unknown | null> {
  let order: unknown | null = null;
  for (const action of actions) {
    if (action.type === "create" && action.createOrder) {
      order = await action.createOrder();
      continue;
    }
    if (!action.transactionMethods) throw new Error(`Unsupported Seaport action "${action.type}".`);
    const tx = await action.transactionMethods.buildTransaction();
    if (!tx.to || !tx.data) throw new Error("Malformed Seaport approval transaction.");
    // No dedicated wallet-tx pre-flight exists for foreign chains (that
    // machinery is Robinhood-Chain-specific) -- the wallet's own
    // simulation/confirmation UI is the safety net here, same as every
    // other raw signer.sendTransaction call in this multichain module.
    //
    // MUST ACTUALLY SEND AND CONFIRM THIS (bug fix, 2026-08-19): this loop
    // previously built the approval transaction and discarded it without
    // ever calling sendTransaction -- a first-time offerer (WETH allowance
    // not yet granted to Seaport's conduit) would sign and submit a real
    // offer that could never be fulfilled, with no error surfaced. Waiting
    // for one confirmation before the next action matters here specifically
    // because the very next action is "create" (the signature request),
    // which must see the allowance already on-chain.
    const sent = await signer.sendTransaction(tx);
    await sent.wait(1);
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

  const { seaport, signer } = await connectedSeaport(input.chainSlug);
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

  const order = (await executeActions(actions as unknown as SeaportAction[], signer)) as
    | { parameters: unknown; signature: string }
    | null;
  if (!order) throw new Error("Offer was not signed.");

  const chain = foreignChainByChainSlug(input.chainSlug)!;
  const res = await fetch("/api/market/multichain/submit-offer", {
    method: "POST",
    headers: { "content-type": "application/json" },
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

/**
 * Accept a token-specific offer -- the NFT owner becomes the Seaport
 * fulfiller, paying nothing and receiving the bid amount while Seaport
 * pulls the token from them (requires the owner to approve Seaport's
 * conduit for this token first; seaport-js's fulfillOrder handles that
 * approval step itself, same as lib/market/seaport.ts's own fulfillOrder).
 *
 * DELIBERATELY LIMITED TO TOKEN-SPECIFIC OFFERS. Collection-wide "any
 * token" bids (itemType 4 ERC721_WITH_CRITERIA, identifierOrCriteria "0")
 * need a Merkle proof against a wildcard root that has no generic
 * resolution -- lib/market/seaport.ts's own buildOffer documents this
 * exact form as "never proven fillable" for the native path too. This
 * function does not attempt it; offers/route.ts tags each offer
 * `acceptable: false` for that case so the UI never offers an Accept
 * button on one.
 */
export async function acceptForeignOffer(input: {
  chainSlug: string;
  orderHash: string;
  accountAddress: string;
  /** Required for collection-wide (wildcard) offers -- the token the seller delivers. */
  tokenId?: string;
}): Promise<void> {
  const chain = foreignChainByChainSlug(input.chainSlug);
  if (!chain) throw new Error(`foreign-offer: "${input.chainSlug}" is not a supported foreign chain.`);

  const fulfillRes = await fetch("/api/market/multichain/offer-fulfillment-data", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chainSlug: input.chainSlug,
      orderHash: input.orderHash,
      fulfillerAddress: input.accountAddress,
      tokenId: input.tokenId,
    }),
  });
  if (!fulfillRes.ok) {
    const body = await fulfillRes.text().catch(() => "");
    throw new Error(`Could not fetch a fulfillable offer (${fulfillRes.status}): ${body.slice(0, 200)}`);
  }
  const { parameters, signature } = (await fulfillRes.json()) as { parameters: unknown; signature: string };

  const { seaport, signer } = await connectedSeaport(input.chainSlug);
  const { actions } = await seaport.fulfillOrder({
    order: { parameters, signature } as Parameters<Seaport["fulfillOrder"]>[0]["order"],
    accountAddress: input.accountAddress,
    exactApproval: true,
  });
  await executeActions(actions as unknown as SeaportAction[], signer);
}
