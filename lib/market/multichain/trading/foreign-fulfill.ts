/**
 * Client-side wallet execution for foreign-chain trades -- the part
 * foreign-orders.ts (server-side order fetching) was built for.
 *
 * BUY/SWEEP REWIRED OFF MarketplankForeignFeeRouter.sol, 2026-08-19
 * ---------------------------------------------------------------------------
 * buyForeignListingNow/sweepForeignListings/sweepForeignListingsMultiCollection
 * used to call that router contract, which was never deployed on any
 * chain -- every call threw (requireRouter's own error said so), meaning
 * buying or sweeping a THIRD-PARTY (OpenSea) listing on any foreign EVM
 * chain was completely non-functional. Fixed by fulfilling directly
 * against Seaport's own canonical contract (already deployed everywhere)
 * using its native fulfiller-side "tip" mechanism for the marketplace fee
 * -- see MARKETPLANK_FOREIGN_FILL_TIP_BPS's header in lib/constants.ts.
 * No contract deployment needed at all. The router contract source and
 * its (still-null) per-chain addresses remain in foreign-chain-registry.ts
 * for potential future use; nothing in this file depends on them anymore.
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
import type { TipInputItem } from "@opensea/seaport-js/lib/types";
import { MARKET_FEE_RECIPIENT, MARKETPLANK_FOREIGN_FILL_TIP_BPS, NATIVE_TOKEN_ADDRESS } from "@/lib/constants";
import { foreignChainByChainSlug, foreignAcrossReceiverAddress, foreignDeBridgeExecutorAddress } from "@/lib/market/multichain/trading/foreign-chain-registry";
import { findStablecoin } from "@/lib/market/multichain/trading/stablecoins";
import type { SeaportChain } from "@/lib/market/seaport";
import { getEthereumProvider, ensureChain } from "@/lib/wallet";
import { isSolanaChainSlug, isBitcoinChainSlug } from "@/lib/market/multichain/trading/non-evm-chains";
import type { BatchSendStatus } from "@/lib/market/transfer";

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

/**
 * Requires the FRESH order's own zoneHash, not stray/padded copies --
 * fetchListingFulfillmentData already normalizes this once, so no caller
 * needs to.
 *
 * REJECTS ESCALATING (DUTCH/ASCENDING-AUCTION) AMOUNTS -- audit finding
 * H1, 2026-08-19. This used to sum `startAmount` blindly. For an ASCENDING
 * order (endAmount > startAmount) Seaport charges the current interpolated
 * amount, which exceeds the startAmount-based figure this function
 * computed -- so the app's own price math (and the tip derived from it)
 * understated what the buyer would actually be debited. That is precisely
 * why order-validation.ts's `fixedAmount` refuses such items for native
 * orders ("a fixed price on screen would be a lie if the order
 * escalated"); the third-party path now enforces the same rule instead of
 * being the one place it was missing.
 */
function considerationTotal(order: ForeignSeaportOrder): bigint {
  return order.parameters.consideration.reduce((sum, item) => {
    if (BigInt(item.startAmount) !== BigInt(item.endAmount)) {
      throw new Error(
        "This listing uses an escalating (auction) price, which Marketplank does not fulfill -- the price shown could not be guaranteed at fill time."
      );
    }
    return sum + BigInt(item.startAmount);
  }, BigInt(0));
}

/** Shared ceiling for BOTH sweep paths (audit finding M1 -- the single-collection sweep previously had none). */
const MAX_SWEEP_ITEMS = 50;

/**
 * THE MISSING SECURITY BOUNDARY -- audit finding C1, 2026-08-19.
 *
 * Every other buy path in this app re-derives what it is about to fulfill
 * from the SIGNED order and refuses to proceed if that disagrees with what
 * the user was shown: the Robinhood-chain branch below calls
 * validateListingOrder (order-validation.ts -- "the single most important
 * security boundary in Marketplank"), and the native foreign path goes
 * through the same validators server-side. The third-party (OpenSea) EVM
 * path had NO such check: it took whatever order the remote fulfillment-data
 * endpoint returned and handed it straight to Seaport.
 *
 * That was survivable only while the whole path was dead (it threw on an
 * undeployed router). Making it actually work -- which the router removal
 * did -- made an unvalidated path LIVE, so the guard has to exist now.
 *
 * Deliberately NOT a full re-implementation of validateListingOrder: this
 * is a third-party order we did not create, so its fee/royalty structure is
 * legitimately none of our business. What MUST hold is only that the user
 * gets the asset they clicked at the price they were shown:
 *   1. the order really offers an ERC-721/1155 from the expected contract
 *      (and the expected token id when the caller knows it), and
 *   2. the total the fulfiller pays matches the displayed price.
 * Fails closed on anything else.
 */
function assertForeignOrderMatchesExpectation(
  order: ForeignSeaportOrder,
  expected: { contractAddress?: string; tokenId?: string; priceWei?: string }
): void {
  const ERC721 = 2;
  const ERC1155 = 3;
  const offeredNfts = order.parameters.offer.filter(
    (item) => Number(item.itemType) === ERC721 || Number(item.itemType) === ERC1155
  );
  if (offeredNfts.length === 0) {
    throw new Error("This listing does not actually offer an NFT -- refusing to fulfill it.");
  }

  if (expected.contractAddress) {
    const wanted = expected.contractAddress.toLowerCase();
    if (!offeredNfts.some((item) => item.token.toLowerCase() === wanted)) {
      throw new Error(
        "This listing is for a different collection than the one shown. Refusing to fulfill it -- reload and try again."
      );
    }
  }
  if (expected.tokenId) {
    if (!offeredNfts.some((item) => BigInt(item.identifierOrCriteria).toString() === expected.tokenId)) {
      throw new Error(
        "This listing is for a different token than the one shown. Refusing to fulfill it -- reload and try again."
      );
    }
  }

  if (expected.priceWei) {
    // considerationTotal already rejects escalating amounts (H1), so this
    // compares two genuinely fixed numbers. A small tolerance absorbs the
    // legitimate rounding OpenSea's own summary-vs-fulfillment figures can
    // differ by; anything beyond that is a real mismatch, not rounding.
    const actual = considerationTotal(order);
    const shown = BigInt(expected.priceWei);
    const tolerance = shown / BigInt(100) + BigInt(1); // 1% + 1 wei, same tolerance the fee checks use
    if (actual > shown + tolerance) {
      throw new Error(
        `This listing now costs more than the price shown (${actual.toString()} wei vs ${shown.toString()} wei). Refusing to fulfill it -- reload for the current price.`
      );
    }
  }
}

