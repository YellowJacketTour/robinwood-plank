import { Seaport } from "@opensea/seaport-js";
import { ItemType } from "@opensea/seaport-js/lib/constants";
import type { Fee, InputCriteria } from "@opensea/seaport-js/lib/types";
import { BrowserProvider, Interface } from "ethers";
import {
  CHAIN,
  MARKET_FEE_RECIPIENT,
  MARKET_OFFER_CURRENCY,
  NATIVE_TOKEN_ADDRESS,
  SEAPORT_ADDRESS,
} from "@/lib/constants";
import {
  computeCriteriaProof,
  computeCriteriaRoot,
  normalizeTokenIds,
  verifyCriteriaProof,
} from "@/lib/market/criteria";
import type { DerivedOrder } from "@/lib/market/order-validation";
import { assertSweepTotal } from "@/lib/market/sweep";
import type { SweepItem } from "@/lib/market/sweep";
import type { MarketCollection } from "@/lib/market/types";
import {
  ensureRobinhoodChain,
  getEthereumProvider,
  sendTransaction,
  waitForTransaction,
} from "@/lib/wallet";

/**
 * Marketplace fee for one order, as a Seaport `fees` entry. `feeBps` comes
 * from the collection's own config (lib/market/collections.ts) — 0 means no
 * fee item is added at all, not a fee item worth zero.
 */
function feesFor(feeBps: number): Fee[] | undefined {
  if (!feeBps || feeBps <= 0) return undefined;
  return [{ recipient: MARKET_FEE_RECIPIENT, basisPoints: feeBps }];
}

/**
 * Client-side Seaport instance bound to the connected wallet. Always
 * re-checks the chain first — same discipline as lib/wallet.ts's swap path,
 * because a Seaport order signed on the wrong chain is either useless or,
 * worse, replayable somewhere it shouldn't be.
 *
 * SIGNING ONLY runs through the ethers signer below. The STATIC network
 * passed to BrowserProvider pins the EIP-712 domain chainId to 4663, so a
 * mid-flow chainChanged cannot produce a signature for another chain —
 * preserve that property. All BROADCASTS go through lib/wallet.ts
 * sendTransaction() instead (see executeActionsViaWallet), which re-asserts
 * eth_chainId, enforces the destination allowlist, and hard-fails on a
 * reverting eth_call before the wallet popup.
 */
export async function getSeaport(): Promise<Seaport> {
  await ensureRobinhoodChain();
  const injected = getEthereumProvider();
  if (!injected) throw new Error("No wallet found.");

  const provider = new BrowserProvider(injected, {
    chainId: CHAIN.id,
    name: CHAIN.name,
  });
  const signer = await provider.getSigner();
  // seaport-js ships its own ethers type declarations; TS sees the ESM vs
  // CJS entry points of the *same* installed ethers version as nominally
  // different types (dual-package-hazard on the private class fields).
  // Runtime object is identical — cast is safe.
  return new Seaport(signer as unknown as ConstructorParameters<typeof Seaport>[0], {
    overrides: { contractAddress: SEAPORT_ADDRESS },
  });
}

type SeaportTransactionMethods = {
  buildTransaction: () => Promise<{ to?: string; data?: string; value?: bigint }>;
};

type SeaportAction = {
  type: string;
  transactionMethods?: SeaportTransactionMethods;
  createOrder?: () => Promise<unknown>;
};

/**
 * Replacement for seaport-js's executeAllActions(): identical action
 * sequencing, but every on-chain send goes through lib/wallet.ts
 * sendTransaction() (kind "market") so the chain re-check, `to` allowlist and
 * hard-fail pre-flight simulation all run. Each tx is also awaited to a
 * mined receipt before the next action, because a later action's simulation
 * depends on the earlier approval being live.
 *
 * Signature actions ("create") still use seaport-js's own signer path — that
 * is an eth_signTypedData_v4 with the chainId-pinned domain, not a send.
 */
