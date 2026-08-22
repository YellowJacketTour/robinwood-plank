/**
 * UniSat Marketplace adapter -- Bitcoin Ordinals trading, the first
 * non-EVM, non-Solana venue this app touches. Verified via a dedicated
 * research pass 2026-08-18 that actually fetched UniSat's real docs
 * (github.com/unisat-wallet/unisat-dev-docs's collection-marketplace.md,
 * the reliable source of truth -- several docs.unisat.io paths 404'd and
 * are NOT used here), not inferred from search snippets or training data.
 *
 * MAGIC EDEN'S BITCOIN MARKETPLACE IS DEAD -- DO NOT USE IT
 * ---------------------------------------------------------------------------
 * Confirmed live 2026-08-18: Magic Eden shut down their Bitcoin (and EVM)
 * NFT marketplaces + APIs on 2026-03-09 as part of a pivot to Solana-only
 * + a gambling product. UniSat is the verified-real alternative.
 *
 * OKX'S ORDINALS API COULD NOT BE VERIFIED -- A REAL BLOCKER, NOT A GAP
 * ---------------------------------------------------------------------------
 * Every plausible current OKX WaaS marketplace/Ordinals doc URL was
 * fetched directly during the same research pass and all now serve
 * unrelated "Onchain OS" landing-page content -- no marketplace/PSBT/fee
 * documentation found anywhere reachable. This is a confirmed, current
 * finding (multiple URLs fetched, all dead), not a search-effort gap.
 * OKX may still be real and buildable, but needs a rendered-browser
 * capture or direct contact with OKX dev support before any code is
 * written against it -- do not guess at its schema from memory.
 *
 * BITCOIN HAS NO SEAPORT EQUIVALENT EITHER -- READ BEFORE EXTENDING
 * ---------------------------------------------------------------------------
 * Ordinals trades are PSBT-based (Partially Signed Bitcoin Transactions),
 * not signed order objects the way Seaport is, and not instruction-based
 * the way Solana's Magic Eden/Tensor programs are. An inscription has no
 * token ID -- it's identified by inscription ID (`txid` + output index,
 * e.g. "abc123...i0") tied to a SPECIFIC UTXO. This is a REAL, sharp risk
 * this module must respect: naively spending a wallet's "regular" BTC
 * UTXOs without excluding inscription-holding ones can accidentally burn
 * the inscription itself. This module only builds/relays PSBTs UniSat's
 * own API constructs (which already accounts for this) -- it must never
 * independently select UTXOs.
 *
 * REAL, VERIFIED FLOW (create -> sign specific indexes -> confirm)
 * ---------------------------------------------------------------------------
 * Buy:  create_bid_prepare (fee/size estimate) -> create_bid (returns an
 *       UNSIGNED PSBT + which input indexes the buyer's wallet must sign
 *       -- never the whole transaction) -> wallet signs only those
 *       indexes -> confirm_bid (returns the real txid).
 * List: create_put_on (unsigned PSBT + sign indexes) -> wallet signs ->
 *       confirm_put_on. Delist/reprice mirror the same three-step shape
 *       (create_put_off/confirm_put_off, create_modify_price/confirm_modify_price).
 *
 * FEES (from UniSat's real, fetched fee-rates page): points-tiered, not
 * flat maker/taker. Ordinals collections/NFTs specifically: 0.5% under
 * 1500 UniSat Points, 0.3% at 1500-2000, 0% at 2000+. This module does
 * NOT add any fee of its own on top -- same "no second, avoidable fee
 * layer" principle as magiceden-solana-trade.ts.
 *
 * NO OFFICIAL SDK EXISTS (confirmed) -- this is a hand-built REST client
 * against UniSat's own documented endpoints, not a wrapped npm package.
 */

