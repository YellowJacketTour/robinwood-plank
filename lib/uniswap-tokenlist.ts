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
  /** From the upstream Uniswap list, when present — as of this writing NONE
   * of the ~100 Robinhood Chain entries carry one (checked live against
   * tokens.uniswap.org), so the client always has a letter-avatar fallback
   * and never fabricates artwork for a token that doesn't have one. */
  logoURI?: string;
  /** True only for a token resolved via validateArbitraryCounterToken —
   * on-chain ERC20 metadata, never curated/reviewed. The client must show a
   * warning before it's selectable; never set for anything in the curated
   * list or CORE_COUNTERS. */
  unverified?: boolean;
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

/**
 * Chain-core money tokens the official stock-focused list omits entirely —
 * users pay with these (they even appear as hops in our own quote routes),
 * so their absence made the selector look broken ("No tokens match USDG"
 * while the route line showed USDG). Hand-pinned because Blockscout is full
 * of same-symbol impostors ("United States Dump Coin" etc.):
 * - USDG cross-checked against the address the Uniswap app itself displays
 *   for Robinhood Chain (0x5fc5…d168, Global Dollar, 6 decimals);
 * - WETH cross-checked against the WETH hop in live Trading API quote
 *   routes (0x0Bd7…AD73).
 * No canonical USDC/USDT exists on this chain as of 2026-07-30 — every
 * Blockscout match is a low-holder lookalike, deliberately NOT listed.
 */
const CORE_COUNTERS: CounterToken[] = [
  {
    address: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
    symbol: "USDG",
    name: "Global Dollar",
    decimals: 6,
  },
  {
    address: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
    symbol: "WETH",
    name: "Wrapped Ether",
    decimals: 18,
  },
];

type ListedToken = {
  chainId?: number;
  address?: string;
  symbol?: string;
  name?: string;
  decimals?: number;
  logoURI?: string;
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
      // Only ever pass through a well-formed http(s) URL — an externally
      // sourced field renders as an <img src>, so anything else (data:,
      // javascript:, malformed) is dropped rather than trusted.
      logoURI:
        typeof t.logoURI === "string" && /^https:\/\//.test(t.logoURI) ? t.logoURI : undefined,
    }))
    .sort((a, b) => a.symbol.localeCompare(b.symbol));
}

/**
 * Push tokenised equities to the end of the picker.
 *
 * 95 of the 103 tokens on this chain's Uniswap list are Robinhood stock
 * tokens, so a plain alphabetical sort opens the picker on AAOI, AAPL, AMAT,
 * AMD, AMZN — a wall of tickers. That is the wrong first impression for an
 * audience here to trade $PLANK and other chain-native tokens; equities are a
 * thing this chain happens to carry, not what these users came for.
 *
 * Nothing is hidden — every stock token is still listed and still searchable
 * by symbol. They simply stop crowding out the first screen.
 *
 * Uses Robinhood's own registry to identify them, which is exact. If it has
 * not been fetched yet the order falls back to plain alphabetical, so a cold
 * cache degrades to today's behaviour rather than to something arbitrary.
 */
export function demoteEquities<T extends { address: string }>(
  tokens: T[],
  equityAddresses: Set<string>
): T[] {
  if (equityAddresses.size === 0) return tokens;
  const rest: T[] = [];
  const equities: T[] = [];
  for (const t of tokens) {
    (equityAddresses.has(t.address.toLowerCase()) ? equities : rest).push(t);
  }
  return [...rest, ...equities];
}

/** Core money tokens first (deduped against the fetched list), then the
 * official chain tokens. The core set survives upstream-list outages — it
 * must never disappear just because tokens.uniswap.org is down. */
function withCore(tokens: CounterToken[]): CounterToken[] {
  const seen = new Set(tokens.map((t) => t.address.toLowerCase()));
  const core = CORE_COUNTERS.filter((t) => !seen.has(t.address.toLowerCase()));
  return [NATIVE_COUNTER, ...core, ...tokens];
}

/** Native ETH + core money tokens first, then the official chain tokens.
 * Never includes PLANK. */
/** Addresses of tokenised equities, from Robinhood's own registry. */
async function equityAddresses(): Promise<Set<string>> {
  try {
    const { readOfficialAssets } = await import("@/lib/market/robinhood-assets");
    return new Set((await readOfficialAssets()).map((a) => a.address));
  } catch {
    return new Set();
  }
}

export async function getCounterTokens(): Promise<CounterToken[]> {
  // withCore pins ETH/WETH/USDG at the front; demoteEquities only reorders
  // what follows, so the core money tokens stay first either way.
  const equities = await equityAddresses();
  if (cache && Date.now() - cache.at < TTL_MS) {
    return demoteEquities(withCore(cache.tokens), equities);
  }
  try {
    const tokens = await fetchChainTokens();
    cache = { at: Date.now(), tokens };
    return demoteEquities(withCore(tokens), equities);
  } catch {
    // Stale-if-error, else ETH+core-only (pre-feature behavior plus core).
    if (cache) return demoteEquities(withCore(cache.tokens), equities);
    return withCore([]);
  }
}