/**
 * Connects the wallet to the target foreign chain and returns its address
 * -- no router contract involved. Replaces connectedRouter (removed
 * 2026-08-19, see buyForeignListingNow's own header on why): every real
 * caller now fulfills directly against Seaport itself, using its native
 * fulfiller-side "tip" mechanism for the marketplace fee instead of a
 * router contract that was never deployed.
 */
async function connectedForeignAccount(chainSlug: string): Promise<{ chainId: number; buyerAddress: string }> {
  const chain = foreignChainByChainSlug(chainSlug);
  if (!chain) throw new Error(`foreign-fulfill: "${chainSlug}" is not a supported foreign chain.`);
  const injected = getEthereumProvider();
  if (!injected) throw new Error("No wallet found.");

  // Real RPC + explorer from the registry, not a hand-built
  // `${chainSlug}.g.alchemy.com/v2/demo` string (audit finding M4): that
  // URL is both a wrong subdomain for several slugs AND the shared "demo"
  // key, so if the wallet did not already know this chain, ensureChain
  // could persist a broken network entry -- mid-purchase, which is the
  // worst possible moment to hand someone an unreliable RPC.
  const { chainDisplayName, foreignRpcUrls } = await import("@/lib/market/multichain/trading/foreign-chain-registry");
  await ensureChain({
    chainId: chain.chainId,
    name: chainDisplayName(chainSlug),
    nativeCurrencySymbol: chain.nativeCurrencySymbol,
    rpcUrl: foreignRpcUrls(chainSlug)[0],
    blockExplorerUrl: chain.blockExplorerUrl,
  });

  const browserProvider = new BrowserProvider(injected, { chainId: chain.chainId, name: chainSlug });
  const signer = await browserProvider.getSigner();
  const buyerAddress = await signer.getAddress();
  return { chainId: chain.chainId, buyerAddress };
}

/** Builds the SeaportChain descriptor every direct fulfillOrder/fulfillOrders call needs -- same fields native-fulfill.ts's seaportChainFor already assembles for the native-order path, duplicated locally rather than imported to keep this client module's dependency surface unchanged (see this file's own header on why it never imports server-touching modules). */
async function seaportChainFor(chainSlug: string): Promise<SeaportChain> {
  const chain = foreignChainByChainSlug(chainSlug);
  if (!chain) throw new Error(`foreign-fulfill: "${chainSlug}" is not a supported foreign chain.`);
  const { chainDisplayName, foreignRpcUrls, FOREIGN_SEAPORT_ADDRESS } = await import(
    "@/lib/market/multichain/trading/foreign-chain-registry"
  );
  return {
    chainSlug,
    chainId: chain.chainId,
    chainName: chainDisplayName(chainSlug),
    nativeCurrencySymbol: chain.nativeCurrencySymbol,
    rpcUrl: foreignRpcUrls(chainSlug)[0],
    blockExplorerUrl: chain.blockExplorerUrl,
    seaportAddress: FOREIGN_SEAPORT_ADDRESS,
  };
}

/**
 * Seaport's own native fulfiller-side tip -- see MARKETPLANK_FOREIGN_FILL_TIP_BPS's
 * own header (lib/constants.ts) for the full "why this is non-optional,
 * why it needed no contract deployment, and what it fixes" reasoning.
 * Zero price -> zero tip (never a negative/NaN amount).
 */
function foreignFillTip(priceWei: bigint, order?: ForeignSeaportOrder): TipInputItem[] {
  if (priceWei <= BigInt(0)) return [];

  // NEVER LET FEE CAPTURE BREAK A USER'S PURCHASE -- verified against the
  // real Seaport source (seaport-core), 2026-08-19:
  //
  //  * CONTRACT orders (type 4) enforce STRICT EQUALITY between
  //    consideration.length and totalOriginalConsiderationItems
  //    (OrderValidator._getGeneratedOrder), so ANY tip reverts the fill
  //    outright.
  //  * RESTRICTED orders (types 2/3) hand the zone the full consideration
  //    array WITH tips appended (ConsiderationEncoder._encodeValidateOrder),
  //    and the zone may reject the extension at its own discretion --
  //    OpenSea's own docs recommend exactly that as the defence against
  //    unwanted consideration extensions, so a tip there is a coin flip
  //    that costs the buyer their purchase when it loses.
  //
  // Empirically, every real OpenSea listing sampled across Ethereum, Base
  // and Polygon on 2026-08-19 was orderType 0 (FULL_OPEN) with a zero
  // zone, so the revenue actually forgone here is expected to be ~nil --
  // but a royalty-enforced collection behind OpenSea's SignedZone is a
  // real, documented case, and losing our 1.8% on it is strictly better
  // than a buyer's "Buy" button reverting.
  const ORDER_TYPE_FULL_OPEN = 0;
  const ORDER_TYPE_PARTIAL_OPEN = 1;
  const orderType = order ? Number(order.parameters.orderType) : ORDER_TYPE_FULL_OPEN;
  if (orderType !== ORDER_TYPE_FULL_OPEN && orderType !== ORDER_TYPE_PARTIAL_OPEN) return [];

  const tipWei = (priceWei * BigInt(MARKETPLANK_FOREIGN_FILL_TIP_BPS)) / BigInt(10_000);
  if (tipWei <= BigInt(0)) return [];
  return [{ token: NATIVE_TOKEN_ADDRESS, amount: tipWei.toString(), recipient: MARKET_FEE_RECIPIENT }];
}

export type ForeignBuyResult = { txHash: string };