/**
 * TWO REAL BUGS FIXED HERE 2026-08-19, VERIFIED AGAINST THE CANONICAL
 * SOURCE (github.com/unisat-wallet/unisat-dev-docs's real
 * open-api/auto-generated/docs/collection-marketplace.md, not the
 * search-snippet-derived assumption this file originally shipped with):
 *
 * 1. Every one of these five endpoints lives under
 *    `/collection/auction/{name}`, not bare `/{name}` -- this module's
 *    original paths (`/create_bid_prepare`, `/create_bid`, `/confirm_bid`,
 *    `/create_put_on`, `/confirm_put_on`) were missing that segment
 *    entirely and returned a real, confirmed HTTP 404 on every call
 *    (`curl`-reproduced live: `POST .../v3/market/create_bid` ->
 *    "404 page not found"; the correct
 *    `.../v3/market/collection/auction/create_bid` returns a real 200).
 *    `fetchUniSatListings` (solana-bitcoin-listings.ts) already used the
 *    correct prefix for its one call -- this file's OWN endpoints never
 *    did, and nothing before this fix had ever actually invoked them
 *    against the live API to catch it.
 * 2. Every real response is wrapped `{code, msg, data: {...}}` (confirmed
 *    both by the docs' own Response schema for every endpoint below AND
 *    live, e.g. `{"code":0,"msg":"ok","data":{"list":[...]}}`) -- this
 *    helper used to return the raw parsed body as-if it WERE the payload,
 *    so every caller was reading `undefined` off the wrong level. Now
 *    unwraps `.data` and treats a non-zero `code` as a real business
 *    error (UniSat returns HTTP 200 even for e.g. "Order not exist" --
 *    `!res.ok` alone was never sufficient to catch a real failure here).
 */
const UNISAT_API_BASE = "https://open-api.unisat.io/v3/market/collection/auction";

function requireApiKey(): string {
  const key = process.env.UNISAT_API_KEY;
  if (!key) {
    throw new Error(
      "unisat-ordinals-trade: UNISAT_API_KEY is not configured. Sign up at UniSat's Developer Center (see docs.unisat.io/developer-support/how-to-acquire-a-unisat-api-key) -- free tier is 5 calls/sec, 1,000 calls/day, no KYC or partnership approval required."
    );
  }
  return key;
}

/**
 * NETWORK GATE, added to unify this surface with native-bitcoin-listing.ts's
 * own posture (design-unification finding, 2026-08-19). This module's
 * UNISAT_API_BASE is hardcoded mainnet -- UniSat's Auction House has no
 * testnet equivalent to point at -- which meant real mainnet Bitcoin could
 * be committed through this path with ZERO gate, while every other
 * Bitcoin-fund-moving path in this app (native-bitcoin-listing.ts) refuses
 * to touch mainnet unless NATIVE_BITCOIN_MAINNET_ENABLED is explicitly
 * set. Applied only to the functions that actually commit funds
 * (createUniSatBid, confirmUniSatBid) -- prepareUniSatBid is a read-only
 * fee estimate and stays ungated.
 */
function requireMainnetEnabled(action: string): void {
  if (process.env.NATIVE_BITCOIN_MAINNET_ENABLED !== "true") {
    throw new Error(
      `unisat-ordinals-trade: ${action} would commit real mainnet Bitcoin, and NATIVE_BITCOIN_MAINNET_ENABLED is not set -- refusing, same gate this app's native Bitcoin listing engine already holds itself to. UniSat's Auction House has no testnet equivalent, so this is the only way to keep every real-money Bitcoin path in this app behind one consistent switch.`
    );
  }
}

