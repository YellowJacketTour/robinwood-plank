/**
 * OKX -- a real, large Bitcoin Ordinals marketplace/aggregator (292k+
 * listing orders per OKX's own public stats as of 2026-08-24), added
 * alongside Satflow to broaden free coverage beyond UniSat/OrdinalsWallet.
 * Owner explicitly asked for this after Satflow: "help me get a key for
 * satflow and okx and weave them elegantly into total solution."
 *
 * REAL, CONFIRMED PARTS (verified against OKX's own public docs)
 * -----------------------------------------------------------------
 * - Base URL: https://web3.okx.com
 * - Auth: OK-ACCESS-KEY / OK-ACCESS-SIGN / OK-ACCESS-TIMESTAMP /
 *   OK-ACCESS-PASSPHRASE headers -- standard OKX v5 REST auth. Sign =
 *   base64(HMAC-SHA256(secret, timestamp + method + requestPath + body)),
 *   timestamp = ISO-8601 with milliseconds (JS Date#toISOString() is
 *   exactly this format). Server rejects requests >30s clock-skew.
 * - Real endpoint paths (from OKX's public Ordinals Marketplace API docs
 *   search index): GET /api/v5/mktplace/nft/ordinals/collections
 *   (collection list/stats) and POST /api/v5/mktplace/nft/ordinals/listings
 *   (active listings for one collection).
 *
 * FIELD NAMES: confirmed via OKX's own indexed public docs (their portal
 * itself is a client-rendered SPA that 404s on direct fetch -- same
 * problem this session hit with Gamma's page -- but a search of their
 * docs' own indexed content surfaced the real documented response shape).
 * Listings response items carry: inscriptionId, amount, isBrc20,
 * listingTime, listingUrl, ownerAddress, price, slug, unitPrice. Used as
 * the PRIMARY field names below, with the same defensive fallback
 * variants satflow-ordinals.ts uses as a secondary safety net (OKX's
 * portal search snippets are real but not a live-tested response, so a
 * fallback costs nothing and protects against a doc/reality drift).
 * `ownerAddress` is the seller (the listing owner offering to sell).
 * verifyOkxCredentials() below is still the real, final confirmation step
 * once credentials exist -- run it once before trusting production
 * output, per this session's "never trust an unverified integration"
 * single guessed shape. verifyOkxCredentials() below MUST be run once a
 * real key exists (see its own header) before trusting this adapter's
 * output in production -- this is flagged, not silently assumed correct.
 */
import { createHmac } from "node:crypto";
import { checkSourceBudget, recordSourceSuccess, recordSourceFailure } from "@/lib/market/multichain/discovery/source-budget";

const OKX_BASE_URL = "https://web3.okx.com";
const OKX_SOURCE = "okx-ordinals";

function credentials(): { key: string; secret: string; passphrase: string } | null {
  const key = process.env.OKX_API_KEY?.trim();
  const secret = process.env.OKX_API_SECRET?.trim();
  const passphrase = process.env.OKX_API_PASSPHRASE?.trim();
  if (!key || !secret || !passphrase) return null;
  return { key, secret, passphrase };
}

function sign(secret: string, timestamp: string, method: string, requestPath: string, body: string): string {
  return createHmac("sha256", secret).update(`${timestamp}${method}${requestPath}${body}`).digest("base64");
}

