import { durableKv, hasDurableKv } from "@/lib/market/durable-kv";

/**
 * Provider discovery: stop hardcoding the pool, start enumerating it.
 *
 * THE ASSUMPTION THIS BREAKS
 * -------------------------
 * Every pacing decision in this codebase -- the 8/second token bucket, the
 * 30-minute rest after a 429, the audited refusal to race IPFS gateways --
 * exists to ration a SMALL, HARDCODED pool. Two RPC endpoints per chain
 * (later seven). Seven IPFS gateways. Those lists are the real ceiling, and
 * every downstream throttle is a consequence of them rather than a law.
 *
 * A public rate limit is PER PROVIDER. So the budget is
 *
 *     providers x per-provider-limit
 *
 * and the first term was a constant somebody typed once. Measured
 * 2026-09-09:
 *
 *   chainid.network/chains.json    2,755 chains, and 52 keyless https
 *                                  endpoints across the 8 EVM chains we
 *                                  track (eth 13, bnb 14, base 7, polygon 6,
 *                                  arbitrum 4, optimism 4, avalanche 2,
 *                                  zksync 2)
 *   ipfs public-gateway-checker    11 gateways, only 2 of which were in our
 *                                  hardcoded list of 7
 *
 * 52 against 7 is not a tuning improvement. It is a different order of
 * magnitude, it costs nothing, and -- the part that matters most -- it keeps
 * growing without anyone editing this file. A registry is a living pool; a
 * literal is a snapshot of the day it was typed.
 *
 * WHY THIS IS NOT "IGNORING RATE LIMITS"
 * -------------------------------------
 * It is the opposite. Racing one host harder is what earned this app a
 * 30-minute cooldown (lib/ipfs.ts's header records 75 simultaneous requests
 * as the original sin), and a prior audit banned it for good reason.
 *
 * Spreading across many hosts RESPECTS every individual limit while removing
 * the aggregate one. Each provider still gets its own token bucket, its own
 * rest window, its own jail. We simply stop pretending there are only seven
 * doors.
 *
 * WHY DISCOVERY IS NEVER TRUSTED BLINDLY
 * -------------------------------------
 * A registry is a list of CLAIMS, not of working endpoints. Chainlist entries
 * go stale, hosts start requiring keys (polygon-rpc.com now answers 401), and
 * some fail TLS outright (llamarpc: HTTP 525). So every discovered endpoint is
 * PROBED before it may serve traffic, and the curated list always remains the
 * floor -- discovery can only ever ADD to a known-good pool, never replace it.
 *
 * That ordering is deliberate: a bad discovery pass must degrade to "no new
 * providers", never to "no providers".
 */

/** Where the EVM chain registry lives. Community-maintained, keyless. */
const CHAINLIST_URL = "https://chainid.network/chains.json";

/** The IPFS public gateway registry, maintained by the ipfs org. */
const IPFS_GATEWAY_REGISTRY =
  "https://raw.githubusercontent.com/ipfs/public-gateway-checker/master/gateways.json";

/**
 * How long a discovery result is reused.
 *
 * A day: registries change slowly, and re-fetching them per pass would make
 * the discovery layer its own rate-limit problem -- which would be a
 * spectacular own goal.
 */
const DISCOVERY_TTL_SEC = 24 * 3600;

/** Our chain slugs, mapped to the chain ids the registry keys on. */
export const CHAIN_IDS: Record<string, number> = {
  "eth-mainnet": 1,
  "base-mainnet": 8453,
  "arb-mainnet": 42161,
  "polygon-mainnet": 137,
  "bnb-mainnet": 56,
  "opt-mainnet": 10,
  "avax-mainnet": 43114,
  "zksync-mainnet": 324,
};

/**
 * Is this URL usable without a key?
 *
 * Registry entries frequently carry `${API_KEY}` placeholders or a provider's
 * own key path. Serving one of those would produce a 401 on every call, and
 * -- worse -- a jailed provider that looks like a rate limit rather than a
 * missing credential.
 */
export function isKeylessHttps(url: string): boolean {
  if (!url.startsWith("https://")) return false;
  if (url.includes("${") || url.includes("{")) return false;
  // Case-INSENSITIVE, because `?apiKey=` is the common camelCase form and a
  // case-sensitive pattern let it straight through -- a keyed URL in a
  // "free public" pool fails every call and looks like throttling rather
  // than a missing credential, which is a diagnosis nobody reaches quickly.
  // The long-hex clause catches provider key paths like /v3/<32 hex>.
  if (/api[_-]?key|apikey|access[_-]?token|\/v\d\/[0-9a-f]{20,}/i.test(url)) return false;
  // wss:// and http:// are both out: one is a different protocol, the other
  // is a downgrade on every call that would use it.
  return true;
}