async function unisatFetch<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const key = requireApiKey();
  const res = await fetch(`${UNISAT_API_BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`unisat-ordinals-trade: ${res.status} ${res.statusText} on ${path} -- ${text.slice(0, 200)}`);
  }
  const envelope = (await res.json()) as { code: number; msg: string; data: T };
  if (envelope.code !== 0) {
    throw new Error(`unisat-ordinals-trade: ${path} returned code ${envelope.code} -- ${envelope.msg}`);
  }
  return envelope.data;
}

/** An unsigned PSBT (base64) plus exactly which input indexes the connected wallet must sign -- never the whole transaction, matching UniSat's real, verified create->sign->confirm flow. */
export type UniSatPsbtStep = {
  psbtBase64: string;
  /** The buyer/seller wallet must sign ONLY these input indexes -- signing the wrong indexes either fails or, worse, could sign away unrelated UTXOs. Passed through exactly as UniSat's API returns it, never recomputed here. */
  signIndexes: number[];
};

/**
 * The bid-specific variant -- confirm_bid needs auctionId+bidId ALONGSIDE
 * the signed PSBT (confirmed live 2026-08-19: an empty confirm_bid body
 * demands auctionId, then bidId, then psbtBid, in that order -- create_put_on's
 * sibling confirm_put_on has no such requirement, so this is genuinely
 * bid-specific, not a general PSBT-step shape). bidId is UniSat's own
 * identifier for this SPECIFIC signed bid attempt, distinct from
 * auctionId (the listing) -- both must be threaded through from
 * createUniSatBid's response to confirmUniSatBid, never recomputed.
 */
export type UniSatBidStep = UniSatPsbtStep & {
  auctionId: string;
  bidId: string;
};

/**
 * REQUEST SHAPE CORRECTED 2026-08-19, LIVE-VERIFIED AGAINST A REAL KEY
 * ---------------------------------------------------------------------------
 * The `{buyerAddress, inscriptionId, price}` body this module originally
 * sent (written from docs before any real key existed to test against) is
 * REJECTED by both create_bid_prepare and create_bid today -- confirmed via
 * a real key, iterating through the API's own validation error messages
 * one field at a time: `"auctionId" is required` (the raw inscriptionId is
 * NOT a valid listing identifier -- it identifies the INSCRIPTION, not
 * THIS SPECIFIC LISTING of it; see solana-bitcoin-listings.ts's own header
 * for where the real auctionId comes from), then `"bidPrice" is required`
 * (not `price`), then `"address" is required` (not `buyerAddress`), then
 * `"pubkey" is required` -- a field neither endpoint's earlier-assumed
 * shape had at all. Verified against a real live bitcoin-frogs auctionId:
 * a request with every field present but a syntactically-valid-but-
 * unowned dummy pubkey got PAST all schema validation to a real business-
 * logic response (`{"code":-100,"msg":"Order not exist"}`), confirming
 * `{address, auctionId, bidPrice, pubkey}` is the complete, correct shape
 * for both endpoints.
 */
/** Step 1 of buying: get a fee/size estimate before committing to a bid. Field names mapped from the real, doc-confirmed response (`serverFee`/`txSize`), not the earlier-assumed `feeSats`/`sizeBytes` shape that never matched what the API actually returns. */
export async function prepareUniSatBid(input: {
  address: string;
  /** The real UniSat auctionId (from SimpleListing.id / Listing.foreignOrderHash) -- NOT the inscriptionId. */
  auctionId: string;
  bidPriceSats: string;
  /** The buyer's real Bitcoin public key (hex, compressed) -- required for UniSat to construct a spendable PSBT input for this address. Get it from the connected wallet (e.g. window.unisat.getPublicKey()), never fabricated. */
  pubkey: string;
}): Promise<{ feeSats: string; sizeBytes: number }> {
  const data = await unisatFetch<{ serverFee: number; txSize: number }>("/create_bid_prepare", {
    address: input.address,
    auctionId: input.auctionId,
    bidPrice: Number(input.bidPriceSats),
    pubkey: input.pubkey,
  });
  return { feeSats: String(data.serverFee), sizeBytes: data.txSize };
}

/**
 * Step 2: builds the unsigned bid PSBT. The caller's wallet (Xverse/UniSat/
 * Leather -- NOT an EVM-style wallet) must sign only `signIndexes` before
 * step 3. The real response field names are `bidId`/`psbtBid`/
 * `bidSignIndexes` (confirmed against the canonical docs -- create_bid's
 * response schema is genuinely different from create_put_on's
 * `psbt`/`signIndexes`, they are NOT the same field names reused across
 * endpoints as originally assumed). Returns UniSatBidStep (not the plain
 * UniSatPsbtStep) because confirm_bid needs auctionId+bidId ALONGSIDE the
 * signed PSBT -- see that type's own header.
 */
export async function createUniSatBid(input: {
  address: string;
  auctionId: string;
  bidPriceSats: string;
  pubkey: string;
}): Promise<UniSatBidStep> {
  requireMainnetEnabled("createUniSatBid");
  const data = await unisatFetch<{ bidId: string; psbtBid: string; bidSignIndexes: number[] }>("/create_bid", {
    address: input.address,
    auctionId: input.auctionId,
    bidPrice: Number(input.bidPriceSats),
    pubkey: input.pubkey,
  });
  return { auctionId: input.auctionId, bidId: data.bidId, psbtBase64: data.psbtBid, signIndexes: data.bidSignIndexes };
}

/**
 * Step 3: submits the wallet-signed PSBT and returns the real, broadcast
 * Bitcoin txid. REQUEST SHAPE LIVE-VERIFIED 2026-08-19: an empty body
 * demands `auctionId`, then `bidId`, then `psbtBid` (in that exact order,
 * via the API's own validation errors) -- NOT the `{psbt: ...}` shape
 * originally assumed. auctionId/bidId must be the exact values
 * createUniSatBid returned for this specific bid, never recomputed.
 */
export async function confirmUniSatBid(input: { auctionId: string; bidId: string; signedPsbtBase64: string }): Promise<{ txid: string }> {
  requireMainnetEnabled("confirmUniSatBid");
  return unisatFetch("/confirm_bid", { auctionId: input.auctionId, bidId: input.bidId, psbtBid: input.signedPsbtBase64 });
}

/**
 * Sweep: like Magic Eden's API, UniSat's is per-listing -- there is no
 * native batch-buy endpoint. Builds N independent create_bid PSBTs for
 * the caller to sign and submit, same real per-item-signature UX
 * difference from EVM's single multi-item transaction already documented
 * in magiceden-solana-trade.ts's buildMagicEdenSweep.
 *
 * Returns UniSatBidStep[], not UniSatPsbtStep[] (type bug fixed 2026-08-19,
 * design-unification review) -- it calls createUniSatBid, which returns
 * UniSatBidStep (auctionId + bidId alongside the PSBT). The old
 * UniSatPsbtStep return type erased both fields at the type level even
 * though they exist at runtime, making any real caller unable to reach
 * confirmUniSatBid (which requires both) without an unsafe cast. No
 * caller exists yet either way -- foreign-fulfill.ts's own sweep
 * (sweepBitcoinListingsNow) re-implements this loop directly over
 * buyBitcoinListingNow instead of using this helper.
 */
export async function prepareUniSatSweep(input: {
  address: string;
  pubkey: string;
  listings: Array<{ auctionId: string; bidPriceSats: string }>;
}): Promise<UniSatBidStep[]> {
  return Promise.all(
    input.listings.map((listing) =>
      createUniSatBid({ address: input.address, pubkey: input.pubkey, auctionId: listing.auctionId, bidPriceSats: listing.bidPriceSats })
    )
  );
}

/**
 * createUniSatListing/confirmUniSatListing were REMOVED here
 * (design-unification review, 2026-08-19), not fixed. This file's own
 * header documents that create_bid/confirm_bid's assumed request/response
 * shapes were wrong in seven fields combined, discovered only by hitting
 * the live API with a real key -- the listing pair below received no such
 * treatment: still {sellerAddress, inscriptionId, price} to create_put_on,
 * typed as the exact UniSatPsbtStep shape the bid pair proved was a false
 * assumption for its own sibling endpoint. Zero callers existed either
 * way. Shipping unverified trade code next to a header that documents
 * this precise failure mode was the drift this review was asked to find.
 * Re-add only after live-verifying against a real key, the same standard
 * every other endpoint in this file was held to.
 */