/** Resolve an allowed counter token by address (native included). */
export async function getCounterToken(address: string): Promise<CounterToken | null> {
  const a = address.toLowerCase();
  if (a === NATIVE_TOKEN_ADDRESS.toLowerCase()) return NATIVE_COUNTER;
  const all = await getCounterTokens();
  return all.find((t) => t.address.toLowerCase() === a) ?? null;
}

/**
 * On-chain ERC20 validation for a token NOT on the curated list — "import by
 * address". Reads symbol()/name()/decimals()/totalSupply() directly via RPC
 * (lib/market/fetch-rpc's ethCall, the same server-side JSON-RPC helper the
 * vault dashboard uses) and rejects anything that doesn't look like a real,
 * callable ERC20. Never touches an off-chain registry — the contract itself
 * is the only source of truth, so there's nothing here to spoof by naming a
 * token "AAPL". Result is cached (address -> token-or-null) so repeat quotes
 * for the same import don't re-hit RPC every time.
 */
const SYMBOL_SELECTOR = "0x95d89b41";
const NAME_SELECTOR = "0x06fdde03";
const DECIMALS_SELECTOR = "0x313ce567";
const TOTAL_SUPPLY_SELECTOR = "0x18160ddd";
const UNVERIFIED_TTL_MS = 6 * 60 * 60 * 1000; // 6h — ERC20 metadata never changes; just bounds memory

const unverifiedCache = new Map<string, { at: number; token: CounterToken | null }>();

/** Decode a single dynamic `string` ABI return (offset + length + utf8 bytes). */
function decodeAbiString(hex: string): string | null {
  try {
    const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
    if (clean.length < 128) return null;
    const len = parseInt(clean.slice(64, 128), 16);
    if (!Number.isFinite(len) || len < 0 || len > 256) return null;
    const dataHex = clean.slice(128, 128 + len * 2);
    if (dataHex.length !== len * 2) return null;
    const str = Buffer.from(dataHex, "hex").toString("utf8").replace(/\0/g, "").trim();
    return str || null;
  } catch {
    return null;
  }
}

/** Legacy (pre-ERC20-string-standard) tokens return symbol/name as bytes32. */
function decodeBytes32String(hex: string): string | null {
  try {
    const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
    if (clean.length < 64) return null;
    const str = Buffer.from(clean.slice(0, 64), "hex").toString("utf8").replace(/\0/g, "").trim();
    return str || null;
  } catch {
    return null;
  }
}

function decodeUint(hex: string): number | null {
  try {
    const n = Number(BigInt(hex));
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

export async function validateArbitraryCounterToken(rawAddress: string): Promise<CounterToken | null> {
  if (!/^0x[a-fA-F0-9]{40}$/.test(rawAddress)) return null;
  const key = rawAddress.toLowerCase();
  if (key === NATIVE_TOKEN_ADDRESS.toLowerCase() || key === CONTRACT_ADDRESS.toLowerCase()) return null;

  const cached = unverifiedCache.get(key);
  if (cached && Date.now() - cached.at < UNVERIFIED_TTL_MS) return cached.token;

  const reject = (): null => {
    unverifiedCache.set(key, { at: Date.now(), token: null });
    return null;
  };

  try {
    const { ethCall } = await import("@/lib/market/fetch-rpc");
    const [symbolHex, nameHex, decimalsHex, supplyHex] = await Promise.all([
      ethCall(rawAddress, SYMBOL_SELECTOR).catch(() => null),
      ethCall(rawAddress, NAME_SELECTOR).catch(() => null),
      ethCall(rawAddress, DECIMALS_SELECTOR).catch(() => null),
      ethCall(rawAddress, TOTAL_SUPPLY_SELECTOR).catch(() => null),
    ]);

    // decimals() and totalSupply() are the two calls every real ERC20 must
    // answer with a real number — missing/malformed on either means this
    // isn't a callable ERC20 on this chain (wrong address, EOA, non-token
    // contract, etc).
    if (!decimalsHex || !supplyHex) return reject();
    const decimals = decodeUint(decimalsHex);
    if (decimals == null || decimals < 0 || decimals > 36) return reject();
    if (decodeUint(supplyHex) == null) return reject();

    const symbol =
      (symbolHex && (decodeAbiString(symbolHex) || decodeBytes32String(symbolHex))) || null;
    if (!symbol) return reject(); // no readable symbol — reject rather than show a blank token
    const name =
      (nameHex && (decodeAbiString(nameHex) || decodeBytes32String(nameHex))) || symbol;

    const token: CounterToken = {
      address: rawAddress,
      symbol,
      name,
      decimals,
      unverified: true,
    };
    unverifiedCache.set(key, { at: Date.now(), token });
    return token;
  } catch {
    return reject();
  }
}

/**
 * The single entry point every server route should use to resolve a counter
 * token: curated list first (fast, no RPC), falling back to live on-chain
 * ERC20 validation for anything else. A token can only ever enter a quote
 * after passing one of these two checks — this is what lets
 * assertAllowedPair accept an imported address without weakening the
 * PLANK-must-be-one-side rule or any other guard.
 */
export async function resolveCounterToken(address: string): Promise<CounterToken | null> {
  const curated = await getCounterToken(address);
  if (curated) return curated;
  return validateArbitraryCounterToken(address);
}