async function executeActionsViaWallet(
  actions: SeaportAction[],
  accountAddress: string
): Promise<{ order: unknown | null; txHashes: string[] }> {
  const txHashes: string[] = [];
  let order: unknown | null = null;

  for (const action of actions) {
    if (action.type === "create" && action.createOrder) {
      order = await action.createOrder();
      continue;
    }
    if (!action.transactionMethods) {
      // Unknown action shape — fail closed rather than silently skip a step.
      throw new Error(`Unsupported Seaport action "${action.type}".`);
    }
    const tx = await action.transactionMethods.buildTransaction();
    if (!tx.to || !tx.data) {
      throw new Error(`Seaport action "${action.type}" built an incomplete transaction.`);
    }
    const hash = await sendTransaction({
      to: tx.to,
      from: accountAddress,
      data: tx.data,
      value: tx.value !== undefined && tx.value !== null ? tx.value.toString() : undefined,
      kind: "market",
    });
    await waitForTransaction(hash, { label: action.type === "approval" ? "Approval" : "Order" });
    txHashes.push(hash);
  }
  return { order, txHashes };
}

export type ListInput = {
  offerTokenAddress: string;
  offerTokenId: string;
  considerationWei: string;
  /** ISO 8601; converted to unix seconds for Seaport internally. */
  expiresAt: string;
  /** From the collection's config (lib/market/collections.ts) — 0 for $PLANK. */
  feeBps: number;
};

/**
 * Builds and signs a fixed-price sell order. When feeBps > 0, seaport-js
 * appends the fee as an additional consideration item automatically — the
 * seller's `considerationWei` amount is what they receive net, the fee is
 * added on top for the buyer to pay, matching how OpenSea's own fee mechanic
 * works.
 *
 * exactApproval=true: seaport-js grants a single-token ERC-721 `approve`
 * instead of `setApprovalForAll(Seaport, true)` over the whole collection —
 * the approval is consumed by the transfer, leaving nothing dangling if the
 * user cancels at the signature prompt.
 */
export async function buildListing(accountAddress: string, input: ListInput) {
  const seaport = await getSeaport();
  const endTime = Math.floor(new Date(input.expiresAt).getTime() / 1000).toString();

  const { actions } = await seaport.createOrder(
    {
      offer: [
        {
          itemType: ItemType.ERC721,
          token: input.offerTokenAddress,
          identifier: input.offerTokenId,
        },
      ],
      consideration: [
        {
          amount: input.considerationWei,
          token: NATIVE_TOKEN_ADDRESS,
          recipient: accountAddress,
        },
      ],
      fees: feesFor(input.feeBps),
      endTime,
    },
    accountAddress,
    /* exactApproval */ true
  );

  const { order } = await executeActionsViaWallet(actions as unknown as SeaportAction[], accountAddress);
  if (!order) throw new Error("Listing was not signed.");
  return order;
}

export type OfferInput = {
  offerWei: string;
  considerationTokenAddress: string;
  /** Set for a single-token bid. Mutually exclusive with criteriaTokenIds. */
  considerationTokenId?: string;
  /**
   * TRAIT BID: the snapshot of token ids this bid is willing to accept
   * (every token currently carrying the chosen trait). seaport-js computes
   * the ERC721_WITH_CRITERIA Merkle root from exactly this list; the same
   * list must be stored with the offer so the accepting seller can compute
   * their fulfillment proof against the identical tree. Fillability of this
   * shape is proven against the real Seaport 1.6 bytecode in
   * test/contracts/SeaportCriteriaFulfill.test.ts.
   */
  criteriaTokenIds?: string[];
  expiresAt: string;
  /** From the collection's config (lib/market/collections.ts) — 0 for $PLANK. */
  feeBps: number;
};

/**
 * Builds and signs an item-level offer, denominated in WETH (Seaport cannot
 * pull native ETH from an offerer at fulfillment).
 *
 * COLLECTION-WIDE OFFERS REMAIN DISABLED (fail closed, audit 2026-07-27): the
 * original criteria-based build produced orders that were unfillable — the
 * fulfill path never supplied a considerationCriteria resolver/proof, so the
 * seller was never asked which token to hand over and fulfillment reverted.
 *
 * TRAIT-SCOPED criteria bids (2026-07-28) ARE supported: the resolver path is
 * now wired (fulfillOrder's considerationCriteria + assertAcceptableTraitOffer)
 * and proven end-to-end against the real deployed Seaport 1.6 bytecode in
 * test/contracts/SeaportCriteriaFulfill.test.ts, including negative cases.
 * The wildcard root-0 "any" form stays off until it gets the same proof.
 *
 * exactApproval=true bounds the WETH allowance to this bid's amount instead
 * of the previous unlimited (2^256-1) approve.
 */