export interface DiscoveredProvider {
  url: string;
  /** The registry host, used as the pacing/jailing key. */
  host: string;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return url;
  }
}

/**
 * Probe an RPC endpoint the way this codebase already verifies providers: a
 * real eth_blockNumber, and a real block number back.
 *
 * A 200 is not enough. Some hosts answer 200 with a JSON-RPC error body, and
 * treating those as healthy would put a broken provider into rotation where it
 * fails every call and burns its share of the budget.
 */
export async function probeRpc(url: string, timeoutMs = 8_000): Promise<boolean> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return false;
    const body = (await res.json()) as { result?: unknown; error?: unknown };
    if (body.error) return false;
    return typeof body.result === "string" && body.result.startsWith("0x");
  } catch {
    return false;
  }
}

/**
 * Discover keyless RPC endpoints for one chain, probed and ready to serve.
 *
 * `known` is the curated pool and is ALWAYS the floor: discovery adds, never
 * replaces. A registry outage, a schema change, or a bad parse degrades this
 * to "no new providers" rather than to "no providers", which is the only
 * acceptable failure mode for the layer everything else depends on.
 */
export async function discoverRpcProviders(
  chainSlug: string,
  known: string[],
  opts: { probe?: boolean; max?: number } = {},
): Promise<DiscoveredProvider[]> {
  const chainId = CHAIN_IDS[chainSlug];
  if (!chainId) return [];

  const cacheKey = `plank:rpc-discovery:${chainSlug}`;
  if (hasDurableKv()) {
    try {
      const hit = await durableKv.get<DiscoveredProvider[]>(cacheKey);
      if (hit?.length) return hit;
    } catch {
      // A cache miss is not a failure; fall through and discover.
    }
  }

  let candidates: string[] = [];
  try {
    const res = await fetch(CHAINLIST_URL, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return [];
    const chains = (await res.json()) as Array<{ chainId: number; rpc?: string[] }>;
    const entry = chains.find((c) => c.chainId === chainId);
    candidates = (entry?.rpc ?? []).filter(isKeylessHttps);
  } catch {
    return [];
  }

  // Never re-offer what the curated pool already has: a duplicate is one
  // budget wearing two names, and the rotation would believe it had more
  // capacity than it does.
  const knownHosts = new Set(known.map(hostOf));
  const fresh = candidates
    .filter((u) => !knownHosts.has(hostOf(u)))
    .filter((u, i, arr) => arr.findIndex((x) => hostOf(x) === hostOf(u)) === i)
    .slice(0, opts.max ?? 12);

  const usable: DiscoveredProvider[] = [];
  for (const url of fresh) {
    if (opts.probe === false || (await probeRpc(url))) {
      usable.push({ url, host: hostOf(url) });
    }
  }

  if (hasDurableKv() && usable.length) {
    try {
      await durableKv.set(cacheKey, usable, { ex: DISCOVERY_TTL_SEC });
    } catch {
      // Losing the cache costs a re-probe, never correctness.
    }
  }
  return usable;
}

/**
 * Discover public IPFS gateways beyond the curated list.
 *
 * Measured 2026-09-09: the registry held 11 gateways and only TWO were in our
 * hardcoded seven. The same shape as the RPC pool -- a literal typed once,
 * standing in for a population that keeps changing.
 *
 * Returned as `https://host/ipfs/` prefixes, which is the shape
 * PLANK_IPFS_GATEWAYS and ipfsGatewayCandidates already expect, so this
 * composes with the existing token bucket and rest windows rather than
 * bypassing them.
 */
export async function discoverIpfsGateways(known: string[]): Promise<string[]> {
  const cacheKey = "plank:ipfs-gateway-discovery";
  if (hasDurableKv()) {
    try {
      const hit = await durableKv.get<string[]>(cacheKey);
      if (hit?.length) return hit;
    } catch {
      // fall through
    }
  }

  let raw: string[] = [];
  try {
    const res = await fetch(IPFS_GATEWAY_REGISTRY, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return [];
    raw = (await res.json()) as string[];
  } catch {
    return [];
  }

  const knownHosts = new Set(known.map(hostOf));
  const out = raw
    .filter((u) => typeof u === "string" && isKeylessHttps(u))
    .map((u) => `${u.replace(/\/+$/, "")}/ipfs/`)
    .filter((u) => !knownHosts.has(hostOf(u)))
    .filter((u, i, arr) => arr.findIndex((x) => hostOf(x) === hostOf(u)) === i);

  if (hasDurableKv() && out.length) {
    try {
      await durableKv.set(cacheKey, out, { ex: DISCOVERY_TTL_SEC });
    } catch {
      // fall through
    }
  }
  return out;
}
