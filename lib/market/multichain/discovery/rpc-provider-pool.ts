/**
 * Multi-VENDOR, chain-agnostic raw JSON-RPC pool for EVM chains.
 *
 * REAL PROBLEM THIS FIXES, flagged live 2026-08-24 ("produce a unified
 * system that is not crippled by alchemy monthly limit"): every EVM read
 * this app makes -- discovery log-scans, per-collection metadata, per-token
 * tokenURI() reads -- ultimately depended on ONE paid vendor (Alchemy) for
 * the raw RPC call underneath. Confirmed live the same night: Alchemy's
 * real monthly compute-unit quota exhausted, and every one of those call
 * sites failed simultaneously across all 8 EVM chains at once, with no
 * fallback -- a single vendor's billing cycle became this app's own outage.
 *
 * The real, elegant fix (researched and confirmed live, not guessed):
 * every chain this app tracks already has multiple genuinely free, keyless,
 * production-grade public RPC endpoints -- publicnode.com and drpc.org each
 * independently operate full nodes for all 8 real-verified 2026-08-24 via
 * a direct eth_blockNumber call against every endpoint below, each
 * returning a real, live, current block number with zero API key. Alchemy
 * stays IN the pool (it's real, it's fast, it has real archive/trace
 * features the free public nodes may not) -- it just stops being the ONLY
 * member. When Alchemy's quota trips, this pool routes around it instead
 * of the whole app going dark on that chain.
 *
 * Same reserve/settle/jail circuit-breaker discipline as every other real
 * source in this app (opensea-key-pool.ts, helius-key-pool.ts, ...) --
 * per-PROVIDER jail, so one vendor's outage/quota never blocks the others.
 */
import { checkSourceBudget, recordSourceSuccess, recordSourceFailure } from "@/lib/market/multichain/discovery/source-budget";
import { apiKey as alchemyApiKey, ALCHEMY_NETWORK_SUBDOMAIN } from "@/lib/market/multichain/adapters/alchemy-network";

export type RpcProviderId = "publicnode" | "drpc" | "alchemy";

type ProviderEntry = { id: RpcProviderId; url: string; source: string };

/**
 * Real, direct-verified 2026-08-24 (curl eth_blockNumber against every
 * URL below, every one returned a real current block number, zero auth).
 * publicnode.com does not serve zkSync -- Matter Labs' own official
 * public endpoint fills that one slot instead, same "real and free"
 * standard, just a different real operator.
 */
const FREE_PUBLIC_RPC: Record<string, Array<{ id: RpcProviderId; url: string }>> = {
  "eth-mainnet": [
    { id: "publicnode", url: "https://ethereum-rpc.publicnode.com" },
    { id: "drpc", url: "https://eth.drpc.org" },
  ],
  "polygon-mainnet": [
    { id: "publicnode", url: "https://polygon-bor-rpc.publicnode.com" },
    { id: "drpc", url: "https://polygon.drpc.org" },
  ],
  "arb-mainnet": [
    { id: "publicnode", url: "https://arbitrum-one-rpc.publicnode.com" },
    { id: "drpc", url: "https://arbitrum.drpc.org" },
  ],
  "base-mainnet": [
    { id: "publicnode", url: "https://base-rpc.publicnode.com" },
    { id: "drpc", url: "https://base.drpc.org" },
  ],
  "opt-mainnet": [
    { id: "publicnode", url: "https://optimism-rpc.publicnode.com" },
    { id: "drpc", url: "https://optimism.drpc.org" },
  ],
  "bnb-mainnet": [
    { id: "publicnode", url: "https://bsc-rpc.publicnode.com" },
    { id: "drpc", url: "https://bsc.drpc.org" },
  ],
  "avax-mainnet": [
    { id: "publicnode", url: "https://avalanche-c-chain-rpc.publicnode.com" },
    { id: "drpc", url: "https://avalanche.drpc.org" },
  ],
  // publicnode has no zkSync era endpoint -- Matter Labs' own official
  // public RPC (the chain team's own free node) fills this slot.
  "zksync-mainnet": [{ id: "drpc", url: "https://mainnet.era.zksync.io" }],
  // Robinhood Chain -- real bug found live 2026-08-26: this used to list
  // only ONE provider (the chain's own official public RPC), with no real
  // redundancy at all. Confirmed live, repeatedly: that single endpoint's
  // real rate limit tripped this pool's own circuit breaker into a real
  // 15-minute jail multiple times in one night, each time taking down
  // EVERY real caller sharing this one chain slug (the live KOTH watcher,
  // its finality-margin math, backfill/diagnostic scripts) simultaneously
  // -- exactly the single-point-of-failure this whole multi-provider pool
  // exists to avoid for every OTHER chain. https://robinhood.drpc.org
  // independently verified live (real eth_chainId call returns 0x1237,
  // the real correct chain id) as a genuinely separate dRPC-operated
  // endpoint, distinct from the chain's own official node -- a real
  // second provider, not a relabeled duplicate of the first. Each keeps
  // its own distinct provider id so a jail on one can never jail the
  // other (see providerSource's own per-id key).
  "robinhood": [
    { id: "publicnode", url: "https://rpc.mainnet.chain.robinhood.com" },
    { id: "drpc", url: "https://robinhood.drpc.org" },
  ],
};

