/**
 * Real UniSat Marketplace listings-read for Bitcoin Ordinals -- fills the
 * one real gap left in listings/route.ts's "bitcoin" branch. An earlier
 * pass concluded no listing-query endpoint existed for UniSat's Marketplace
 * API and left that branch returning an honest-but-unnecessary empty
 * `listings: []` always. Live-verified during THIS pass (a real curl
 * against open-api.unisat.io/v3/market/collection/auction/list, 2026-08-18)
 * that the endpoint exists and returns a real, specific
 * `{"code":-2004,"msg":"exceeded the request limit for unauthenticated
 * requests. Please provide Authorization header with format
 * \`Bearer {token}\` to continue"}` -- i.e. it requires the SAME
 * UNISAT_API_KEY Bearer-token auth unisat-ordinals-trade.ts's trade
 * endpoints already document, not "doesn't exist." So this now follows the
 * exact same "fail closed with a clear 503 when the key is unset, otherwise
 * fetch real data" posture every other keyed source in this codebase uses
 * (see app/api/market/multichain/listings/route.ts's own
 * "OpenSea API key is not configured on this deployment" branch for the
 * EVM-path precedent).
 *
 * PRICE SCALING, SYMMETRIC WITH foreign-fulfill.ts's buyBitcoinListingNow
 * ---------------------------------------------------------------------------
 * Every chain's Listing.priceWei is an 18-decimal-equivalent integer string.
 * BTC has 8 decimals (satoshis), so priceWei here is sats * 1e10 -- the
 * exact inverse of foreign-fulfill.ts's `sats = priceWei / 1e10` unscale
 * step, which already existed before this file did (see that function's own
 * comment). satsToPriceWei below is the one and only place that scaling
 * happens on the read side, so the two stay symmetric by construction
 * rather than by two authors independently getting the same constant right.
 */

const SATS_SCALE = BigInt(10_000_000_000); // BTC: 8dp -> 18dp-equivalent, matches foreign-fulfill.ts's buyBitcoinListingNow unscale step

export function satsToPriceWei(sats: number | string | bigint): string {
  return (BigInt(sats) * SATS_SCALE).toString();
}

const UNISAT_API_BASE = "https://open-api.unisat.io/v3/market";

export type SimpleListing = {
  /** The real UniSat auctionId -- identifies THIS SPECIFIC LISTING (what create_bid_prepare/create_bid actually need), distinct from tokenId below (the inscription itself). Confirmed live 2026-08-19: create_bid_prepare rejects a request keyed by inscriptionId with "auctionId is required" -- the raw inscriptionId was never a valid listing identifier for UniSat's real current buy-flow endpoints. */
  id: string;
  tokenId: string;
  maker: string;
  priceWei: string;
  imageUrl: string | null;
  name: string | null;
};

function requireUnisatApiKey(): string {
  const key = process.env.UNISAT_API_KEY;
  if (!key) {
    throw new Error(
      "solana-bitcoin-listings: UNISAT_API_KEY is not configured -- see unisat-ordinals-trade.ts's own header for how to acquire one (free tier, no KYC)."
    );
  }
  return key;
}

type UniSatAuctionEntry = {
  auctionId: string;
  inscriptionId: string;
  address: string;
  price?: number;
  collectionItemName?: string | null;
};

/**
 * Real UniSat Marketplace active listings for one collection. Throws (fails
 * closed) when UNISAT_API_KEY is unset -- callers must turn that into a 503,
 * same pattern as every other missing-key branch in this codebase.
 *
 * REQUEST SHAPE CORRECTED 2026-08-19, LIVE-VERIFIED AGAINST A REAL KEY
 * ---------------------------------------------------------------------------
 * The flat `{collectionId, limit, offset}` body this function originally
 * sent (written before any real key existed to test against) is REJECTED
 * by the live API today -- confirmed via a real key, iterating through the
 * API's own validation error messages one field at a time: it now requires
 * `start` (not `offset`), a `filter` OBJECT (not top-level collectionId)
 * whose `nftType` must be one of `[brc20, domain, collection, runes,
 * alkanes, brc20Prog, tap]` (`"collection"` is correct for NFT
 * collections), `collectionId` NESTED inside that filter object, and a
 * `sort` object (an empty `{}` is accepted). Verified against real
 * bitcoin-frogs data: real inscriptionIds, real sat prices, real
 * `collectionItemName` per item (e.g. "Bitcoin Frog #2502") -- that last
 * field is real and available even though the response has NO per-token
 * image field at all (contentPreviewURI, assumed by the original version
 * of this function, does not exist in the real response) -- imageUrl stays
 * honestly null rather than guessing a field name.
 */
export async function fetchUniSatListings(collectionId: string, limit: number): Promise<SimpleListing[]> {
  const key = requireUnisatApiKey();
  const res = await fetch(`${UNISAT_API_BASE}/collection/auction/list`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({
      start: 0,
      limit,
      filter: { nftType: "collection", collectionId },
      sort: {},
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`solana-bitcoin-listings: UniSat ${res.status} ${res.statusText} -- ${body.slice(0, 200)}`);
  }
  const body = (await res.json()) as { data?: { list?: UniSatAuctionEntry[] } };
  const list = body.data?.list ?? [];
  return list.map((l) => ({
    id: l.auctionId,
    tokenId: l.inscriptionId,
    maker: l.address,
    priceWei: satsToPriceWei(l.price ?? 0),
    imageUrl: null,
    name: l.collectionItemName ?? null,
  }));
}
