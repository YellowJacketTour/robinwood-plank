import { durableKv as kv, hasDurableKv } from "@/lib/market/durable-kv";
import { CHAIN } from "@/lib/constants";
import { NFT_CONTRACT_ADDRESS } from "@/lib/mint-contract";
import type { NormalisedForeignListing } from "@/lib/market/foreign-listings";

/**
 * PulpMarket public API client — listings only.
 *
 * PulpMarket (pulpmarket.app) is a multi-chain NFT marketplace that carries
 * this collection on Robinhood Chain, so planks genuinely trade there. A book
 * showing only our own listings tells buyers the market is thinner and pricier
 * than it is; the same reasoning that put OpenSea rows in the book puts these
 * there.
 *
 * DISPLAY ONLY, AND UNAVOIDABLY SO. Their API is documented as "read-only
 * market data" and returns no order signature, no protocol data and no
 * fulfilment material of any kind — verified against the full OpenAPI
 * document, not assumed. Where OpenSea rows are unfulfillable because they
 * route through a conduit we do not control, these are unfulfillable because
 * there is simply nothing to submit. Both link out; see isForeignListing in
 * lib/market/types.ts, which is the only test any caller should apply.
 *
 * NO CREDENTIAL. The API needs no key and no account, so none of
 * lib/market/opensea.ts's key-renewal machinery has an analogue here. Their
 * one authenticated endpoint (/api/v1/floor-prices) is not used.
 *
 * BE POLITE. Their docs ask for "no more than about one request per second",
 * publish no hard limit, and explicitly say to cache what you fetch. This
 * module is therefore only ever called from the cron
 * (scripts/refresh-market-data.ts), which is one request per pass regardless
 * of site traffic — never per visitor, even though their
 * Access-Control-Allow-Origin: * would permit a browser call.
 *
 * FRESHNESS IS BOUNDED BY THEIR PIPELINE, NOT OUR POLLING. Their responses
 * come from a cache rebuilt by scheduled jobs — marketplace event sync runs
 * HOURLY. Our ~15 minute cron is already four times their update rate, so a
 * listing can be up to an hour stale no matter how often we ask. If someone
 * later finds these rows lagging, polling harder will not fix it and is the
 * exact behaviour their etiquette note asks callers not to adopt.
 */

const PULP_BASE = "https://pulpmarket.app";

export const PULP_LISTINGS_KV = "plank:market:pulp-listings-v1";

/** Their chain ids: 369 PulseChain, 1 Ethereum, 8453 Base, 146 Sonic, 4663 Robinhood. */
const PULP_CHAIN_ID = CHAIN.id;

/**
 * One NFT as PulpMarket returns it. `price` is present only when the token is
 * actually listed, which is why the normaliser treats its absence as "not for
 * sale" rather than as a malformed row.
 */
export type PulpNft = {
  tokenId?: string;
  contractAddress?: string;
  owner?: string;
  name?: string;
  price?: string;
  listedTimestamp?: number;
  listingExpiresAt?: number;
};

export type PulpListedResponse = {
  success?: boolean;
  nfts?: PulpNft[];
  count?: number;
  cached?: boolean;
};

/**
 * Single HTTP chokepoint, same contract as opensea.ts's openSeaGet: returns
 * null on every failure path and never throws. A marketplace being down must
 * degrade the book, not break the request that reads it.
 */
async function pulpGet<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(`${PULP_BASE}${path}`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(20_000),
      cache: "no-store",
    });
    if (!res.ok) {
      console.warn(`[pulp] ${path} -> ${res.status}`);
      return null;
    }
    return (await res.json()) as T;
  } catch (error) {
    console.warn(`[pulp] ${path} failed:`, error);
    return null;
  }
}

/** Every currently-listed token in our collection on this chain. Not paginated upstream. */
export async function fetchPulpListings(): Promise<PulpListedResponse | null> {
  const params = new URLSearchParams({
    chainId: String(PULP_CHAIN_ID),
    collectionAddress: NFT_CONTRACT_ADDRESS,
  });
  return pulpGet<PulpListedResponse>(`/api/listed-nfts?${params.toString()}`);
}