export async function buildOffer(accountAddress: string, input: OfferInput) {
  if (input.considerationTokenId && input.criteriaTokenIds) {
    throw new Error("An offer cannot be both single-token and trait-scoped.");
  }
  let considerationItem:
    | { itemType: ItemType.ERC721; token: string; identifier: string; recipient: string }
    | { itemType: ItemType.ERC721; token: string; identifiers: string[]; recipient: string };
  if (input.considerationTokenId) {
    considerationItem = {
      itemType: ItemType.ERC721,
      token: input.considerationTokenAddress,
      identifier: input.considerationTokenId,
      recipient: accountAddress,
    };
  } else if (input.criteriaTokenIds && input.criteriaTokenIds.length > 0) {
    // TRAIT BID (criteria order). seaport-js converts `identifiers` into an
    // ERC721_WITH_CRITERIA item whose identifierOrCriteria is the Merkle root
    // of this exact set (lib/utils/order.js). normalizeTokenIds throws on
    // malformed/oversized sets BEFORE anything reaches the wallet.
    considerationItem = {
      itemType: ItemType.ERC721,
      token: input.considerationTokenAddress,
      identifiers: normalizeTokenIds(input.criteriaTokenIds),
      recipient: accountAddress,
    };
  } else {
    // Collection-wide ("any") offers stay DISABLED — the wildcard root-0 form
    // was never proven fillable. Trait bids are the supported criteria shape.
    throw new Error(
      "Collection-wide offers are temporarily disabled — bid on a specific token or a trait instead."
    );
  }
  const seaport = await getSeaport();
  const endTime = Math.floor(new Date(input.expiresAt).getTime() / 1000).toString();

  const { actions } = await seaport.createOrder(
    {
      offer: [
        {
          amount: input.offerWei,
          token: MARKET_OFFER_CURRENCY,
        },
      ],
      consideration: [considerationItem],
      fees: feesFor(input.feeBps),
      endTime,
    },
    accountAddress,
    /* exactApproval */ true
  );

  const { order } = await executeActionsViaWallet(actions as unknown as SeaportAction[], accountAddress);
  if (!order) throw new Error("Offer was not signed.");
  return order;
}

/**
 * Fulfills an existing signed order (buy a listing, or accept an offer).
 * Every tx (including any approval seaport-js derives FROM THE ORDER — the
 * exact vector the accept-offer audit finding exploited) is routed through
 * lib/wallet.ts, so an order whose fulfillment would touch a contract outside
 * the market allowlist is blocked before the wallet ever pops.
 */
export async function fulfillOrder(
  order: Parameters<Seaport["fulfillOrder"]>[0]["order"],
  accountAddress: string,
  /**
   * For TRAIT-criteria bids only: the concrete token id being delivered plus
   * its Merkle proof against the order's committed root. seaport-js folds this
   * into the CriteriaResolver array of fulfillAdvancedOrder. Callers must
   * obtain it from assertAcceptableTraitOffer — never construct it ad hoc.
   */
  considerationCriteria?: InputCriteria[]
) {
  const seaport = await getSeaport();
  const { actions } = await seaport.fulfillOrder({
    order,
    accountAddress,
    ...(considerationCriteria ? { considerationCriteria } : {}),
    // ERC-721: single-token approve, not setApprovalForAll; ERC-20: bounded
    // allowance, not 2^256-1.
    exactApproval: true,
  });
  return executeActionsViaWallet(actions as unknown as SeaportAction[], accountAddress);
}

/**
 * "Sweep the floorboards": atomically fill up to SWEEP_MAX independent
 * fixed-price listings in ONE transaction, via seaport-js's fulfillOrders,
 * which encodes Seaport 1.6 `fulfillAvailableAdvancedOrders` with
 * maximumFulfilled = orders.length and numerator/denominator = 1/1 (full
 * fills only — and every order here is validator-enforced FULL_OPEN, so
 * partial fills are impossible at the contract level too).
 *
 * SAFETY:
 * - assertSweepTotal re-derives EVERY order through validateListingOrder at
 *   the moment of send and requires the sum to equal `expectedTotalWei` — the
 *   number on the confirm button. Any drift throws before the wallet opens.
 * - msg.value is computed by seaport-js as the sum of the orders' native
 *   consideration — the same items our validator summed — so displayed total
 *   and charged value are the same figure by construction.
 * - `fulfillAvailableAdvancedOrders` SKIPS orders that became unavailable
 *   (seller cancelled/sold mid-flight) instead of reverting, and Seaport
 *   returns all unspent native value to the caller at the end of the
 *   transaction — the buyer is never charged for an order that didn't fill.
 *   If NO order is fillable the whole tx reverts (NoSpecifiedOrdersAvailable),
 *   so a zero-effect sweep cannot cost more than a failed-tx's gas.
 * - The exchange tx is routed through lib/wallet.ts sendTransaction (kind
 *   "market"): chain re-check, `to` allowlist, hard-fail pre-flight eth_call.
 */
