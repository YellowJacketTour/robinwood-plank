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
  assertRoyaltyConfig,
  bpsFromRoyaltyAmount,
  decodeRoyaltyInfo,
  encodeRoyaltyInfo,
  ROYALTY_PROBE_PRICE_WEI,
} from "@/lib/market/royalty";
import type { Eip1193Provider } from "@/lib/wallet";
import {
  ensureChain,
  ensureRobinhoodChain,
  getEthereumProvider,
  sendForeignTransaction,
  sendTransaction,
  waitForTransaction,
} from "@/lib/wallet";
import { FOREIGN_SEAPORT_ADDRESS } from "@/lib/market/multichain/trading/foreign-chain-registry";

/**
 * Marketplace fee for one order, as a Seaport `fees` entry. `feeBps` comes
 * from the collection's own config (lib/market/collections.ts) — 0 means no
 * fee item is added at all, not a fee item worth zero.
 */
function feesFor(feeBps: number, royalty?: Fee): Fee[] | undefined {
  const fees = royalty ? [royalty] : [];
  if (feeBps > 0) {
    fees.push({ recipient: MARKET_FEE_RECIPIENT, basisPoints: feeBps });
  }
  return fees.length > 0 ? fees : undefined;
}

/**
 * Reads the live EIP-2981 response immediately before signing. The collection
 * config is an expected deployment value; the wallet's chain read is the
 * source that decides whether signing may continue. This catches a changed
 * receiver or royalty rate instead of silently signing an order that the
 * collection no longer describes.
 */
async function royaltyFeeFor(
  tokenAddress: string,
  tokenId: string,
  expectedBps: number,
  expectedRecipient: string
): Promise<Fee | undefined> {
  if (!expectedBps || expectedBps <= 0) return undefined;
  const expected = assertRoyaltyConfig({ bps: expectedBps, receiver: expectedRecipient });
  const provider = getEthereumProvider();
  if (!provider) throw new Error("No wallet found.");
  const raw = await provider.request({
    method: "eth_call",
    params: [
      {
        to: tokenAddress,
        data: encodeRoyaltyInfo(BigInt(tokenId).toString(), ROYALTY_PROBE_PRICE_WEI),
      },
      "latest",
    ],
  });
  const live = decodeRoyaltyInfo(String(raw));
  const liveBps = bpsFromRoyaltyAmount(live.amountWei, ROYALTY_PROBE_PRICE_WEI);
  if (liveBps !== expected.bps || live.receiver !== expected.receiver) {
    throw new Error(
      `Royalty changed on-chain: expected ${expected.bps} bps to ${expected.receiver}.`
    );
  }
  return { recipient: live.receiver, basisPoints: liveBps };
}