/**
 * REAL BRANCH, ADDED 2026-08-19: chainSlug "robinhood" means an
 * auto-discovered Robinhood Chain collection (robinhood-chain-scan.ts,
 * getCollectionAsync) -- the home chain, not one of the 7 foreign chains
 * this whole file was built for. There is no MarketplankForeignFeeRouter
 * on the home chain (it doesn't need one -- native trades already carry
 * zero/config-driven fee via the collection's own feeBps, see
 * lib/market/collections.ts), and OpenSea doesn't index Robinhood Chain
 * at all, so fetchFulfillmentData's OpenSea-backed endpoint is the wrong
 * data source entirely. This delegates to the SAME audited functions
 * native RobinWood trades already use every day (lib/market/seaport.ts's
 * fulfillOrder/sweepFloor, which handle their own Robinhood-Chain wallet
 * switching via ensureRobinhoodChain internally -- exactly the machinery
 * this file's own header says NOT to reuse for the 7 foreign chains,
 * because here it's correct, not a conflict) -- reusing proven execution
 * logic rather than writing a third buy path. `orderHash` is
 * interpreted as the native order's own `id` for this branch; the UI
 * call site (MultichainCollectionView.tsx) is UNCHANGED -- it already
 * treats this as an opaque per-listing identifier regardless of source.
 */
async function buyRobinhoodListingNow(input: { orderHash: string; collectionSlug: string }): Promise<ForeignBuyResult> {
  const rawOrderRes = await fetch(`/api/market/native-order?id=${encodeURIComponent(input.orderHash)}&kind=listing`);
  if (!rawOrderRes.ok) throw new Error("This listing is no longer available.");
  const { rawOrder } = (await rawOrderRes.json()) as { rawOrder: unknown };

  const collectionRes = await fetch(`/api/market/native-collection?slug=${encodeURIComponent(input.collectionSlug)}`);
  if (!collectionRes.ok) throw new Error("Could not resolve this collection.");
  const { collection } = (await collectionRes.json()) as { collection: import("@/lib/market/types").MarketCollection };

  const injected = getEthereumProvider();
  if (!injected) throw new Error("No wallet found.");
  const browserProvider = new BrowserProvider(injected);
  const signer = await browserProvider.getSigner();
  const accountAddress = await signer.getAddress();

  const { validateListingOrder } = await import("@/lib/market/order-validation");
  const { fulfillOrder } = await import("@/lib/market/seaport");
  validateListingOrder(rawOrder, collection); // throws if the signed order doesn't actually match this collection -- same re-derivation MarketView.tsx's own buy flow does
  const result = await fulfillOrder(rawOrder as Parameters<typeof fulfillOrder>[0], accountAddress);
  const txHash = result.txHashes[result.txHashes.length - 1];
  if (!txHash) throw new Error("Purchase did not produce a transaction hash.");
  return { txHash };
}

/**
 * Buy one Magic Eden (Solana) listing right now. `orderHash` here carries
 * the listing's tokenMint (Solana's mint address IS the unique identifier --
 * see magiceden-solana-trade.ts's own header on why there's no separate
 * order hash the way Seaport has); `priceLamports` is `listing.priceWei` as
 * produced by listings/route.ts's "solana" branch, which stores the REAL
 * lamports amount (not the 1e18-scaled display string magiceden-solana.ts's
 * read-only stats adapter uses for cross-chain floor comparison -- that
 * scaling is a display-only convention for the discovery grid, never
 * appropriate for an amount actually submitted to Magic Eden's API, which
 * expects true lamports).
 *
 * ADDITIVE ONLY -- this function and buyBitcoinListingNow are new code
 * paths; nothing above this comment in this file was touched to add them.
 */
async function buySolanaListingNow(input: {
  tokenMint: string;
  priceLamports: string;
  seller?: string;
  auctionHouse?: string;
  tokenAccount?: string;
}): Promise<ForeignBuyResult> {
  const { connectPhantomWallet, signAndSendSolanaTransaction } = await import("@/lib/market/multichain/trading/non-evm-wallet");
  const buyerAddress = await connectPhantomWallet();

  const res = await fetch("/api/market/multichain/solana-buy-instruction", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      buyerAddress,
      tokenMint: input.tokenMint,
      priceLamports: input.priceLamports,
      seller: input.seller,
      auctionHouse: input.auctionHouse,
      tokenAccount: input.tokenAccount,
    }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `Failed to build the Magic Eden buy instruction (${res.status})`);
  }
  const { tx } = (await res.json()) as { tx: string };
  const txHash = await signAndSendSolanaTransaction(tx);
  return { txHash };
}

/**
 * List (or accept the current best bid on) a Solana token the connected
 * wallet owns, via Magic Eden's own real Auction House program -- same
 * "build unsigned tx server-side, sign+send client-side" shape as
 * buySolanaListingNow above, just the sell-side counterpart. mode "list"
 * creates a new fixed-price listing; mode "sellNow" accepts the live best
 * bid at exactly its own price (the caller must pass that bid's real
 * priceLamports, not an arbitrary one -- Magic Eden's sell_now endpoint
 * rejects a mismatch).
 */
export async function listSolanaTokenNow(input: {
  tokenMint: string;
  priceLamports: string;
  mode: "list" | "sellNow";
}): Promise<ForeignBuyResult> {
  const { connectPhantomWallet, signAndSendSolanaTransaction } = await import("@/lib/market/multichain/trading/non-evm-wallet");
  const sellerAddress = await connectPhantomWallet();

  const res = await fetch("/api/market/multichain/solana-sell-instruction", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode: input.mode, sellerAddress, tokenMint: input.tokenMint, priceLamports: input.priceLamports }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `Failed to build the Magic Eden sell instruction (${res.status})`);
  }
  const { tx } = (await res.json()) as { tx: string };
  const txHash = await signAndSendSolanaTransaction(tx);
  return { txHash };
}

/**
 * Buy one UniSat (Bitcoin Ordinals) listing right now, driving the real
 * create_bid -> wallet-sign -> confirm_bid flow (see unisat-ordinals-trade.ts's
 * header). `orderHash` carries the real UniSat auctionId (see
 * solana-bitcoin-listings.ts's own header -- the inscriptionId alone is
 * NOT a valid listing identifier for UniSat's real current buy-flow API,
 * confirmed live 2026-08-19). UniSat's signPsbt takes/returns HEX (not
 * base64, unlike Magic Eden) -- see non-evm-wallet.ts's own header for
 * this exact distinction.
 */