export async function sweepFloor(
  items: SweepItem[],
  accountAddress: string,
  collection: MarketCollection,
  expectedTotalWei: string
) {
  // FAIL CLOSED: re-validate + re-price everything against what was displayed.
  assertSweepTotal(items, expectedTotalWei, collection);

  const seaport = await getSeaport();
  const { actions } = await seaport.fulfillOrders({
    fulfillOrderDetails: items.map((item) => ({
      order: item.listing.rawOrder as Parameters<Seaport["fulfillOrder"]>[0]["order"],
    })),
    accountAddress,
    exactApproval: true,
  });
  // Listings are native-ETH only, so no approval actions are expected — but if
  // seaport-js ever derives one FROM AN ORDER (the accept-offer audit vector),
  // executeActionsViaWallet routes it through the allowlist all the same.
  return executeActionsViaWallet(actions as unknown as SeaportAction[], accountAddress);
}

/**
 * Invalidates EVERY order this account has ever signed, in one transaction, by
 * bumping their Seaport counter.
 *
 * The escape hatch for stale signatures. Cancelling orders individually costs a
 * transaction each and requires knowing which orders exist — and a seller who
 * listed, moved the token elsewhere, and later reacquired it has no way to
 * enumerate the old signatures floating around. One counter bump kills all of
 * them at once, including any this relay never stored.
 *
 * Destructive by design: live listings and offers die too, and re-listing means
 * signing fresh orders. Callers must say so before offering the button.
 */
export async function cancelAllOrders(accountAddress: string): Promise<string> {
  const seaport = await getSeaport();
  const methods = seaport.bulkCancelOrders(accountAddress);
  const tx = await methods.buildTransaction();
  if (!tx.to || !tx.data) throw new Error("Could not build bulk-cancel transaction.");
  const hash = await sendTransaction({
    to: tx.to,
    from: accountAddress,
    data: String(tx.data),
    kind: "market",
  });
  await waitForTransaction(hash, { label: "Cancel all" });
  return hash;
}

/** Cancels one of the caller's own orders on-chain, via the wallet safety rail. */
export async function cancelOrder(
  parameters: Parameters<Seaport["cancelOrders"]>[0][number],
  accountAddress: string
): Promise<string> {
  const seaport = await getSeaport();
  const methods = seaport.cancelOrders([parameters], accountAddress);
  const tx = await methods.buildTransaction();
  if (!tx.to || !tx.data) throw new Error("Could not build cancel transaction.");
  const hash = await sendTransaction({
    to: tx.to,
    from: accountAddress,
    data: String(tx.data),
    kind: "market",
  });
  await waitForTransaction(hash, { label: "Cancel" });
  return hash;
}

/**
 * Cross-check an offer row from the relay against the order re-derived and
 * validated in THIS browser. Pure function so it is unit-testable; the UI
 * must refuse to open the accept flow unless this passes.
 *
 * `derived.priceWei` is the seller's NET proceeds (order-validation OFFER
 * semantics) — the number the confirm modal must display.
 */
export function assertAcceptableOffer(
  offer: { tokenId?: string; priceWei: string },
  derived: DerivedOrder
): void {
  if (!derived.tokenId || !offer.tokenId) {
    // Collection-wide (criteria) offers are disabled — see buildOffer.
    // TRAIT-criteria offers go through assertAcceptableTraitOffer instead.
    throw new Error("This offer is not for a specific token and cannot be accepted.");
  }
  if (derived.tokenId !== offer.tokenId) {
    throw new Error("This offer's token doesn't match its signature.");
  }
  if (derived.priceWei !== offer.priceWei) {
    throw new Error("This offer's price doesn't match its signature.");
  }
}

/**
 * TRAIT-bid counterpart of assertAcceptableOffer, for a seller accepting a
 * criteria bid with token `sellTokenId` they own. Pure and unit-tested.
 *
 * Verifies, in this browser, with no trust in the relay:
 *  - the signed order really is a trait-criteria bid (derived.criteriaRoot,
 *    which validateOfferOrder only sets after recomputing the root from the
 *    stored snapshot and matching it against the signature-covered value);
 *  - the seller's token is IN the committed snapshot;
 *  - the displayed net price equals the signature-derived one;
 *  - the freshly computed Merkle proof passes an independent implementation
 *    of Seaport's own on-chain verification against the committed root.
 *
 * Returns the InputCriteria to hand to fulfillOrder. Throws on any mismatch.
 */
