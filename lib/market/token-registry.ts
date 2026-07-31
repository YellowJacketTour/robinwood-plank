import { durableKv as kv, hasDurableKv } from "@/lib/market/durable-kv";

/**
 * Venue-neutral token registry for chain 4663.
 *
 * Replaces "whatever Uniswap's token list happens to contain" as the source of
 * truth. Two things forced this:
 *
 * 1. That list is 95/103 tokenised equities, sorted alphabetically, so the
 *    picker opened on AAOI/AAPL/AMAT/AMD/AMZN — and the tokens this audience
 *    actually trades (memecoins, tier-1 assets) were not in it AT ALL. They
 *    only ever appeared through chain search.
 * 2. The app routes through Uniswap and 0x today and may add 9mm and drop
 *    Uniswap. If a venue's list defines which tokens exist, swapping venues
 *    means rewriting the picker instead of swapping one adapter.
 *
 * So identity comes from the chain, and venues contribute availability:
 *
 *   core      — ETH/WETH/USDG. Must survive every upstream outage.
 *   discovery — Blockscout's token index, ranked by real market activity. This
 *               is the only source that carries memecoins.
 *   venues    — adapters marking which tokens a router can quote. Metadata on
 *               an entry, never the reason an entry exists.
 *
 * Ordering falls out of the data rather than a hand-tuned preference: sort by
 * traded volume and illiquid equities sink on their own, while a genuinely
 * active one keeps its place. No rule needs to encode "equities go last".
 */

const REGISTRY_KV = "plank:market:token-registry-v1";
const BLOCKSCOUT_TOKENS = "https://robinhoodchain.blockscout.com/api/v2/tokens";
/** Enough to cover everything with real activity without unbounded paging. */
const MAX_PAGES = 4;

export type RegistryToken = {
  /** Lowercase. The identity key across every source. */
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  logoURI?: string;
  /** 24h traded volume as reported by the chain explorer. Drives ordering. */
  volume24h: number;
  holders: number;
  /** A price is tracked for this contract — real contracts have one, impostors do not. */
  priceTracked: boolean;
  /** Listed by Robinhood on this chain: a tokenised equity. */
  equity?: boolean;
  /** Routers known to quote this token, e.g. ["uniswap", "0x"]. */
  venues?: string[];
};

type BlockscoutToken = {
  address_hash?: string;
  symbol?: string;
  name?: string;
  decimals?: string;
  icon_url?: string | null;
  volume_24h?: string | null;
  holders_count?: string;
  exchange_rate?: string | null;
  circulating_market_cap?: string | null;
};

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function toRegistryToken(t: BlockscoutToken): RegistryToken | null {
  const address = t.address_hash;
  if (typeof address !== "string" || !/^0x[a-fA-F0-9]{40}$/.test(address)) return null;
  const symbol = (t.symbol || "").trim();
  if (!symbol) return null; // unusable in a picker
  const decimals = Number(t.decimals);
  return {
    address: address.toLowerCase(),
    symbol,
    name: (t.name || symbol).trim(),
    decimals: Number.isFinite(decimals) ? decimals : 18,
    // Rendered as an <img src>, so anything not plainly https is dropped.
    ...(typeof t.icon_url === "string" && /^https:\/\//.test(t.icon_url)
      ? { logoURI: t.icon_url }
      : {}),
    volume24h: num(t.volume_24h),
    holders: num(t.holders_count),
    priceTracked: num(t.exchange_rate) > 0 || num(t.circulating_market_cap) > 0,
  };
}

/**
 * Most-traded first, then holders, then a stable tiebreak.
 *
 * Deliberately not alphabetical and deliberately not a curated preference
 * order: activity is the thing a trader is actually asking about, and it keeps
 * itself current as tokens rise and die without anyone editing a list.
 */
export function rankRegistry(tokens: RegistryToken[]): RegistryToken[] {
  return [...tokens].sort((a, b) => {
    if (b.volume24h !== a.volume24h) return b.volume24h - a.volume24h;
    if (b.holders !== a.holders) return b.holders - a.holders;
    return a.symbol.localeCompare(b.symbol);
  });
}

export function mergeVenueAvailability(
  tokens: RegistryToken[],
  venue: string,
  addresses: Set<string>
): RegistryToken[] {
  if (addresses.size === 0) return tokens;
  return tokens.map((t) =>
    addresses.has(t.address)
      ? { ...t, venues: [...new Set([...(t.venues ?? []), venue])] }
      : t
  );
}

export function markEquities(
  tokens: RegistryToken[],
  equityAddresses: Set<string>
): RegistryToken[] {
  if (equityAddresses.size === 0) return tokens;
  return tokens.map((t) =>
    equityAddresses.has(t.address) ? { ...t, equity: true } : t
  );
}

async function fetchDiscovery(): Promise<RegistryToken[]> {
  const out: RegistryToken[] = [];
  const seen = new Set<string>();
  let next: Record<string, string | number> | null = null;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const qs = new URLSearchParams({ type: "ERC-20" });
    for (const [k, v] of Object.entries(next ?? {})) qs.set(k, String(v));
    const res = await fetch(`${BLOCKSCOUT_TOKENS}?${qs}`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
      cache: "no-store",
    });
    if (!res.ok) break;
    const data = (await res.json()) as {
      items?: BlockscoutToken[];
      next_page_params?: Record<string, string | number> | null;
    };
    for (const raw of data.items ?? []) {
      const token = toRegistryToken(raw);
      if (!token || seen.has(token.address)) continue;
      seen.add(token.address);
      out.push(token);
    }
    next = data.next_page_params ?? null;
    if (!next || Object.keys(next).length === 0) break;
  }
  return out;
}

export async function readTokenRegistry(): Promise<RegistryToken[]> {
  if (!hasDurableKv()) return [];
  try {
    return (await kv.get<RegistryToken[]>(REGISTRY_KV)) ?? [];
  } catch {
    return [];
  }
}

/**
 * Rebuild from the chain, annotate, and store. Keeps the previous copy on any
 * failure — a shrunken token list is a worse outcome than a slightly stale one.
 */
export async function refreshTokenRegistry(): Promise<RegistryToken[]> {
  let discovered: RegistryToken[] = [];
  try {
    discovered = await fetchDiscovery();
  } catch {
    return readTokenRegistry();
  }
  if (discovered.length === 0) return readTokenRegistry();

  const { readOfficialAssets } = await import("@/lib/market/robinhood-assets");
  const equities = new Set((await readOfficialAssets().catch(() => [])).map((a) => a.address));

  let tokens = markEquities(discovered, equities);

  // Venue availability is an annotation. A venue not listing a token does not
  // remove it from the registry; it only means that router cannot quote it.
  try {
    const { getCounterTokens } = await import("@/lib/uniswap-tokenlist");
    const uni = new Set((await getCounterTokens()).map((t) => t.address.toLowerCase()));
    tokens = mergeVenueAvailability(tokens, "uniswap", uni);
  } catch {
    /* a venue adapter failing must not empty the registry */
  }

  const ranked = rankRegistry(tokens);
  if (hasDurableKv()) {
    try {
      await kv.set(REGISTRY_KV, ranked);
    } catch {
      /* next run retries */
    }
  }
  return ranked;
}