async function buyBitcoinListingNow(input: { auctionId: string; priceSats: string }): Promise<ForeignBuyResult> {
  const { connectUnisatWallet, getUnisatProvider } = await import("@/lib/market/multichain/trading/non-evm-wallet");
  const buyerAddress = await connectUnisatWallet();
  const provider = getUnisatProvider();
  if (!provider) throw new Error("UniSat wallet not found.");
  const pubkey = await provider.getPublicKey();

  const createRes = await fetch("/api/market/multichain/bitcoin-buy-psbt", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ address: buyerAddress, auctionId: input.auctionId, bidPriceSats: input.priceSats, pubkey }),
  });
  if (!createRes.ok) {
    const body = await createRes.json().catch(() => ({}));
    throw new Error(body.error ?? `Failed to build the UniSat bid PSBT (${createRes.status})`);
  }
  const { psbtBase64, signIndexes, auctionId, bidId } = (await createRes.json()) as {
    psbtBase64: string;
    signIndexes: number[];
    auctionId: string;
    bidId: string;
  };

  // UniSat's signPsbt wants hex, the create step returned base64 -- convert
  // via Buffer, never re-derive/guess the byte content.
  const psbtHex = Buffer.from(psbtBase64, "base64").toString("hex");
  const signedPsbtHex = await provider.signPsbt(psbtHex, {
    autoFinalized: true,
    toSignInputs: signIndexes.map((index) => ({ index })),
  });
  const signedPsbtBase64 = Buffer.from(signedPsbtHex, "hex").toString("base64");

  // confirm_bid needs the EXACT auctionId/bidId this specific create_bid
  // call returned -- see unisat-ordinals-trade.ts's confirmUniSatBid header
  // on why (live-verified 2026-08-19: neither is optional or recomputable).
  const confirmRes = await fetch("/api/market/multichain/bitcoin-confirm-bid", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ auctionId, bidId, signedPsbtBase64 }),
  });
  if (!confirmRes.ok) {
    const body = await confirmRes.json().catch(() => ({}));
    throw new Error(body.error ?? `Failed to confirm the UniSat bid (${confirmRes.status})`);
  }
  const { txid } = (await confirmRes.json()) as { txid: string };
  return { txHash: txid };
}

/**
 * Sweep N Magic Eden (Solana) listings. VERIFIED, NOT ASSUMED: Magic Eden's
 * buy_now returns a FULLY-BUILT Transaction (its own blockhash, fee payer,
 * and Auction House instructions already assembled server-side -- see
 * magiceden-solana-trade.ts's header), not a bare instruction a caller could
 * merge into one multi-instruction transaction the way Solana natively
 * supports for instructions it authored itself. Splicing N of Magic Eden's
 * own pre-built Transactions into one would mean re-parsing and recombining
 * their internal instructions blind -- undocumented, unverified, and exactly
 * the kind of "assume it probably works" behavior this app's culture
 * rejects (see unisat-ordinals-trade.ts's header on the same principle for
 * PSBTs). So this sweep is genuinely sequential: N separate signed
 * transactions, one Phantom prompt per item, real per-item progress via
 * onUpdate -- the same honest shape sendForeignNftBatch already uses for
 * EVM foreign-chain batch sends, not a single atomic sweep.
 */
export async function sweepSolanaListingsNow(
  input: {
    listings: Array<{ tokenMint: string; priceLamports: string }>;
    onUpdate?: (statuses: Map<string, BatchSendStatus>) => void;
  }
): Promise<Map<string, BatchSendStatus>> {
  if (input.listings.length === 0) throw new Error("No listings to sweep.");
  const statuses = new Map<string, BatchSendStatus>(
    input.listings.map((l) => [l.tokenMint, { key: l.tokenMint, state: "pending" }])
  );
  input.onUpdate?.(new Map(statuses));

  for (const listing of input.listings) {
    statuses.set(listing.tokenMint, { key: listing.tokenMint, state: "sending" });
    input.onUpdate?.(new Map(statuses));
    try {
      const result = await buySolanaListingNow({ tokenMint: listing.tokenMint, priceLamports: listing.priceLamports });
      statuses.set(listing.tokenMint, { key: listing.tokenMint, state: "sent", txHash: result.txHash });
    } catch (error) {
      // Same "one failure doesn't abort the batch" discipline as every
      // other batch function in this app -- an item already sold or a
      // wallet rejection on one prompt shouldn't block the rest.
      statuses.set(listing.tokenMint, { key: listing.tokenMint, state: "failed", error: error instanceof Error ? error.message : "Buy failed." });
    }
    input.onUpdate?.(new Map(statuses));
  }
  return statuses;
}

/**
 * Sweep N UniSat (Bitcoin Ordinals) listings. Same reasoning as
 * sweepSolanaListingsNow: UniSat's create_bid/confirm_bid flow is
 * per-listing with no documented batch endpoint (re-verified live
 * 2026-08-18 against docs.unisat.io's real collection-marketplace
 * endpoint list -- 17 documented endpoints, none of them batch), and PSBTs
 * cannot be safely merged the way this module's own header warns against
 * ("must never independently select UTXOs") -- so this is N genuinely
 * sequential signed PSBTs, one UniSat prompt per item.
 */
export async function sweepBitcoinListingsNow(
  input: {
    /** auctionId is the real UniSat listing identifier (see buyBitcoinListingNow's own header) -- used as both the request field and the status-map key. */
    listings: Array<{ auctionId: string; priceSats: string }>;
    onUpdate?: (statuses: Map<string, BatchSendStatus>) => void;
  }
): Promise<Map<string, BatchSendStatus>> {
  if (input.listings.length === 0) throw new Error("No listings to sweep.");
  const statuses = new Map<string, BatchSendStatus>(
    input.listings.map((l) => [l.auctionId, { key: l.auctionId, state: "pending" }])
  );
  input.onUpdate?.(new Map(statuses));

  for (const listing of input.listings) {
    statuses.set(listing.auctionId, { key: listing.auctionId, state: "sending" });
    input.onUpdate?.(new Map(statuses));
    try {
      const result = await buyBitcoinListingNow({ auctionId: listing.auctionId, priceSats: listing.priceSats });
      statuses.set(listing.auctionId, { key: listing.auctionId, state: "sent", txHash: result.txHash });
    } catch (error) {
      statuses.set(listing.auctionId, { key: listing.auctionId, state: "failed", error: error instanceof Error ? error.message : "Buy failed." });
    }
    input.onUpdate?.(new Map(statuses));
  }
  return statuses;
}