export function assertAcceptableTraitOffer(
  offer: { priceWei: string; criteriaTokenIds?: string[] },
  derived: DerivedOrder,
  sellTokenId: string
): InputCriteria {
  if (!derived.criteriaRoot) {
    throw new Error("This offer is not a trait offer.");
  }
  if (!offer.criteriaTokenIds || offer.criteriaTokenIds.length === 0) {
    throw new Error("This trait offer is missing its token snapshot.");
  }
  if (derived.priceWei !== offer.priceWei) {
    throw new Error("This offer's price doesn't match its signature.");
  }
  const ids = normalizeTokenIds(offer.criteriaTokenIds);
  const root = computeCriteriaRoot(ids);
  if (BigInt(root) !== BigInt(derived.criteriaRoot)) {
    throw new Error("This offer's token snapshot doesn't match its signature.");
  }
  const canonicalId = BigInt(sellTokenId).toString();
  if (!ids.includes(canonicalId)) {
    throw new Error("Your token doesn't qualify for this trait offer.");
  }
  const proof = computeCriteriaProof(ids, canonicalId);
  if (!verifyCriteriaProof(root, canonicalId, proof)) {
    // Construction and verification use independent implementations; a
    // disagreement means something is deeply wrong — never send that fill.
    throw new Error("Could not build a valid fulfillment proof for this offer.");
  }
  return { identifier: canonicalId, proof };
}

// ---------------------------------------------------------------------------
// Approval visibility + revocation (audit finding: blanket approvals could be
// left live with no way to remove them from the UI).
// ---------------------------------------------------------------------------

const ERC721_IFACE = new Interface([
  "function isApprovedForAll(address owner, address operator) view returns (bool)",
  "function setApprovalForAll(address operator, bool approved)",
]);

const ERC20_IFACE = new Interface([
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
]);

async function ethCall(to: string, data: string): Promise<string> {
  const provider = getEthereumProvider();
  if (!provider) throw new Error("No wallet found.");
  return (await provider.request({
    method: "eth_call",
    params: [{ to, data }, "latest"],
  })) as string;
}

export type MarketApprovals = {
  /** setApprovalForAll(collection → Seaport) is live. */
  collectionApprovedForAll: boolean;
  /** Current WETH allowance granted to Seaport, in wei. */
  wethAllowance: bigint;
};

export async function getMarketApprovals(
  accountAddress: string,
  collectionAddress: string
): Promise<MarketApprovals> {
  const [nftHex, wethHex] = await Promise.all([
    ethCall(
      collectionAddress,
      ERC721_IFACE.encodeFunctionData("isApprovedForAll", [accountAddress, SEAPORT_ADDRESS])
    ),
    ethCall(
      MARKET_OFFER_CURRENCY,
      ERC20_IFACE.encodeFunctionData("allowance", [accountAddress, SEAPORT_ADDRESS])
    ),
  ]);
  return {
    collectionApprovedForAll: BigInt(nftHex === "0x" ? 0 : nftHex) !== BigInt(0),
    wethAllowance: BigInt(wethHex === "0x" ? 0 : wethHex),
  };
}

/** Revoke a live setApprovalForAll(collection → Seaport). */
export async function revokeCollectionApproval(
  accountAddress: string,
  collectionAddress: string
): Promise<string> {
  const hash = await sendTransaction({
    to: collectionAddress,
    from: accountAddress,
    data: ERC721_IFACE.encodeFunctionData("setApprovalForAll", [SEAPORT_ADDRESS, false]),
    kind: "market",
  });
  await waitForTransaction(hash, { label: "Revoke" });
  return hash;
}

/** Zero out the WETH allowance granted to Seaport. */
export async function revokeWethApproval(accountAddress: string): Promise<string> {
  const hash = await sendTransaction({
    to: MARKET_OFFER_CURRENCY,
    from: accountAddress,
    data: ERC20_IFACE.encodeFunctionData("approve", [SEAPORT_ADDRESS, BigInt(0)]),
    kind: "market",
  });
  await waitForTransaction(hash, { label: "Revoke" });
  return hash;
}