/**
 * Wire rows -> the shape mergeBook consumes.
 *
 * Drops anything not actually purchasable rather than carrying it at a
 * nonsense price: no price at all (their schema returns unlisted tokens with
 * the field absent), a price that will not parse as an integer, or a
 * non-positive price. Mirrors normaliseOpenSeaListings' posture — a row we
 * cannot price correctly is worse than a row we omit, because a wrong price
 * on the grid moves the floor.
 *
 * `maker` is their `owner`. PulpMarket exposes no separate seller field; for
 * a live listing the holder is the seller, and this is display-only, so the
 * distinction has no consequence here.
 *
 * `expiresAt` uses their real `listingExpiresAt` where present. Note this is
 * BETTER than the OpenSea path, which never reads an end time and lets
 * mergeBook substitute a far-future sentinel.
 */
export function normalisePulpListings(nfts: readonly PulpNft[]): NormalisedForeignListing[] {
  const out: NormalisedForeignListing[] = [];
  for (const nft of nfts) {
    const tokenId = typeof nft.tokenId === "string" ? nft.tokenId : undefined;
    const maker = typeof nft.owner === "string" ? nft.owner : undefined;
    if (!tokenId || !maker) continue;
    if (typeof nft.price !== "string" || nft.price.length === 0) continue;

    let priceWei: bigint;
    try {
      priceWei = BigInt(nft.price);
    } catch {
      continue;
    }
    if (priceWei <= BigInt(0)) continue;

    const expiresAt =
      typeof nft.listingExpiresAt === "number" && Number.isFinite(nft.listingExpiresAt)
        ? new Date(nft.listingExpiresAt).toISOString()
        : null;

    out.push({
      tokenId,
      priceWei: priceWei.toString(),
      maker: maker.toLowerCase(),
      expiresAt,
      venue: "pulp",
    });
  }
  return out;
}

export async function readPulpListings(): Promise<NormalisedForeignListing[]> {
  if (!hasDurableKv()) return [];
  try {
    const rows = (await kv.get<NormalisedForeignListing[]>(PULP_LISTINGS_KV)) ?? [];
    // Stamped on read for the same reason as the OpenSea blob: stored rows
    // are only ever as new as the writer that wrote them, and a consumer must
    // not assume a field that data at rest predates.
    return rows.map((row) => ({ ...row, venue: "pulp" as const }));
  } catch {
    return [];
  }
}

/**
 * Cron write path. Fails soft to the previous value at every step — an outage
 * or an empty page must not shrink the book, because an empty result is
 * indistinguishable from "their cache is warming" and blanking real inventory
 * is the worse error.
 */
export async function refreshPulpListings(): Promise<NormalisedForeignListing[]> {
  const page = await fetchPulpListings();
  if (!page?.nfts?.length) return readPulpListings();
  const normalised = normalisePulpListings(page.nfts);
  if (normalised.length === 0) return readPulpListings();
  if (hasDurableKv()) {
    try {
      await kv.set(PULP_LISTINGS_KV, normalised);
    } catch {
      /* next run retries */
    }
  }
  return normalised;
}

/**
 * Deep link straight to the listing on PulpMarket.
 *
 * Their item view is addressed by query string on the collection page:
 * `/?collection=<contract>&token=<tokenId>`. Not discoverable by probing —
 * their SPA 404s every guessable path server-side and returns 200 for any
 * query string, so this came from the marketplace's own operator.
 *
 * Landing the buyer on the exact plank matters: these rows are display-only,
 * so the link IS the whole action. Dropping someone on a 17-item collection
 * page to hunt for the token they just clicked is the kind of small betrayal
 * that makes people stop trusting outbound links.
 */
export function pulpTokenUrl(contract: string, tokenId: string): string {
  const params = new URLSearchParams({
    collection: contract.toLowerCase(),
    token: String(tokenId),
  });
  return `${PULP_BASE}/?${params.toString()}`;
}