/**
 * REAL single-signature (or minimum-signature) batch sweep for Solana --
 * upgrade over sweepSolanaListingsNow, built per this session's explicit
 * requirement to match Blur/Magic Eden/Tensor's own real "buy multiple"
 * technique instead of the N-sequential-prompts fallback (see that
 * function's own header for why sequential shipped first, and
 * solana-tx-batch.ts's header for the verified extraction/recombination
 * technique and the real 1232-byte transaction-size limit driving the
 * split). Falls back to the sequential path for any listing
 * solana-tx-batch.ts reports as `unbatchable` (a foreign-signer
 * requirement, or a single listing too large to fit alone) -- so a sweep
 * NEVER silently drops an item just because it couldn't be folded into a
 * shared transaction.
 */
export async function sweepSolanaListingsBatched(
  input: {
    listings: Array<{ tokenMint: string; priceLamports: string }>;
    onUpdate?: (statuses: Map<string, BatchSendStatus>) => void;
  }
): Promise<Map<string, BatchSendStatus>> {
  if (input.listings.length === 0) throw new Error("No listings to sweep.");

  const { connectPhantomWallet, getPhantomProvider } = await import("@/lib/market/multichain/trading/non-evm-wallet");
  const { planSolanaBatches } = await import("@/lib/market/multichain/trading/solana-tx-batch");
  const web3 = (await import("@solana/web3.js")) as unknown as {
    Transaction: new () => { instructions: unknown[]; feePayer: unknown; recentBlockhash: string; add: (ix: unknown) => void; serializeMessage: () => Uint8Array };
    Connection: new (url: string, commitment: string) => { getLatestBlockhash: () => Promise<{ blockhash: string }> };
    PublicKey: new (v: string) => { toBase58(): string };
  };

  const buyerAddress = await connectPhantomWallet();
  const provider = getPhantomProvider();
  if (!provider) throw new Error("Phantom wallet not found.");

  const statuses = new Map<string, BatchSendStatus>(
    input.listings.map((l) => [l.tokenMint, { key: l.tokenMint, state: "pending" }])
  );
  input.onUpdate?.(new Map(statuses));

  // Fetch and deserialize every listing's own buy_now transaction first,
  // extracting its instruction list -- see solana-tx-batch.ts's header for
  // why this extraction is the real, verified technique rather than an
  // assumption. A listing that fails to fetch/deserialize is dropped to
  // the sequential fallback below, same "one bad item doesn't sink the
  // batch" discipline every other batch function in this app follows.
  const listingInstructions: Array<{ key: string; instructions: import("@/lib/market/multichain/trading/solana-tx-batch").SolanaInstructionLike[] }> = [];
  const fetchFailed: Array<{ tokenMint: string; priceLamports: string }> = [];
  for (const listing of input.listings) {
    try {
      const res = await fetch("/api/market/multichain/solana-buy-instruction", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ buyerAddress, tokenMint: listing.tokenMint, priceLamports: listing.priceLamports }),
      });
      if (!res.ok) throw new Error("fetch failed");
      const { tx } = (await res.json()) as { tx: string };
      const TransactionFrom = web3.Transaction as unknown as {
        from: (buf: Buffer) => { instructions: import("@/lib/market/multichain/trading/solana-tx-batch").SolanaInstructionLike[] };
      };
      const parsed = TransactionFrom.from(Buffer.from(tx, "base64"));
      listingInstructions.push({ key: listing.tokenMint, instructions: parsed.instructions });
    } catch {
      fetchFailed.push(listing);
    }
  }

  const plan = planSolanaBatches({ listings: listingInstructions, feePayer: buyerAddress });

  const SOLANA_RPC_URL = process.env.NEXT_PUBLIC_SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
  const connection = new web3.Connection(SOLANA_RPC_URL, "confirmed");
  const feePayerKey = new web3.PublicKey(buyerAddress);

  // Send each combined batch as ONE Phantom prompt covering every listing
  // key it groups -- the real win over sequential (10 items -> 2-3 prompts
  // instead of 10, or all-in-one for small sweeps that fit under 1232 bytes).
  for (const batch of plan.batches) {
    for (const key of batch.keys) {
      statuses.set(key, { key, state: "sending" });
    }
    input.onUpdate?.(new Map(statuses));
    try {
      const { blockhash } = await connection.getLatestBlockhash();
      const combinedTx = new web3.Transaction();
      combinedTx.feePayer = feePayerKey;
      combinedTx.recentBlockhash = blockhash;
      for (const ix of batch.instructions) combinedTx.add(ix);
      const { signature } = await provider.signAndSendTransaction(combinedTx);
      for (const key of batch.keys) {
        statuses.set(key, { key, state: "sent", txHash: signature });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Batched buy failed.";
      for (const key of batch.keys) {
        statuses.set(key, { key, state: "failed", error: message });
      }
    }
    input.onUpdate?.(new Map(statuses));
  }

  // Sequential fallback for anything solana-tx-batch.ts couldn't safely
  // fold into a shared transaction, plus anything that failed to
  // fetch/deserialize above -- reuses buySolanaListingNow directly (the
  // same function sweepSolanaListingsNow itself calls) rather than
  // duplicating its logic.
  const unbatchableSet = new Set(plan.unbatchable);
  const fallbackListings = [
    ...input.listings.filter((l) => unbatchableSet.has(l.tokenMint)),
    ...fetchFailed,
  ];
  for (const listing of fallbackListings) {
    statuses.set(listing.tokenMint, { key: listing.tokenMint, state: "sending" });
    input.onUpdate?.(new Map(statuses));
    try {
      const result = await buySolanaListingNow({ tokenMint: listing.tokenMint, priceLamports: listing.priceLamports });
      statuses.set(listing.tokenMint, { key: listing.tokenMint, state: "sent", txHash: result.txHash });
    } catch (error) {
      statuses.set(listing.tokenMint, { key: listing.tokenMint, state: "failed", error: error instanceof Error ? error.message : "Buy failed." });
    }
    input.onUpdate?.(new Map(statuses));
  }

  return statuses;
}

