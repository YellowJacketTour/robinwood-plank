import { CHAIN, CONTRACT_ADDRESS, NATIVE_TOKEN_ADDRESS, TOKEN } from "@/lib/constants";

/**
 * Server-side counter-token allowlist for the trade widget.
 *
 * Every pair the widget quotes has $PLANK on one side; the OTHER side (the
 * "counter token") must come from this list: native ETH plus whatever
 * Uniswap's official token list (tokens.uniswap.org) publishes for
 * Robinhood Chain — currently the tokenized-stock set. Routing between a
 * counter token and PLANK is the router's job (BEST_PRICE multihop through
 * their ETH pools); this module only decides what is ALLOWED, never what
 * is routable.
 *
 * The list is fetched at most once per TTL and cached in module memory
 * with a stale-if-error policy; on total failure the widget degrades to
 * ETH↔PLANK exactly as before this feature existed.
 */

export type CounterToken = {
  /** Checksummed address, or NATIVE_TOKEN_ADDRESS for chain-native ETH. */
  address: string;
  symbol: string;
  name: string;
  decimals: number;
};

const TOKEN_LIST_URL = "https://tokens.uniswap.org";
const TTL_MS = 6 * 60 * 60 * 1000; // 6h — the official list changes rarely

export const NATIVE_COUNTER: CounterToken = {
  address: NATIVE_TOKEN_ADDRESS,
  symbol: "ETH",
  name: "Ether",
  decimals: 18,
};

/** PLANK itself — exported for the client list; never a counter token. */
export const PLANK_TOKEN: CounterToken = {
  address: CONTRACT_ADDRESS,
  symbol: TOKEN.symbol,
  name: TOKEN.name ?? TOKEN.symbol,
  decimals: TOKEN.decimals,
};

type ListedToken = {
  chainId?: number;
  address?: string;
  symbol?: string;
  name?: string;
  decimals?: number;
};

let cache: { at: number; tokens: CounterToken[] } | null = null;

async function fetchChainTokens(): Promise<CounterToken[]> {
  const res = await fetch(TOKEN_LIST_URL, {
    signal: AbortSignal.timeout(10_000),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`token list HTTP ${res.status}`);
  const data = (await res.json()) as { tokens?: ListedToken[] };
  const plank = CONTRACT_ADDRESS.toLowerCase();
  return (data.tokens ?? [])
    .filter(
      (t): t is Required<Pick<ListedToken, "address" | "symbol" | "decimals">> & ListedToken =>
        t.chainId === CHAIN.id &&
        typeof t.address === "string" &&
        /^0x[a-fA-F0-9]{40}$/.test(t.address) &&
        t.address.toLowerCase() !== plank &&
        typeof t.symbol === "string" &&
        typeof t.decimals === "number" &&
        Number.isInteger(t.decimals) &&
        t.decimals >= 0 &&
        t.decimals <= 36
    )
    .map((t) => ({
      address: t.address,
      symbol: t.symbol,
      name: typeof t.name === "string" && t.name ? t.name : t.symbol,
      decimals: t.decimals,
    }))
    .sort((a, b) => a.symbol.localeCompare(b.symbol));
}

/** Native ETH first, then the official chain tokens. Never includes PLANK. */
export async function getCounterTokens(): Promise<CounterToken[]> {
  if (cache && Date.now() - cache.at < TTL_MS) {
    return [NATIVE_COUNTER, ...cache.tokens];
  }
  try {
    const tokens = await fetchChainTokens();
    cache = { at: Date.now(), tokens };
    return [NATIVE_COUNTER, ...tokens];
  } catch {
    // Stale-if-error, else ETH-only (the widget's pre-feature behavior).
    if (cache) return [NATIVE_COUNTER, ...cache.tokens];
    return [NATIVE_COUNTER];
  }
}

/** Resolve an allowed counter token by address (native included). */
export async function getCounterToken(address: string): Promise<CounterToken | null> {
  const a = address.toLowerCase();
  if (a === NATIVE_TOKEN_ADDRESS.toLowerCase()) return NATIVE_COUNTER;
  const all = await getCounterTokens();
  return all.find((t) => t.address.toLowerCase() === a) ?? null;
}
