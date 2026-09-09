/**
 * The proof cache: content-addressed bytes are fetched once, ever.
 *
 * MEASURED, NOT ASSUMED (live crawl 2026-09-09)
 * --------------------------------------------
 * `/api/ipfs/metadata` on the homepage: 10 calls, median 5,651 ms, 33.4
 * seconds in total, seven of them 500. Same CID directory, same gateway, same
 * instant -- three succeeded and seven did not, so it is neither a bad CID nor
 * a dead gateway.
 *
 * The gateway itself, measured directly:
 *
 *     gateway.pinata.cloud/ipfs/<cid>/BossPlank.png  ->  200 in 4.478 s
 *     GATEWAY_TIMEOUT_MS                             ->  5.000 s
 *
 * Pinata answers in 4.478 s and we hang up at 5. Add the per-host token bucket
 * (8/second, burst 8) and the tail of any burst crosses the line and dies. The
 * art is not missing; we are half a second too impatient.
 *
 * THE ACTUAL BUG IS THAT WE ASK TWICE
 * -----------------------------------
 * A CID is the hash of its own bytes. They cannot change. Fetching one twice
 * is always waste -- and the route already knows this: it returns
 * `cachedPublicJson(metadata, "immutable")` with a one-year CDN header. But
 * `cf-cache-status: DYNAMIC` on every response says Cloudflare stores none of
 * it (the zone does not cache query-string URLs), and `lib/ipfs.ts` passes
 * `cache: "no-store"` on the fetch itself.
 *
 * So the right intent is declared in three places and delivers nothing. Every
 * visitor pays full gateway cost forever for bytes that are provably identical.
 *
 * This is the serving-side twin of `packages/akasha/src/hose/workkey.ts`,
 * which already applies exactly this rule to the INGEST path.
 *
 * WHY THE TIMEOUT CAN THEN BE GENEROUS
 * ------------------------------------
 * Today's 5 s is tight because the cost is paid on every request, so a slow
 * gateway would hurt every visitor. Once a proof is fetched once, a generous
 * timeout costs one visitor once and saves everyone after. A slow proof stops
 * being a missing proof. The timeout being tight was a symptom of the missing
 * cache, not a safety measure.
 *
 * WHAT MAY NOT BE CACHED THIS WAY
 * -------------------------------
 * Only self-authenticating bytes. A CID or a bytecode hash names its own
 * content, so one report is canonical. An HTTPS URL names a LOCATION: two
 * hosts may serve different bytes for one path and the same host may serve
 * different bytes tomorrow. `proofKey` returns null for those rather than
 * inventing a key -- caching a mutable body forever is a far worse bug than
 * fetching it twice.
 */
import { durableKv, hasDurableKv } from "@/lib/market/durable-kv";

/** Proofs never expire, but a KV needs a number. Ten years is "never". */
export const PROOF_TTL_SEC = 10 * 365 * 24 * 3600;

/**
 * A CID is [a-z2-7]{59} (v1 base32) or Qm... (v0 base58). Matching loosely on
 * purpose -- the point is to recognise self-authenticating identifiers, not to
 * re-implement multibase parsing. Anything unrecognised gets no key, which
 * fails toward "fetch it again" rather than toward "serve stale bytes
 * forever".
 */
const CID_V1 = /\b(ba[a-z2-7]{57})\b/i;
const CID_V0 = /\b(Qm[1-9A-HJ-NP-Za-km-z]{44})\b/;

/**
 * The cache key for a URI, or null when its bytes are not self-authenticating.
 *
 * `ipfs://<cid>/path` and any gateway URL containing a CID key on
 * (cid, path) -- the same directory served through Pinata, ipfs.io or
 * dweb.link is ONE proof, so a gateway rotation cannot cause a second fetch.
 * That is the whole point of content addressing and the current code throws it
 * away by keying on the full gateway URL.
 */
export function proofKey(uri: string): string | null {
  const raw = (uri ?? "").trim();
  if (!raw) return null;

  const cid = raw.match(CID_V1)?.[1] ?? raw.match(CID_V0)?.[1];
  if (!cid) return null;

  // Everything after the CID is the path within it, normalised so that
  // ipfs://cid/1 and https://gw/ipfs/cid/1 collapse to one key.
  const after = raw.slice(raw.indexOf(cid) + cid.length);
  const path = after.split(/[?#]/)[0]!.replace(/^\/+/, "");
  return `proof:${cid.toLowerCase()}${path ? `/${path}` : ""}`;
}

/** Is this URI content-addressed at all? */
export function isProof(uri: string): boolean {
  return proofKey(uri) !== null;
}

/**
 * Read a proof, or null.
 *
 * A cache failure is never an error: the caller refetches. Silence here would
 * be the worse bug, so a backend that is misbehaving degrades to "no cache"
 * rather than to "no data".
 */
export async function readProof<T>(uri: string): Promise<T | null> {
  if (!hasDurableKv()) return null;
  const key = proofKey(uri);
  if (!key) return null;
  try {
    return (await durableKv.get<T>(key)) ?? null;
  } catch {
    return null;
  }
}

/**
 * Store a proof. Refuses anything that is not content-addressed.
 *
 * The refusal is the load-bearing part. Persisting a mutable body under a
 * shared key would serve one host's answer as every host's answer, forever --
 * the two-matching-hashes fallacy with a decade-long TTL attached.
 */
export async function writeProof(uri: string, value: unknown): Promise<boolean> {
  if (!hasDurableKv()) return false;
  const key = proofKey(uri);
  if (!key) return false;
  if (value === undefined || value === null) return false;
  try {
    await durableKv.set(key, value, { ex: PROOF_TTL_SEC });
    return true;
  } catch {
    return false;
  }
}
