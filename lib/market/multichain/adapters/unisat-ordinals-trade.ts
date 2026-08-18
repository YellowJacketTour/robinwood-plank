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

const UNISAT_API_BASE = "https://open-api.unisat.io/v3/market";

function requireApiKey(): string {
  const key = process.env.UNISAT_API_KEY;
  if (!key) {
    throw new Error(
      "unisat-ordinals-trade: UNISAT_API_KEY is not configured. Sign up at UniSat's Developer Center (see docs.unisat.io/developer-support/how-to-acquire-a-unisat-api-key) -- free tier is 5 calls/sec, 1,000 calls/day, no KYC or partnership approval required."
    );
  }
  return key;
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
  return (await res.json()) as T;
}

/** An unsigned PSBT (base64) plus exactly which input indexes the connected wallet must sign -- never the whole transaction, matching UniSat's real, verified create->sign->confirm flow. */
export type UniSatPsbtStep = {
  psbtBase64: string;
  /** The buyer/seller wallet must sign ONLY these input indexes -- signing the wrong indexes either fails or, worse, could sign away unrelated UTXOs. Passed through exactly as UniSat's API returns it, never recomputed here. */
  signIndexes: number[];
};

/** Step 1 of buying: get a fee/size estimate before committing to a bid. */
export async function prepareUniSatBid(input: {
  buyerAddress: string;
  inscriptionId: string;
  priceSats: string;
}): Promise<{ feeSats: string; sizeBytes: number }> {
  return unisatFetch("/create_bid_prepare", {
    buyerAddress: input.buyerAddress,
    inscriptionId: input.inscriptionId,
    price: input.priceSats,
  });
}

/** Step 2: builds the unsigned bid PSBT. The caller's wallet (Xverse/UniSat/Leather -- NOT an EVM-style wallet) must sign only `signIndexes` before step 3. */
export async function createUniSatBid(input: {
  buyerAddress: string;
  inscriptionId: string;
  priceSats: string;
}): Promise<UniSatPsbtStep> {
  return unisatFetch("/create_bid", {
    buyerAddress: input.buyerAddress,
    inscriptionId: input.inscriptionId,
    price: input.priceSats,
  });
}

/** Step 3: submits the wallet-signed PSBT and returns the real, broadcast Bitcoin txid. */
export async function confirmUniSatBid(input: { signedPsbtBase64: string }): Promise<{ txid: string }> {
  return unisatFetch("/confirm_bid", { psbt: input.signedPsbtBase64 });
}

/**
 * Sweep: like Magic Eden's API, UniSat's is per-listing -- there is no
 * native batch-buy endpoint. Builds N independent create_bid PSBTs for
 * the caller to sign and submit, same real per-item-signature UX
 * difference from EVM's single multi-item transaction already documented
 * in magiceden-solana-trade.ts's buildMagicEdenSweep.
 */
export async function prepareUniSatSweep(input: {
  buyerAddress: string;
  listings: Array<{ inscriptionId: string; priceSats: string }>;
}): Promise<UniSatPsbtStep[]> {
  return Promise.all(
    input.listings.map((listing) =>
      createUniSatBid({ buyerAddress: input.buyerAddress, inscriptionId: listing.inscriptionId, priceSats: listing.priceSats })
    )
  );
}

/** Builds the unsigned listing PSBT -- creates a real UniSat Marketplace listing for an inscription the seller's wallet already holds. */
export async function createUniSatListing(input: {
  sellerAddress: string;
  inscriptionId: string;
  priceSats: string;
}): Promise<UniSatPsbtStep> {
  return unisatFetch("/create_put_on", {
    sellerAddress: input.sellerAddress,
    inscriptionId: input.inscriptionId,
    price: input.priceSats,
  });
}

/** Submits the wallet-signed listing PSBT, making the listing live. */
export async function confirmUniSatListing(input: { signedPsbtBase64: string }): Promise<{ success: boolean }> {
  return unisatFetch("/confirm_put_on", { psbt: input.signedPsbtBase64 });
}