async function okxRequest<T>(method: "GET" | "POST", path: string, bodyObj?: Record<string, unknown>): Promise<T | null> {
  const creds = credentials();
  if (!creds) return null;
  const gate = checkSourceBudget(OKX_SOURCE);
  if (!gate.allowed) return null;
  const timestamp = new Date().toISOString();
  const body = bodyObj ? JSON.stringify(bodyObj) : "";
  const signature = sign(creds.secret, timestamp, method, path, body);
  try {
    const res = await fetch(`${OKX_BASE_URL}${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        "OK-ACCESS-KEY": creds.key,
        "OK-ACCESS-SIGN": signature,
        "OK-ACCESS-TIMESTAMP": timestamp,
        "OK-ACCESS-PASSPHRASE": creds.passphrase,
      },
      body: method === "POST" ? body : undefined,
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      recordSourceFailure(OKX_SOURCE, res.status === 429);
      return null;
    }
    recordSourceSuccess(OKX_SOURCE);
    return (await res.json()) as T;
  } catch {
    recordSourceFailure(OKX_SOURCE, false);
    return null;
  }
}

export type OkxListing = {
  inscriptionId: string;
  priceSats: number;
  sellerAddress: string | null;
};

/**
 * Real active listings for one collection. Returns [] (never throws)
 * when no credentials are configured or the real call fails/is jailed --
 * same honest-empty discipline as every other adapter here. Field-name
 * parsing is defensive (see this file's header) since the exact response
 * shape isn't live-confirmed yet.
 */
export async function fetchOkxOrdinalsListings(collectionSlug: string, limit = 50): Promise<OkxListing[]> {
  const body = await okxRequest<{ code?: string; data?: unknown }>(
    "POST",
    "/api/v5/mktplace/nft/ordinals/listings",
    { collectionSlug, slug: collectionSlug, limit }
  );
  if (!body) return [];
  const dataRaw = body.data;
  const items: unknown[] = Array.isArray(dataRaw)
    ? dataRaw
    : Array.isArray((dataRaw as { list?: unknown[] } | undefined)?.list)
      ? (dataRaw as { list: unknown[] }).list
      : Array.isArray((dataRaw as { items?: unknown[] } | undefined)?.items)
        ? (dataRaw as { items: unknown[] }).items
        : [];
  const out: OkxListing[] = [];
  for (const raw of items) {
    const item = raw as Record<string, unknown>;
    // Confirmed real field names (OKX's own docs index): inscriptionId,
    // price, ownerAddress. Fallback variants are a defensive safety net,
    // not the primary path -- see this file's header.
    const inscriptionId = String(item.inscriptionId ?? item.inscription_id ?? item.itemId ?? item.tokenId ?? "");
    const priceRaw = item.price ?? item.unitPrice ?? item.amount ?? item.listPrice ?? item.sellAmount;
    const priceSats = Number(priceRaw);
    const seller = (item.ownerAddress ?? item.sellerAddress ?? item.seller ?? item.owner ?? null) as string | null;
    if (!inscriptionId || !Number.isFinite(priceSats) || priceSats <= 0) continue;
    out.push({ inscriptionId, priceSats, sellerAddress: seller });
  }
  return out.slice(0, limit);
}

export type OkxCollectionStats = {
  floorPriceSats: number | null;
  listedCount: number | null;
  totalSupply: number | null;
};

/** Real collection-level stats via GET /ordinals/collections, filtered client-side to the matching slug. Same honest-null discipline; field names are defensive for the same reason as fetchOkxOrdinalsListings. */
export async function fetchOkxCollectionStats(collectionSlug: string): Promise<OkxCollectionStats | null> {
  const body = await okxRequest<{ code?: string; data?: unknown }>("GET", "/api/v5/mktplace/nft/ordinals/collections");
  if (!body) return null;
  const dataRaw = body.data;
  const items: unknown[] = Array.isArray(dataRaw)
    ? dataRaw
    : Array.isArray((dataRaw as { list?: unknown[] } | undefined)?.list)
      ? (dataRaw as { list: unknown[] }).list
      : [];
  const match = items
    .map((raw) => raw as Record<string, unknown>)
    .find((item) => String(item.slug ?? item.collectionSlug ?? "").toLowerCase() === collectionSlug.toLowerCase());
  if (!match) return null;
  const floorRaw = match.floorPrice ?? match.floor_price;
  const listedRaw = match.listedCount ?? match.listed_count ?? match.listNum;
  const supplyRaw = match.totalSupply ?? match.total_supply ?? match.supply;
  return {
    floorPriceSats: Number.isFinite(Number(floorRaw)) ? Number(floorRaw) : null,
    listedCount: Number.isFinite(Number(listedRaw)) ? Number(listedRaw) : null,
    totalSupply: Number.isFinite(Number(supplyRaw)) ? Number(supplyRaw) : null,
  };
}

/**
 * Run this once real OKX credentials are configured, before trusting the
 * adapter above: confirms auth actually succeeds and logs the REAL raw
 * response shape for a known collection, so the defensive field-name
 * parsing above can be corrected against real data instead of guesses.
 * Deliberately not wired into any request path -- a manual verification
 * step, matching this session's "never trust an unverified integration"
 * discipline.
 */
export async function verifyOkxCredentials(): Promise<{ ok: boolean; raw?: unknown }> {
  // The real endpoint returns every tracked collection in one page, not a
  // per-slug lookup -- inspect `raw` for a well-known real collection
  // (e.g. "bitcoin-puppets") to confirm the real field names by hand.
  const body = await okxRequest<unknown>("GET", "/api/v5/mktplace/nft/ordinals/collections");
  if (!body) return { ok: false };
  return { ok: true, raw: body };
}