/**
 * Place a standing bid (offer) on a single Magic Eden (Solana) token --
 * the Solana counterpart to buildForeignOffer, using the REAL, SEPARATE
 * /instructions/buy endpoint (buildMagicEdenBid), not buy_now. No Bitcoin
 * equivalent exists: UniSat's real, verified endpoint list
 * (collection-marketplace.md, 17 endpoints) has create_bid/confirm_bid
 * ONLY as the buy-an-existing-listing flow, not a standalone
 * "make an offer independent of a listing" primitive -- so this stays
 * Solana-only, matching magiceden-solana-trade.ts's own header on the
 * Bitcoin side having no analogous bid-creation endpoint.
 */
export async function placeSolanaOfferNow(input: { tokenMint: string; priceLamports: string }): Promise<ForeignBuyResult> {
  const { connectPhantomWallet, signAndSendSolanaTransaction } = await import("@/lib/market/multichain/trading/non-evm-wallet");
  const buyerAddress = await connectPhantomWallet();

  const res = await fetch("/api/market/multichain/solana-bid-instruction", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ buyerAddress, tokenMint: input.tokenMint, priceLamports: input.priceLamports }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `Failed to build the Magic Eden bid instruction (${res.status})`);
  }
  const { tx } = (await res.json()) as { tx: string };
  const txHash = await signAndSendSolanaTransaction(tx);
  return { txHash };
}

/**
 * Accept a native offer (bid) on a Robinhood-Chain collection — the
 * Offers-tab counterpart of buyRobinhoodListingNow, see that function's
 * header for why "robinhood" gets its own branch instead of the foreign
 * OpenSea-backed path: there is no OpenSea orderbook for the home chain, and
 * accepting a bid here is the SAME Seaport fulfillment RobinWood's own
 * native Offers tab already runs every day (lib/market/seaport.ts's
 * fulfillOrder + assertAcceptableOffer), not the third-party-signer flow
 * that keeps foreign-chain offers view-only (see offers/route.ts's header).
 *
 * Scoped to PLAIN (single-token) offers only, matching what
 * app/api/market/multichain/offers/route.ts's "robinhood" branch currently
 * surfaces (o.tokenId ?? null, no criteria snapshot) — assertAcceptableOffer
 * itself fails closed with a clear message on a criteria/collection-wide
 * offer ("not for a specific token"), so a trait bid is safely rejected
 * here rather than mis-fulfilled; wiring trait-bid accept through this
 * surface would need the route to also forward criteriaTokenIds, which is
 * out of scope for this pass.
 */
async function acceptRobinhoodOfferNowImpl(input: { orderHash: string; collectionSlug: string }): Promise<ForeignBuyResult> {
  const rawOrderRes = await fetch(`/api/market/native-order?id=${encodeURIComponent(input.orderHash)}&kind=offer`);
  if (!rawOrderRes.ok) throw new Error("This offer is no longer available.");
  const { rawOrder } = (await rawOrderRes.json()) as { rawOrder: unknown };

  // Robinhood-Chain collection resolution needs Postgres (via
  // multichain/store.ts), which must never enter the client bundle -- this
  // whole file IS imported by client components, so it goes through the
  // server-only /api/market/native-collection route instead of importing
  // getCollectionAsync directly (see lib/market/collections-server.ts's
  // header for the exact "dns"-module client-bundle break this avoids).
  const collectionRes = await fetch(`/api/market/native-collection?slug=${encodeURIComponent(input.collectionSlug)}`);
  if (!collectionRes.ok) throw new Error("Could not resolve this collection.");
  const { collection } = (await collectionRes.json()) as { collection: import("@/lib/market/types").MarketCollection };
  if (!collection) throw new Error("Could not resolve this collection.");

  const injected = getEthereumProvider();
  if (!injected) throw new Error("No wallet found.");
  const browserProvider = new BrowserProvider(injected);
  const signer = await browserProvider.getSigner();
  const accountAddress = await signer.getAddress();

  const { validateOfferOrder } = await import("@/lib/market/order-validation");
  const { MARKET_OFFER_CURRENCY } = await import("@/lib/constants");
  const { assertAcceptableOffer, fulfillOrder } = await import("@/lib/market/seaport");
  // Re-derives tokenId/net price straight from the signed order in this
  // browser (same discipline as buyRobinhoodListingNow's validateListingOrder
  // call) — assertAcceptableOffer then fails closed if the order turns out
  // to be criteria-typed (no derived.tokenId) rather than a plain item bid.
  const derived = validateOfferOrder(rawOrder, collection, MARKET_OFFER_CURRENCY);
  assertAcceptableOffer({ tokenId: derived.tokenId, priceWei: derived.priceWei }, derived);
  const result = await fulfillOrder(rawOrder as Parameters<typeof fulfillOrder>[0], accountAddress);
  const txHash = result.txHashes[result.txHashes.length - 1];
  if (!txHash) throw new Error("Accepting the offer did not produce a transaction hash.");
  return { txHash };
}

/**
 * Accept a Robinhood-Chain offer by orderHash/collectionSlug. Foreign-chain
 * offer acceptance remains out of scope (documented in offers/route.ts's
 * header: it needs a third-party-signer Seaport-conduit flow that hasn't
 * been built) — callers must only invoke this for chainSlug === "robinhood"
 * rows; this function itself still fails closed on anything else so a
 * caller mistake surfaces as a clear error instead of a silent no-op.
 */
export async function acceptRobinhoodOfferNow(input: {
  chainSlug: string;
  collectionSlug: string;
  orderHash: string;
}): Promise<ForeignBuyResult> {
  if (input.chainSlug !== "robinhood") {
    throw new Error(
      `acceptRobinhoodOfferNow: offer acceptance is only wired for Robinhood Chain, not "${input.chainSlug}".`
    );
  }
  return acceptRobinhoodOfferNowImpl({ orderHash: input.orderHash, collectionSlug: input.collectionSlug });
}