const ERC721_IFACE = new Interface([
  "function isApprovedForAll(address owner, address operator) view returns (bool)",
  "function setApprovalForAll(address operator, bool approved)",
  "function getApproved(uint256 tokenId) view returns (address)",
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

/**
 * Identifies one (owner, token contract, operator) triple whose
 * `isApprovedForAll` read should be reported as `true` to seaport-js, because
 * this module has ALREADY independently confirmed — via a direct getApproved
 * eth_call, see checkPerTokenApprovalSpoof below — that the owner granted a
 * valid PER-TOKEN approval covering the exact token being transferred. Never
 * constructed except after that positive on-chain confirmation.
 */
export type ApprovalSpoof = { owner: string; token: string; operator: string };

/**
 * Wraps an injected EIP-1193 provider so that each `isApprovedForAll(owner,
 * operator)` eth_call matching one of `spoofs` (by token address AND decoded
 * owner/operator) answers `true`, and every other request (including every
 * other eth_call, the eventual eth_sendTransaction, chain reads, etc.) passes
 * through untouched.
 *
 * WHY: seaport-js's own approval pre-flight (lib/utils/approval.js) only ever
 * calls `isApprovedForAll` — it never calls ERC-721 `getApproved(tokenId)`,
 * so a seller/bidder who granted a single-token `approve` instead of a
 * blanket `setApprovalForAll` reads as having NO approval at all, and
 * seaport-js throws before the wallet ever opens, even though the order is
 * genuinely fillable on-chain (Seaport itself calls transferFrom, and
 * `getApproved(tokenId) == Seaport` is sufficient for that call to succeed).
 * Proven against the real Seaport 1.6 runtime bytecode in
 * test/contracts/SeaportPerTokenApproval.test.ts.
 *
 * `spoofs` is a LIST, not one triple, because a batch fulfillment
 * (sweepFloor's fulfillOrders) runs this exact same `isApprovedForAll` check
 * once per order in the batch — each covering a potentially different
 * (owner, token) pair — and every read seaport-js performs during that one
 * `getSeaport()` session shares this one wrapped provider. A single-order
 * fill just passes a one-element list.
 *
 * GRAIN, and it matters: an entry is (owner, collection, operator), because
 * that is all `isApprovedForAll` takes — there is no tokenId in it. Each entry
 * is confirmed against ONE token's `getApproved`, so within a batch the
 * confirmation is per-token while the enforcement is per-collection. A caller
 * passing several orders from the SAME owner and collection must therefore
 * only pass a spoof for that pair when EVERY such order was confirmed —
 * otherwise a confirmed sibling would answer `true` for an unapproved one.
 * sweepFloor does exactly that grouping; see the comment there.
 *
 * This spoof lets seaport-js's OWN vetted transaction-building code run
 * completely unmodified — fulfillBasicOrder vs fulfillStandardOrder vs
 * fulfillAvailableOrders selection, fee-recipient handling, everything — so
 * we never hand-encode Seaport calldata ourselves and never touch its
 * fund-flow logic. We only correct the specific incomplete reads, and only
 * after confirming the truth of each one independently.
 */
export function wrapProviderWithApprovalSpoof(
  base: Eip1193Provider,
  spoofs: ApprovalSpoof[]
): Eip1193Provider {
  // Present in ERC721_IFACE's literal ABI above — never actually null.
  const selector = ERC721_IFACE.getFunction("isApprovedForAll")!.selector.toLowerCase();
  return new Proxy(base, {
    get(target, prop, receiver) {
      if (prop === "request") {
        return async (args: { method: string; params?: unknown[] | object }) => {
          if (args.method === "eth_call") {
            const call = (args.params as unknown[] | undefined)?.[0] as
              | { to?: string; data?: string }
              | undefined;
            if (
              call?.to &&
              typeof call.data === "string" &&
              call.data.toLowerCase().startsWith(selector)
            ) {
              try {
                const [owner, operator] = ERC721_IFACE.decodeFunctionData(
                  "isApprovedForAll",
                  call.data
                );
                const matched = spoofs.some(
                  (spoof) =>
                    call.to!.toLowerCase() === spoof.token.toLowerCase() &&
                    String(owner).toLowerCase() === spoof.owner.toLowerCase() &&
                    String(operator).toLowerCase() === spoof.operator.toLowerCase()
                );
                if (matched) {
                  return ERC721_IFACE.encodeFunctionResult("isApprovedForAll", [true]);
                }
              } catch {
                /* Malformed call data — fall through to the real read. */
              }
            }
          }
          return target.request(args);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
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
 *
 * `approvalSpoofs`, when given a non-empty list, is applied via
 * wrapProviderWithApprovalSpoof — see that function for why (single-order
 * fills pass one entry; sweepFloor may pass several, one per order). Every
 * other call, including the eventual broadcast, is completely unaffected.
 */
/**
 * Describes a target chain for the Marketplank-native foreign-chain listing
 * feature. Every seaport.ts function below that touches a chain takes this
 * as an OPTIONAL parameter, defaulting to Robinhood Chain when omitted --
 * every existing call site (all Robinhood-chain-only today) needs zero
 * changes. seaportAddress is expected to be FOREIGN_SEAPORT_ADDRESS
 * (foreign-chain-registry.ts), which this file's own startup assertion
 * (below) confirms matches Robinhood's SEAPORT_ADDRESS exactly -- the whole
 * "no new contract deployment needed" premise rests on that equality being
 * checked, not silently assumed.
 */
export type SeaportChain = {
  chainSlug: string;
  chainId: number;
  chainName: string;
  nativeCurrencySymbol: string;
  rpcUrl: string;
  blockExplorerUrl: string;
  seaportAddress: string;
};

if (FOREIGN_SEAPORT_ADDRESS.toLowerCase() !== SEAPORT_ADDRESS.toLowerCase()) {
  throw new Error(
    "seaport.ts: FOREIGN_SEAPORT_ADDRESS no longer matches Robinhood Chain's SEAPORT_ADDRESS -- " +
      "the Marketplank-native foreign-chain listing feature assumes these are the same canonical " +
      "Seaport deployment on every chain. Re-verify live via eth_getCode on every FOREIGN_CHAINS " +
      "entry before touching this assertion."
  );
}

export async function getSeaport(
  approvalSpoofs?: ApprovalSpoof | ApprovalSpoof[],
  chain?: SeaportChain
): Promise<Seaport> {
  if (chain) {
    await ensureChain({
      chainId: chain.chainId,
      name: chain.chainName,
      nativeCurrencySymbol: chain.nativeCurrencySymbol,
      rpcUrl: chain.rpcUrl,
      blockExplorerUrl: chain.blockExplorerUrl,
    });
  } else {
    await ensureRobinhoodChain();
  }
  const injected = getEthereumProvider();
  if (!injected) throw new Error("No wallet found.");
  const spoofs = approvalSpoofs
    ? Array.isArray(approvalSpoofs)
      ? approvalSpoofs
      : [approvalSpoofs]
    : [];
  const effectiveProvider =
    spoofs.length > 0 ? wrapProviderWithApprovalSpoof(injected, spoofs) : injected;

  const provider = new BrowserProvider(effectiveProvider, {
    chainId: chain ? chain.chainId : CHAIN.id,
    name: chain ? chain.chainName : CHAIN.name,
  });
  const signer = await provider.getSigner();
  // seaport-js ships its own ethers type declarations; TS sees the ESM vs
  // CJS entry points of the *same* installed ethers version as nominally
  // different types (dual-package-hazard on the private class fields).
  // Runtime object is identical — cast is safe.
  return new Seaport(signer as unknown as ConstructorParameters<typeof Seaport>[0], {
    overrides: { contractAddress: chain ? chain.seaportAddress : SEAPORT_ADDRESS },
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
  accountAddress: string,
  chain?: SeaportChain,
  /** The ONE collection contract this whole action sequence is for -- required when chain is given, see sendForeignTransaction/assertSafeForeignMarketDestination. */
  contractAddress?: string
): Promise<{ order: unknown | null; txHashes: string[] }> {
  if (chain && !contractAddress) {
    throw new Error("executeActionsViaWallet: contractAddress is required for a foreign-chain action sequence.");
  }
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
    const value = tx.value !== undefined && tx.value !== null ? tx.value.toString() : undefined;
    const hash = chain
      ? await sendForeignTransaction({
          to: tx.to,
          from: accountAddress,
          data: tx.data,
          value,
          chainSlug: chain.chainSlug,
          chainId: chain.chainId,
          chainName: chain.chainName,
          nativeCurrencySymbol: chain.nativeCurrencySymbol,
          rpcUrl: chain.rpcUrl,
          blockExplorerUrl: chain.blockExplorerUrl,
          contractAddress: contractAddress!,
        })
      : await sendTransaction({
          to: tx.to,
          from: accountAddress,
          data: tx.data,
          value,
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
  /** Gross buyer payment; Seaport deducts the configured fees from the seller leg. */
  considerationWei: string;
  /** ISO 8601; converted to unix seconds for Seaport internally. */
  expiresAt: string;
  /** From the collection's config (lib/market/collections.ts) — 0 for $PLANK. */
  feeBps: number;
  /** EIP-2981 royalty config expected for this collection. */
  royaltyBps: number;
  royaltyRecipient: string;
};

/**
 * Builds and signs a fixed-price sell order. Seaport-js deducts the configured
 * creator royalty and marketplace fee from the seller's consideration leg,
 * then appends those amounts as signed consideration items. `considerationWei`
 * is therefore the gross buyer payment; the seller receives the remainder.
 *
 * exactApproval=true: seaport-js grants a single-token ERC-721 `approve`
 * instead of `setApprovalForAll(Seaport, true)` over the whole collection —
 * the approval is consumed by the transfer, leaving nothing dangling if the
 * user cancels at the signature prompt.
 */
export async function buildListing(accountAddress: string, input: ListInput, chain?: SeaportChain) {
  const seaport = await getSeaport(undefined, chain);
  const endTime = Math.floor(new Date(input.expiresAt).getTime() / 1000).toString();
  const royalty = await royaltyFeeFor(
    input.offerTokenAddress,
    input.offerTokenId,
    input.royaltyBps,
    input.royaltyRecipient
  );

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
      fees: feesFor(input.feeBps, royalty),
      endTime,
    },
    accountAddress,
    /* exactApproval */ true
  );

  const { order } = await executeActionsViaWallet(
    actions as unknown as SeaportAction[],
    accountAddress,
    chain,
    input.offerTokenAddress
  );
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
  /** EIP-2981 royalty config expected for this collection. */
  royaltyBps: number;
  royaltyRecipient: string;
  /** Foreign-chain offers only — falls back to MARKET_OFFER_CURRENCY (Robinhood Chain's WETH) when omitted. Source from foreignOfferCurrency(chainSlug) for a foreign chain. */
  offerCurrency?: string;
};

/**
 * Builds and signs an item-level offer, denominated in WETH (Seaport cannot
 * pull native ETH from an offerer at fulfillment). Creator royalty and the
 * marketplace fee are consideration legs deducted from the offer amount, so
 * the seller receives the validated net amount.
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
export async function buildOffer(accountAddress: string, input: OfferInput, chain?: SeaportChain) {
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
  const seaport = await getSeaport(undefined, chain);
  const endTime = Math.floor(new Date(input.expiresAt).getTime() / 1000).toString();
  const royaltyTokenId = input.considerationTokenId ?? input.criteriaTokenIds?.[0];
  if (input.royaltyBps > 0 && !royaltyTokenId) {
    throw new Error("A royalty-bearing offer needs a token or trait snapshot.");
  }
  const royalty = royaltyTokenId
    ? await royaltyFeeFor(
        input.considerationTokenAddress,
        royaltyTokenId,
        input.royaltyBps,
        input.royaltyRecipient
      )
    : undefined;

  const { actions } = await seaport.createOrder(
    {
      offer: [
        {
          amount: input.offerWei,
          token: input.offerCurrency ?? MARKET_OFFER_CURRENCY,
        },
      ],
      consideration: [considerationItem],
      fees: feesFor(input.feeBps, royalty),
      endTime,
    },
    accountAddress,
    /* exactApproval */ true
  );

  const { order } = await executeActionsViaWallet(
    actions as unknown as SeaportAction[],
    accountAddress,
    chain,
    input.considerationTokenAddress
  );
  if (!order) throw new Error("Offer was not signed.");
  return order;
}

/** The only conduit shape order-validation.ts lets onto the book — see there. */
const ZERO_CONDUIT_KEY =
  "0x0000000000000000000000000000000000000000000000000000000000000000";

export type FulfillableOrder = Parameters<Seaport["fulfillOrder"]>[0]["order"];

/**
 * Given the exact (owner, token, tokenId) a fulfillment is about to require
 * approval for, POSITIVELY confirms on-chain whether seaport-js's
 * `isApprovedForAll`-only pre-flight would misread a real approval as
 * missing. Returns an ApprovalSpoof only when:
 *   - `isApprovedForAll(owner, Seaport)` is genuinely false (if it were true,
 *     seaport-js's own check already succeeds — nothing to fix), AND
 *   - `getApproved(tokenId)` is exactly the Seaport contract.
 *
 * Any read failure, mismatch, or absent approval returns null — the caller
 * must then let seaport-js's normal path (and its normal error) run
 * unmodified. This function only ever asserts a fact it has itself checked;
 * it is never told to trust a claim from the caller.
 */
export type ApprovalReader = (
  owner: string,
  token: string,
  tokenId: string
) => Promise<ApprovalSpoof | null>;

async function checkPerTokenApprovalSpoof(
  owner: string,
  token: string,
  tokenId: string
): Promise<ApprovalSpoof | null> {
  try {
    const [allHex, approvedHex] = await Promise.all([
      ethCall(token, ERC721_IFACE.encodeFunctionData("isApprovedForAll", [owner, SEAPORT_ADDRESS])),
      ethCall(token, ERC721_IFACE.encodeFunctionData("getApproved", [tokenId])),
    ]);
    const isApprovedForAll = allHex !== "0x" && BigInt(allHex) !== BigInt(0);
    if (isApprovedForAll) return null; // Normal path already works — nothing to fix.
    if (!approvedHex || approvedHex === "0x") return null; // Unreadable — fail closed.
    const [approvedAddress] = ERC721_IFACE.decodeFunctionResult("getApproved", approvedHex) as unknown as [
      string,
    ];
    if (String(approvedAddress).toLowerCase() !== SEAPORT_ADDRESS.toLowerCase()) return null;
    return { owner, token, operator: SEAPORT_ADDRESS };
  } catch {
    return null; // A reverting/erroring read is not a confirmed approval.
  }
}

/**
 * Inspects a to-be-fulfilled order for the ONE ERC-721 item whose approval
 * seaport-js's offerer/fulfiller balance-and-approval check will actually
 * gate, and — only for the zero-conduit shape this marketplace produces —
 * checks whether that specific item has a confirmed per-token approval that
 * seaport-js's own pre-flight would misread as absent.
 *
 * Three order shapes, matching order-validation.ts:
 *   - LISTING (buy): the offerer's single ERC-721 offer item.
 *   - PLAIN OFFER (accept): the fulfiller's single fixed-id ERC-721
 *     consideration item.
 *   - TRAIT OFFER (accept): the fulfiller's criteria-typed consideration
 *     item, resolved to the concrete token id via the caller-supplied
 *     considerationCriteria (already proof-verified upstream by
 *     assertAcceptableTraitOffer before this ever runs).
 *
 * Anything else (non-zero conduit, multiple NFT items, no NFT item) returns
 * null and the normal seaport-js path runs untouched.
 *
 * `checkApproval` defaults to the real on-chain reader; tests inject a fake
 * so the SHAPE-SELECTION logic above (which item, which holder, gated on
 * zero conduit) is exercised without a wallet/provider in the loop.
 */
export async function computeApprovalSpoof(
  order: FulfillableOrder,
  accountAddress: string,
  considerationCriteria?: InputCriteria[],
  checkApproval: ApprovalReader = checkPerTokenApprovalSpoof
): Promise<ApprovalSpoof | null> {
  const params = order.parameters;
  const conduitKey = params.conduitKey;
  const isZeroConduit =
    conduitKey === undefined ||
    conduitKey === null ||
    conduitKey.toLowerCase() === ZERO_CONDUIT_KEY;
  if (!isZeroConduit) return null;

  const offerNfts = params.offer.filter((item) => Number(item.itemType) === ItemType.ERC721);
  if (offerNfts.length === 1) {
    const item = offerNfts[0];
    return checkApproval(params.offerer, item.token, item.identifierOrCriteria);
  }

  const considerationFixedNfts = params.consideration.filter(
    (item) => Number(item.itemType) === ItemType.ERC721
  );
  const considerationCriteriaNfts = params.consideration.filter(
    (item) => Number(item.itemType) === ItemType.ERC721_WITH_CRITERIA
  );
  if (considerationFixedNfts.length === 1 && considerationCriteriaNfts.length === 0) {
    const item = considerationFixedNfts[0];
    return checkApproval(accountAddress, item.token, item.identifierOrCriteria);
  }
  if (considerationCriteriaNfts.length === 1 && considerationCriteria?.length === 1) {
    const identifier = considerationCriteria[0]?.identifier;
    if (identifier !== undefined) {
      return checkApproval(accountAddress, considerationCriteriaNfts[0].token, identifier);
    }
  }

  return null;
}

/**
 * Fulfills an existing signed order (buy a listing, or accept an offer).
 * Every tx (including any approval seaport-js derives FROM THE ORDER — the
 * exact vector the accept-offer audit finding exploited) is routed through
 * lib/wallet.ts, so an order whose fulfillment would touch a contract outside
 * the market allowlist is blocked before the wallet ever pops.
 *
 * BEFORE calling seaport-js, computeApprovalSpoof checks whether this order's
 * relevant ERC-721 item has a confirmed per-token approval that seaport-js's
 * own `isApprovedForAll`-only pre-flight would misread as missing (see that
 * function, and wrapProviderWithApprovalSpoof, for the full reasoning). When
 * confirmed, getSeaport() is asked to correct exactly that one read so
 * seaport-js's normal, fully-vetted order-building code proceeds instead of
 * throwing before the wallet opens. Every other call this makes — the
 * eth_call simulation and the eventual send in executeActionsViaWallet — is
 * completely unaffected by the spoof and still runs against reality.
 */
/**
 * The ERC-721 collection contract an order actually moves -- checks the
 * offer side first (fulfilling a listing: seller offered the NFT), then the
 * consideration side (fulfilling an offer: bidder's consideration is the
 * NFT), same scan order computeApprovalSpoof above already uses. Needed for
 * a foreign-chain fulfillment's destination allowlist (see
 * assertSafeForeignMarketDestination) -- Robinhood-chain fulfillment
 * doesn't need this (its allowlist is the build-time MARKET_DESTINATIONS
 * set, unrelated to which specific order is being fulfilled).
 */
function erc721ContractOf(order: FulfillableOrder): string | null {
  const params = order.parameters;
  const offerNft = params.offer.find(
    (item) => Number(item.itemType) === ItemType.ERC721 || Number(item.itemType) === ItemType.ERC721_WITH_CRITERIA
  );
  if (offerNft) return offerNft.token;
  const considerationNft = params.consideration.find(
    (item) => Number(item.itemType) === ItemType.ERC721 || Number(item.itemType) === ItemType.ERC721_WITH_CRITERIA
  );
  return considerationNft?.token ?? null;
}

export async function fulfillOrder(
  order: FulfillableOrder,
  accountAddress: string,
  /**
   * For TRAIT-criteria bids only: the concrete token id being delivered plus
   * its Merkle proof against the order's committed root. seaport-js folds this
   * into the CriteriaResolver array of fulfillAdvancedOrder. Callers must
   * obtain it from assertAcceptableTraitOffer — never construct it ad hoc.
   */
  considerationCriteria?: InputCriteria[],
  chain?: SeaportChain
) {
  const approvalSpoof = await computeApprovalSpoof(order, accountAddress, considerationCriteria);
  const seaport = await getSeaport(approvalSpoof ?? undefined, chain);
  const { actions } = await seaport.fulfillOrder({
    order,
    accountAddress,
    ...(considerationCriteria ? { considerationCriteria } : {}),
    // ERC-721: single-token approve, not setApprovalForAll; ERC-20: bounded
    // allowance, not 2^256-1.
    exactApproval: true,
  });
  if (chain) {
    const contractAddress = erc721ContractOf(order);
    if (!contractAddress) {
      throw new Error("fulfillOrder: could not determine this order's collection contract for the foreign-chain allowlist.");
    }
    return executeActionsViaWallet(actions as unknown as SeaportAction[], accountAddress, chain, contractAddress);
  }
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
 *
 * APPROVAL SPOOF (batch): seaport-js's fulfillOrders runs the SAME
 * `isApprovedForAll`-only offerer check as the single-order path, once per
 * order in the batch (validateStandardFulfillBalancesAndApprovals inside its
 * fulfillAvailableOrders, called from the forEach over every order — same
 * throwOnInsufficientApprovals: true as the single-fulfill path). So a swept
 * listing whose seller granted only a per-token approve has the identical
 * exposure fulfillOrder has, and would abort the WHOLE batch before the
 * wallet opens. Each order gets its own computeApprovalSpoof check — same
 * function, same on-chain confirmation, same fail-closed-on-null behavior —
 * and every confirmed spoof (there can be one per distinct seller/token in
 * the sweep) is handed to getSeaport() together, via
 * wrapProviderWithApprovalSpoof's list form.
 */
export async function sweepFloor(
  items: SweepItem[],
  accountAddress: string,
  collection: MarketCollection,
  expectedTotalWei: string
) {
  // FAIL CLOSED: re-validate + re-price everything against what was displayed.
  assertSweepTotal(items, expectedTotalWei, collection);

  const orders = items.map(
    (item) => item.listing.rawOrder as Parameters<Seaport["fulfillOrder"]>[0]["order"]
  );
  // A spoof is keyed by (owner, collection, operator) because that is all
  // isApprovedForAll takes — it is collection-wide, with no tokenId. Each one is
  // confirmed against ONE token's getApproved, so inside a batch the
  // confirmation is per-token but the enforcement is per-collection. If the same
  // seller has two planks in one sweep and only one is approved, the confirmed
  // one's spoof would answer `true` for the unapproved one as well.
  //
  // So: fail closed per (owner, collection). A spoof survives only when EVERY
  // order in this batch from that seller and collection was independently
  // confirmed. One unconfirmed plank withdraws the spoof for that whole group,
  // and those orders take the normal seaport-js path and its real error.
  // Seaport skips orders it cannot execute and refunds the unspent value, so the
  // cost of failing closed is a smaller sweep — never a wrong charge.
  const perOrder = await Promise.all(
    orders.map((order) => computeApprovalSpoof(order, accountAddress))
  );
  const groupKey = (s: ApprovalSpoof) =>
    `${s.owner.toLowerCase()}|${s.token.toLowerCase()}|${s.operator.toLowerCase()}`;
  const confirmed = new Map<string, ApprovalSpoof>();
  const unconfirmedOwners = new Set<string>();
  for (let i = 0; i < perOrder.length; i += 1) {
    const spoof = perOrder[i];
    if (spoof) {
      confirmed.set(groupKey(spoof), spoof);
      continue;
    }
    // Unconfirmed: record the (offerer, token) it would have belonged to so any
    // sibling order's spoof cannot cover for it.
    const params = (orders[i] as { parameters?: { offerer?: string; offer?: Array<{ token?: string }> } })
      ?.parameters;
    const offerer = params?.offerer;
    const token = params?.offer?.[0]?.token;
    if (offerer && token) {
      unconfirmedOwners.add(
        `${offerer.toLowerCase()}|${token.toLowerCase()}|${SEAPORT_ADDRESS.toLowerCase()}`
      );
    }
  }
  const approvalSpoofs = [...confirmed.entries()]
    .filter(([key]) => !unconfirmedOwners.has(key))
    .map(([, spoof]) => spoof);

  const seaport = await getSeaport(approvalSpoofs);
  const { actions } = await seaport.fulfillOrders({
    fulfillOrderDetails: orders.map((order) => ({ order })),
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
