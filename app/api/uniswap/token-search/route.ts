import { CONTRACT_ADDRESS, NATIVE_TOKEN_ADDRESS } from "@/lib/constants";
import { publicError, publicJson, rateLimit } from "@/lib/security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Chain-native token DISCOVERY — search + icons only, backed by the chain's
 * own public block explorer (no auth, no gateway credential). Uniswap's own
 * token search/logo backend (gateway.uniswap.org, entry-gateway...) was
 * confirmed closed — a direct test of its swappable_tokens endpoint returned
 * 401 "Unauthenticated api key or session" — so this is the only public
 * source for browsing beyond the curated ~100-token list.
 *
 * HARD RULE: this route's decimals/symbol/name are DISPLAY ONLY. Every
 * result here is "unverified" until the client re-resolves it through
 * /api/uniswap/import-token (or a curated match), which reads
 * symbol()/name()/decimals() straight off the contract via our own RPC.
 * Wrong decimals from an off-chain indexer would mean wrong swap amounts —
 * Blockscout is never trusted for that.
 */
const BLOCKSCOUT_TOKENS_URL = "https://robinhoodchain.blockscout.com/api/v2/tokens";
const CACHE_TTL_MS = 60_000;
const MAX_CACHE_ENTRIES = 500;

type BlockscoutToken = {
  address_hash?: string;
  symbol?: string;
  name?: string;
  decimals?: string;
  holders_count?: string;
  icon_url?: string | null;
  exchange_rate?: string | null;
  circulating_market_cap?: string | null;
  type?: string;
};

export type TokenSearchResult = {
  address: string;
  symbol: string;
  name: string;
  /** Informational only — never used for a quote without on-chain re-check. */
  decimals: number;
  logoURI?: string;
  holdersCount: number;
  /** True when Blockscout/CoinGecko actually track a price for this token —
   * the one signal that reliably separates real contracts from impostors
   * (verified: every sampled impostor had this null; holders_count alone
   * misranks, e.g. a "HOODRAT CHAIN" copycat outnumbers the real Hoodrat). */
  priceTracked: boolean;
  /**
   * The issuer itself lists this contract on this chain — see
   * lib/market/robinhood-assets.ts. This is authority, not a heuristic, and it
   * outranks every other signal.
   */
  official?: boolean;
  /**
   * Another result in the same search shares this symbol. Set on ALL of them,
   * including the top hit, because the danger is precisely that the first row
   * looks authoritative when nothing distinguishes it — 50 tokens called USDC,
   * none price-tracked, separated by ten holders. Suppressed when the token is
   * official: an issuer-confirmed contract is not made doubtful by impostors
   * crowding around it.
   */
  ambiguousSymbol?: boolean;
};

const cache = new Map<string, { at: number; results: TokenSearchResult[] }>();

/**
 * Flag every result whose symbol collides with another in the same set, so the
 * UI can say "several tokens use this symbol" instead of implying the first one
 * is the answer. Official tokens are exempt — the issuer has already settled it.
 */