function alchemyRpcUrl(chainSlug: string): string | null {
  const subdomain = ALCHEMY_NETWORK_SUBDOMAIN[chainSlug];
  if (!subdomain) return null;
  const key = alchemyApiKey();
  return `https://${subdomain}.g.alchemy.com/v2/${key}`;
}

/** Real per-provider source-budget key -- each vendor jails independently. */
function providerSource(chainSlug: string, id: RpcProviderId): string {
  return `rpc-pool:${chainSlug}:${id}`;
}

function loadProviders(chainSlug: string): ProviderEntry[] {
  const free = (FREE_PUBLIC_RPC[chainSlug] ?? []).map((p) => ({ ...p, source: providerSource(chainSlug, p.id) }));
  const alchemyUrl = alchemyRpcUrl(chainSlug);
  const withAlchemy: ProviderEntry[] = alchemyUrl
    ? [...free, { id: "alchemy" as const, url: alchemyUrl, source: providerSource(chainSlug, "alchemy") }]
    : free;
  return withAlchemy;
}

export type RpcCallResult<T> = { result: T; provider: RpcProviderId };

/**
 * Real JSON-RPC call, tried across every unjailed provider for this chain
 * in order (free public providers first, Alchemy last -- Alchemy is the
 * one with a real hard monthly ceiling, so it's the fallback, not the
 * default, for high-volume reads). Throws only if every provider for this
 * chain is jailed or every attempt failed -- matches every other real
 * source's "no silent success" discipline in this app.
 */
export async function rpcCall<T = unknown>(
  chainSlug: string,
  method: string,
  params: unknown[]
): Promise<RpcCallResult<T>> {
  const providers = loadProviders(chainSlug);
  if (providers.length === 0) {
    throw new Error(`rpc-provider-pool: no RPC provider configured for chain "${chainSlug}"`);
  }
  // Alchemy sorts last: it's the only provider here with a real, hard,
  // shared-across-this-whole-app monthly quota -- every free public
  // provider is genuinely unlimited by comparison, so real read volume
  // should exhaust those first, saving Alchemy's real quota for whatever
  // still specifically needs it (archive/trace methods the free nodes
  // may not serve).
  const ordered = [...providers].sort((a, b) => (a.id === "alchemy" ? 1 : 0) - (b.id === "alchemy" ? 1 : 0));

  // Real bug found live 2026-08-25 ("hunt for lessons-learned
  // recurrences"): this pool's own per-chain Alchemy jail (provider.source
  // = `rpc-pool:<chain>:alchemy`, one per EVM chain) was siloed from
  // alchemy-nft.ts's separate real Alchemy usage, even though both hit
  // the exact same real account/API key. A real detected quota failure on
  // one was invisible to the other. Checked once here (not once per
  // provider iteration) since it only ever matters for the "alchemy"
  // entry in `ordered`.
  const { isAlchemyAccountJailed, jailAlchemyAccountUntilMonthReset } = await import("@/lib/market/multichain/discovery/alchemy-account-jail");
  const alchemyAccountJailed = await isAlchemyAccountJailed();

  let lastError: unknown = null;
  for (const provider of ordered) {
    if (provider.id === "alchemy" && alchemyAccountJailed) continue;
    if (!checkSourceBudget(provider.source).allowed) continue;
    try {
      const res = await fetch(provider.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) {
        recordSourceFailure(provider.source, res.status === 429);
        if (provider.id === "alchemy" && res.status === 429) await jailAlchemyAccountUntilMonthReset().catch(() => {});
        lastError = new Error(`rpc-provider-pool: ${provider.id} HTTP ${res.status} for ${method} on ${chainSlug}`);
        continue;
      }
      const body = (await res.json()) as { result?: T; error?: { code: number; message: string } };
      if (body.error) {
        // A real JSON-RPC error (e.g. "method not supported", a real revert)
        // is not a provider-health signal -- do not jail the provider for
        // it, the SAME call would fail identically on every other provider
        // too. Only transport/HTTP failures indicate a provider problem.
        throw new Error(`rpc-provider-pool: ${provider.id} ${method} on ${chainSlug} -- ${body.error.code} ${body.error.message}`);
      }
      recordSourceSuccess(provider.source);
      return { result: body.result as T, provider: provider.id };
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("rpc-provider-pool:") && !error.message.includes("HTTP")) {
        throw error; // real JSON-RPC application error -- do not retry across providers, it will recur identically
      }
      recordSourceFailure(provider.source, false);
      lastError = error;
    }
  }
  throw lastError ?? new Error(`rpc-provider-pool: every provider for "${chainSlug}" is jailed or unconfigured`);
}

export type RpcPoolHealth = Array<{
  chainSlug: string;
  provider: RpcProviderId;
  jailed: boolean;
}>;

/** Real-time health snapshot across every configured chain/provider pair -- for an admin view, never for gating logic itself. */
export function getRpcPoolHealth(): RpcPoolHealth {
  const out: RpcPoolHealth = [];
  for (const chainSlug of Object.keys(FREE_PUBLIC_RPC)) {
    for (const provider of loadProviders(chainSlug)) {
      out.push({ chainSlug, provider: provider.id, jailed: !checkSourceBudget(provider.source).allowed });
    }
  }
  return out;
}