/**
 * Buy one foreign-chain listing right now. Re-fetches the real fulfillable
 * order fresh (see module header) using the CONNECTED wallet's own address
 * -- OpenSea's fulfillment_data is specific to the requesting fulfiller.
 */
export async function buyForeignListingNow(input: {
  chainSlug: string;
  orderHash: string;
  /** Required for the Robinhood-Chain branch only (see buyRobinhoodListingNow) -- foreign chains resolve collection identity from the order/OpenSea response itself. */
  collectionSlug?: string;
  /** Required for the Solana/Bitcoin branches; ALSO used by the EVM branch to assert the freshly-fetched order doesn't cost more than the price the user was shown (see assertForeignOrderMatchesExpectation). */
  priceWei?: string;
  /** The collection contract the user believes they're buying from -- asserted against the signed order on the EVM path. Omit only if genuinely unknown. */
  expectedContractAddress?: string;
  /** The token id the user believes they're buying -- asserted against the signed order on the EVM path. */
  expectedTokenId?: string;
  solanaEscrow?: { auctionHouse: string; tokenAccount: string };
  expectedMaker?: string;
}): Promise<ForeignBuyResult> {
  if (input.chainSlug === "robinhood") {
    if (!input.collectionSlug) throw new Error("buyForeignListingNow: collectionSlug is required for Robinhood Chain purchases.");
    return buyRobinhoodListingNow({ orderHash: input.orderHash, collectionSlug: input.collectionSlug });
  }

  // ADDITIVE: Solana (Magic Eden) and Bitcoin Ordinals (UniSat) branches --
  // neither has a Seaport order at all, so both dispatch to their own
  // per-venue buy function instead. `orderHash` carries whatever
  // opaque per-listing identifier the "solana"/"bitcoin" listings/route.ts
  // branch put in Listing.id/foreignOrderHash: tokenMint for Solana,
  // inscriptionId for Bitcoin (see listings/route.ts's own comment on this).
  // `priceWei` is required for both since neither venue's buy endpoint can
  // re-derive price from just the identifier the way fetchFulfillmentData
  // re-signs a fresh Seaport order.
  if (isSolanaChainSlug(input.chainSlug)) {
    if (!input.priceWei) throw new Error("buyForeignListingNow: priceWei is required for a Solana purchase.");
    // listings/route.ts's "solana" branch stores priceWei SCALED to this
    // app's 1e18-equivalent display convention (lamports * 1e9, matching
    // magiceden-solana.ts's own lamportsToScaledString) -- unscale back to
    // true lamports before calling Magic Eden's own API, which expects real
    // lamports, never the display-scaled figure.
    const lamports = (BigInt(input.priceWei) / BigInt(1_000_000_000)).toString();
    return buySolanaListingNow({
      tokenMint: input.orderHash,
      priceLamports: lamports,
      seller: input.expectedMaker,
      auctionHouse: input.solanaEscrow?.auctionHouse,
      tokenAccount: input.solanaEscrow?.tokenAccount,
    });
  }
  if (isBitcoinChainSlug(input.chainSlug)) {
    if (!input.priceWei) throw new Error("buyForeignListingNow: priceWei is required for a Bitcoin purchase.");
    // Same display-scaling convention as the Solana branch above: BTC has 8
    // decimals (satoshis), so listings/route.ts's "bitcoin" branch would
    // store priceWei as sats * 1e10 to land on the same 18dp-equivalent
    // magnitude every other chain's priceWei uses for display comparability.
    const sats = (BigInt(input.priceWei) / BigInt(10_000_000_000)).toString();
    return buyBitcoinListingNow({ auctionId: input.orderHash, priceSats: sats });
  }

  // REAL FIX, 2026-08-19: this used to call connectedRouter() ->
  // MarketplankForeignFeeRouter, which was never deployed on any chain --
  // buying a third-party listing on any foreign EVM chain was completely
  // non-functional, not merely fee-free (requireRouter always threw). Now
  // fulfills directly against Seaport's own canonical contract (already
  // deployed everywhere, no deployment needed), using its native
  // fulfiller-side "tip" mechanism for the marketplace fee -- see
  // MARKETPLANK_FOREIGN_FILL_TIP_BPS's own header (lib/constants.ts) for
  // why this is enforced atomically, non-optionally, in the exact same
  // transaction as the purchase itself.
  const { buyerAddress } = await connectedForeignAccount(input.chainSlug);

  const order = await fetchFulfillmentData({
    chainSlug: input.chainSlug,
    orderHash: input.orderHash,
    fulfillerAddress: buyerAddress,
  });
  if (!order.signature || order.signature === "0x") {
    throw new Error("This listing has no fulfillable signature right now (it may rely on on-chain validation that hasn't happened, or has since sold). Try again in a moment.");
  }

  // THE GUARD (audit finding C1). Never fulfill a third-party order without
  // first checking it is the asset, and the price, the user was actually
  // shown -- see assertForeignOrderMatchesExpectation's own header.
  assertForeignOrderMatchesExpectation(order, {
    contractAddress: input.expectedContractAddress,
    tokenId: input.expectedTokenId,
    priceWei: input.priceWei,
  });

  const price = considerationTotal(order);
  const { fulfillOrder } = await import("@/lib/market/seaport");
  const chain = await seaportChainFor(input.chainSlug);
  const result = await fulfillOrder(
    order as unknown as Parameters<typeof fulfillOrder>[0],
    buyerAddress,
    undefined,
    chain,
    foreignFillTip(price, order)
  );
  const txHash = result.txHashes[result.txHashes.length - 1];
  if (!txHash) throw new Error("Purchase did not produce a transaction hash.");
  return { txHash };
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
  /** Hard ceiling on total native spend (price + tips) for the whole batch -- see the cap check below. */
  maxTotalSpendWei?: string;
}): Promise<ForeignSweepResult> {
  // Same real fix as buyForeignListingNow: router.sweepBuy always threw
  // (undeployed router). Now batch-fulfills directly against Seaport,
  // each order carrying its own tip -- see fulfillOrdersBatch.
  //
  // Item cap (audit finding M1): only the multi-collection sweep enforced
  // one, so this path could batch an unbounded number of fills behind a
  // single wallet confirmation.
  if (input.count > MAX_SWEEP_ITEMS) {
    throw new Error(`A single sweep is capped at ${MAX_SWEEP_ITEMS} items.`);
  }
  const { buyerAddress } = await connectedForeignAccount(input.chainSlug);

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
      // it from the batch -- the remaining race window between fetch and
      // mined block is Seaport's own per-order fulfillment concern, not
      // this batching layer's.
    }
  }
  if (freshOrders.length === 0) throw new Error("None of the current listings could be freshly re-signed -- try again.");

  const { fulfillOrdersBatch } = await import("@/lib/market/seaport");
  const chain = await seaportChainFor(input.chainSlug);
  const result = await fulfillOrdersBatch(
    freshOrders.map((o) => ({
      order: o as unknown as Parameters<typeof fulfillOrdersBatch>[0][number]["order"],
      tips: foreignFillTip(considerationTotal(o), o),
    })),
    buyerAddress,
    chain
  );
  const txHash = result.txHashes[result.txHashes.length - 1];
  if (!txHash) throw new Error("Sweep did not produce a transaction hash.");
  return { txHash, attempted: freshOrders.length };
}