function markAmbiguousSymbols(results: TokenSearchResult[]): TokenSearchResult[] {
  const counts = new Map<string, number>();
  for (const r of results) {
    const key = r.symbol.toLowerCase();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  for (const r of results) {
    if (!r.official && (counts.get(r.symbol.toLowerCase()) ?? 0) > 1) {
      r.ambiguousSymbol = true;
    }
  }
  return results;
}

function rank(
  items: BlockscoutToken[],
  official: Map<string, { symbol: string; name: string; logoUrl?: string }>
): TokenSearchResult[] {
  const mapped = items
    .filter(
      (t): t is BlockscoutToken & { address_hash: string } =>
        typeof t.address_hash === "string" && /^0x[a-fA-F0-9]{40}$/.test(t.address_hash)
    )
    .map((t) => {
      const decimals = Number(t.decimals);
      const holdersCount = Number(t.holders_count);
      const match = official.get(t.address_hash.toLowerCase());
      return {
        address: t.address_hash,
        ...(match ? { official: true } : {}),
        // Prefer the issuer's own symbol and name over whatever the contract
        // self-reports, which an impostor controls.
        symbol: (match?.symbol || t.symbol || "").trim(),
        name: (match?.name || t.name || t.symbol || "").trim(),
        decimals: Number.isFinite(decimals) ? decimals : 18,
        logoURI:
          typeof t.icon_url === "string" && /^https:\/\//.test(t.icon_url) ? t.icon_url : undefined,
        holdersCount: Number.isFinite(holdersCount) ? holdersCount : 0,
        priceTracked: Boolean(t.exchange_rate) || Boolean(t.circulating_market_cap),
      };
    })
    .filter((t) => t.symbol); // no usable symbol — useless in a picker, drop it

  // Strongest signal first (verified against real impostor samples):
  // 1) actually price-tracked, 2) holder count, 3) has a real icon.
  // `reputation` is deliberately NOT used — it read "ok" for every sampled
  // token, real and fake alike, so it carries zero ranking signal here.
  mapped.sort((a, b) => {
    // Issuer confirmation first. The signals below are inferences about which
    // contract is real; this one is the issuer stating it.
    if (Boolean(a.official) !== Boolean(b.official)) return a.official ? -1 : 1;
    if (a.priceTracked !== b.priceTracked) return a.priceTracked ? -1 : 1;
    if (b.holdersCount !== a.holdersCount) return b.holdersCount - a.holdersCount;
    return (b.logoURI ? 1 : 0) - (a.logoURI ? 1 : 0);
  });

  return mapped;
}

export async function GET(req: Request) {
  try {
    const limited = rateLimit(req, { key: "token-search", limit: 60, windowMs: 60_000 });
    if (limited) return limited;

    const url = new URL(req.url);
    const q = (url.searchParams.get("q") || "").trim();
    if (!q) {
      return publicJson({ results: [] });
    }
    if (q.length > 64) {
      return publicJson({ error: "BAD_QUERY", message: "Search query too long." }, 400);
    }

    const cacheKey = q.toLowerCase();
    const hit = cache.get(cacheKey);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
      return publicJson({ results: hit.results });
    }

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 6_000);
    let results: TokenSearchResult[] = [];
    let degraded = false;
    try {
      const res = await fetch(`${BLOCKSCOUT_TOKENS_URL}?q=${encodeURIComponent(q)}&type=ERC-20`, {
        signal: ac.signal,
        cache: "no-store",
        headers: { Accept: "application/json" },
      });
      if (res.ok) {
        const data = (await res.json().catch(() => null)) as { items?: BlockscoutToken[] } | null;
        const plank = CONTRACT_ADDRESS.toLowerCase();
        const native = NATIVE_TOKEN_ADDRESS.toLowerCase();
        const { readOfficialAssets, officialAssetMap } = await import(
          "@/lib/market/robinhood-assets"
        );
        const official = officialAssetMap(await readOfficialAssets().catch(() => []));
        results = markAmbiguousSymbols(
          rank(data?.items ?? [], official).filter(
            (t) => t.address.toLowerCase() !== plank && t.address.toLowerCase() !== native
          )
        );
      } else {
        degraded = true;
      }
    } catch {
      degraded = true;
    } finally {
      clearTimeout(timer);
    }

    // Undocumented/unknown rate limits on Blockscout's side — degrade to a
    // stale cache entry rather than a hard failure; the curated list in the
    // modal keeps working regardless.
    if (degraded) {
      return publicJson({ results: hit?.results ?? [] });
    }

    cache.set(cacheKey, { at: Date.now(), results });
    if (cache.size > MAX_CACHE_ENTRIES) {
      const oldestKey = [...cache.entries()].sort((a, b) => a[1].at - b[1].at)[0]?.[0];
      if (oldestKey) cache.delete(oldestKey);
    }

    return publicJson({ results });
  } catch (error) {
    return publicError(error, "Token search failed.");
  }
}

export function POST() {
  return publicJson({ error: "METHOD", message: "Use GET." }, 405);
}
