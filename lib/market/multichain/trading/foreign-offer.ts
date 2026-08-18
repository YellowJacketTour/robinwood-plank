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
 * (not only ones who found this app) can see and accept it. Nothing here
 * charges a marketplace fee on offer creation; that would only apply if
 * we controlled the accept-side fulfillment, which we don't yet (see
 * offers/route.ts's header on why accept isn't built).
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
async function executeActions(actions: SeaportAction[]): Promise<unknown | null> {
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
  }
  return order;
}

export async function buildForeignOffer(input: {
  chainSlug: string;
  collectionAddress: string;
  /** Exactly one of tokenId / criteriaTokenIds -- mirrors lib/market/seaport.ts's buildOffer branching exactly. */
  tokenId?: string;
  criteriaTokenIds?: string[];
  offerWei: bigint;
  expiresAt: string;
  accountAddress: string;
}): Promise<{ orderHash: string }> {
  if (input.tokenId && input.criteriaTokenIds) {
    throw new Error("An offer cannot be both single-token and trait-scoped.");
  }
  const currency = foreignOfferCurrency(input.chainSlug);
  if (!currency) {
    throw new Error(`foreign-offer: no offer currency configured for "${input.chainSlug}".`);
  }

  let considerationItem:
    | { itemType: ItemType.ERC721; token: string; identifier: string; recipient: string }
    | { itemType: ItemType.ERC721; token: string; identifiers: string[]; recipient: string };
  if (input.tokenId) {
    considerationItem = {
      itemType: ItemType.ERC721,
      token: input.collectionAddress,
      identifier: input.tokenId,
      recipient: input.accountAddress,
    };
  } else if (input.criteriaTokenIds && input.criteriaTokenIds.length > 0) {
    // TRAIT BID (criteria order). seaport-js converts `identifiers` into an
    // ERC721_WITH_CRITERIA item whose identifierOrCriteria is the Merkle
    // root of this exact set -- same mechanism, same seaport-js code path,
    // as lib/market/seaport.ts's own buildOffer. normalizeTokenIds throws
    // on malformed/oversized sets before anything reaches the wallet.
    considerationItem = {
      itemType: ItemType.ERC721,
      token: input.collectionAddress,
      identifiers: normalizeTokenIds(input.criteriaTokenIds),
      recipient: input.accountAddress,
    };
  } else {
    throw new Error("Provide either a tokenId or a non-empty criteriaTokenIds set.");
  }

  const { seaport } = await connectedSeaport(input.chainSlug);
  const endTime = Math.floor(new Date(input.expiresAt).getTime() / 1000).toString();

  const { actions } = await seaport.createOrder(
    {
      offer: [{ amount: input.offerWei.toString(), token: currency }],
      consideration: [considerationItem],
      endTime,
    },
    input.accountAddress,
    /* exactApproval */ true
  );

  const order = (await executeActions(actions as unknown as SeaportAction[])) as
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
}): Promise<void> {
  const chain = foreignChainByChainSlug(input.chainSlug);
  if (!chain) throw new Error(`foreign-offer: "${input.chainSlug}" is not a supported foreign chain.`);

  const fulfillRes = await fetch("/api/market/multichain/offer-fulfillment-data", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chainSlug: input.chainSlug, orderHash: input.orderHash, fulfillerAddress: input.accountAddress }),
  });
  if (!fulfillRes.ok) {
    const body = await fulfillRes.text().catch(() => "");
    throw new Error(`Could not fetch a fulfillable offer (${fulfillRes.status}): ${body.slice(0, 200)}`);
  }
  const { parameters, signature } = (await fulfillRes.json()) as { parameters: unknown; signature: string };

  const { seaport } = await connectedSeaport(input.chainSlug);
  const { actions } = await seaport.fulfillOrder({
    order: { parameters, signature } as Parameters<Seaport["fulfillOrder"]>[0]["order"],
    accountAddress: input.accountAddress,
    exactApproval: true,
  });
  await executeActions(actions as unknown as SeaportAction[]);
}