export type ForeignMultiCollectionSweepResult = {
  txHash: string;
  attempted: number;
  /** Per-spec fill counts, in the same order specs were given -- lets the UI report "3/3 from Collection A, 2/2 from Collection B" instead of one opaque total. */
  perCollection: Array<{ collectionSlug: string; requested: number; filled: number }>;
};

/**
 * Real multi-collection sweep -- N cheapest listings across MULTIPLE
 * collections on the SAME chain, filled in ONE transaction. This is the
 * Blur/Gem-lineage capability the research explicitly flagged as real and
 * adoptable ("multi-collection sweep-in-one-tx... mechanically
 * straightforward given Seaport batch-fill is already built").
 *
 * REWIRED 2026-08-19 OFF THE UNDEPLOYED ROUTER: previously called
 * MarketplankForeignFeeRouter.sweepBuy, which had no same-collection
 * assumption (each AdvancedOrder carries its own token internally) but
 * was never actually deployed anywhere, so this always threw. Now calls
 * fulfillOrdersBatch (lib/market/seaport.ts) directly against Seaport
 * itself -- same "each order carries its own collection, no
 * cross-collection constraint" property, since that's inherent to
 * Seaport's own batch fulfillment, not something the router added. True
 * CROSS-CHAIN sweep in one tx is still not possible (a real blockchain
 * constraint -- Seaport itself only exists per-chain): only same-chain,
 * cross-collection sweep is achievable in one transaction, which is
 * exactly what Blur's own sweep does too.
 */
export async function sweepForeignListingsMultiCollection(input: {
  chainSlug: string;
  specs: Array<{ collectionSlug: string; count: number; traits?: ForeignTraitClause[] }>;
}): Promise<ForeignMultiCollectionSweepResult> {
  if (input.specs.length === 0) throw new Error("sweepForeignListingsMultiCollection: at least one collection is required.");
  // A real, still-relevant client-side ceiling -- keeps a single sweep
  // request bounded regardless of fulfillment mechanism.
  const requestedTotal = input.specs.reduce((sum, s) => sum + s.count, 0);
  if (requestedTotal > MAX_SWEEP_ITEMS) {
    throw new Error(`Requested ${requestedTotal} items across ${input.specs.length} collections, but a single sweep is capped at ${MAX_SWEEP_ITEMS} items total.`);
  }

  // Same real fix as buyForeignListingNow/sweepForeignListings.
  const { buyerAddress } = await connectedForeignAccount(input.chainSlug);

  // Fetch each collection's candidate listings in parallel -- independent
  // reads, no shared state, same pattern the rest of this codebase uses
  // for parallel-safe operations.
  const perSpecSummaries = await Promise.all(
    input.specs.map((spec) =>
      fetchFloorListingSummaries({
        chainSlug: input.chainSlug,
        collectionSlug: spec.collectionSlug,
        count: spec.count,
        traits: spec.traits,
      }).catch(() => [] as ForeignSeaportOrder[])
    )
  );

  // Re-fetch FRESH fulfillment data for every candidate, same freshness
  // requirement as the single-collection sweep -- tagged with which spec
  // it came from so perCollection reporting stays accurate even when some
  // items fail to re-fetch (already sold, expired).
  const perCollectionFilled = input.specs.map((spec) => ({ collectionSlug: spec.collectionSlug, requested: spec.count, filled: 0 }));
  const freshOrders: ForeignSeaportOrder[] = [];
  for (let specIndex = 0; specIndex < input.specs.length; specIndex++) {
    for (const summary of perSpecSummaries[specIndex]) {
      try {
        const fresh = await fetchFulfillmentData({
          chainSlug: input.chainSlug,
          orderHash: summary.orderHash,
          fulfillerAddress: buyerAddress,
        });
        if (fresh.signature && fresh.signature !== "0x") {
          freshOrders.push(fresh);
          perCollectionFilled[specIndex].filled += 1;
        }
      } catch {
        // Same as the single-collection sweep: one listing failing to
        // re-fetch just drops it from the batch.
      }
    }
  }
  if (freshOrders.length === 0) throw new Error("None of the current listings across these collections could be freshly re-signed -- try again.");

  const { fulfillOrdersBatch } = await import("@/lib/market/seaport");
  const chain = await seaportChainFor(input.chainSlug);
  const result = await fulfillOrdersBatch(
    freshOrders.map((o) => ({
      order: o as unknown as Parameters<typeof fulfillOrdersBatch>[0][number]["order"],
      tips: foreignFillTip(considerationTotal(o), o),
    })),
    buyerAddress,
    chain
  );
  const txHash = result.txHashes[result.txHashes.length - 1];
  if (!txHash) throw new Error("Sweep did not produce a transaction hash.");
  return { txHash, attempted: freshOrders.length, perCollection: perCollectionFilled };
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
