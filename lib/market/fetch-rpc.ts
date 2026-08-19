/**
 * Minimal JSON-RPC over fetch — more reliable on Cloudflare Workers than
 * ethers' JsonRpcProvider (which can hang on node:http under nodejs_compat).
 */

import {
  SERVER_RPC_URLS,
  SERVER_DISPLAY_RPC_URLS,
  FREE_RPC_URLS,
  isMeteredRpcUrl,
} from "@/lib/server/rpc-urls";
import { recordRpc } from "@/lib/market/rpc-meter";
import { peekRpcCache, putRpcCache, withRpcCache } from "@/lib/market/rpc-cache";
import { foreignRpcUrls } from "@/lib/market/multichain/trading/foreign-chain-registry";

type RpcResult<T> = { result?: T; error?: { message?: string; code?: number } };

/**
 * Vault reads must stay on the official RH RPC. Blockscout is a fine last
 * resort for casual UI, but it rate-limits Cloudflare egress hard (HTTP 429)
 * and was making Instant Swap's live feed fail after the first successful hit.
 */
function vaultRpcUrls(): string[] {
  return SERVER_RPC_URLS.filter(
    (u) => !u.includes("blockscout.com")
  ).concat(
    // only if official list somehow empty
    SERVER_RPC_URLS.filter((u) => u.includes("blockscout.com"))
  );
}

/**
 * Per-URL circuit breaker so a provider that is currently 429ing (Blockscout's
 * eth-rpc bridge, observed 2026-07-31 returning 429 consistently) doesn't eat a
 * failed round-trip on every single call while it's down. Three failures in a
 * row opens the breaker for a cooldown; a success anywhere resets it
 * immediately. Never filters a list down to nothing — if every candidate is
 * "open", callers still need to try something, so the filter is a no-op in
 * that case rather than a hard failure.
 */
const BREAKER_THRESHOLD = 3;
const BREAKER_COOLDOWN_MS = 30_000;
const breakerState = new Map<string, { failures: number; openUntil: number }>();

function recordUrlFailure(url: string): void {
  const s = breakerState.get(url) ?? { failures: 0, openUntil: 0 };
  s.failures += 1;
  if (s.failures >= BREAKER_THRESHOLD) {
    s.openUntil = Date.now() + BREAKER_COOLDOWN_MS;
  }
  breakerState.set(url, s);
}

function recordUrlSuccess(url: string): void {
  breakerState.set(url, { failures: 0, openUntil: 0 });
}

function isUrlBreakerOpen(url: string): boolean {
  const s = breakerState.get(url);
  return Boolean(s && s.openUntil > Date.now());
}

/** Drop URLs whose breaker is currently open, unless that would leave nothing
 *  to try — an all-open list means every endpoint is currently believed dead,
 *  and attempting anyway (and possibly resetting a breaker on success) beats
 *  refusing to even try. */
function availableUrls(urls: string[]): string[] {
  const open = urls.filter((u) => !isUrlBreakerOpen(u));
  return open.length > 0 ? open : urls;
}

async function postRpc(
  url: string,
  method: string,
  params: unknown[],
  timeoutMs: number
): Promise<RpcResult<unknown>> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  // Counted before the await: a call that times out or 429s is still billed.
  // Only the keyed provider bills — the public Robinhood endpoints are free.
  if (isMeteredRpcUrl(url)) recordRpc(method);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        // Some public RPCs rate-limit anonymous CF egress without a UA.
        "User-Agent": "plank.love-vault/1.0",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: ac.signal,
      cache: "no-store",
    });
    if (res.status === 429) {
      recordUrlFailure(url);
      return { error: { message: `HTTP 429 ${url}`, code: 429 } };
    }
    if (!res.ok) {
      recordUrlFailure(url);
      return { error: { message: `HTTP ${res.status} ${url}`, code: res.status } };
    }
    recordUrlSuccess(url);
    return (await res.json()) as RpcResult<unknown>;
  } catch (error) {
    recordUrlFailure(url);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export async function rpcCall<T = unknown>(
  method: string,
  params: unknown[],
  opts?: { timeoutMs?: number; urls?: string[] }
): Promise<T> {
  // Identical concurrent reads collapse into one upstream request, and
  // repeat reads inside the TTL are free. See lib/market/rpc-cache.ts.
  return withRpcCache(method, params, () => rpcCallUncached<T>(method, params, opts));
}

async function rpcCallUncached<T = unknown>(
  method: string,
  params: unknown[],
  opts?: { timeoutMs?: number; urls?: string[] }
): Promise<T> {
  const timeoutMs = opts?.timeoutMs ?? 8_000;
  const errors: string[] = [];

  // Prefer official RH RPC; Blockscout is last-resort and rate-limits hard.
  // availableUrls skips an endpoint whose breaker is open (repeated recent
  // 429s/failures) rather than burning another round-trip on it.
  for (const url of availableUrls(opts?.urls ?? vaultRpcUrls())) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const data = await postRpc(url, method, params, timeoutMs);
        if (data.error?.code === 429) {
          errors.push(data.error.message || "429");
          // brief backoff then retry same URL once
          await new Promise((r) => setTimeout(r, 300 + attempt * 400));
          continue;
        }
        if (data.error) {
          errors.push(data.error.message || "RPC error");
          break; // try next URL
        }
        return data.result as T;
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
        await new Promise((r) => setTimeout(r, 200));
      }
    }
  }

  throw new Error(`RPC ${method} failed: ${errors.slice(-3).join(" | ")}`);
}

export async function ethCall(to: string, data: string): Promise<string> {
  return rpcCall<string>("eth_call", [{ to, data }, "latest"]);
}

/**
 * eth_call for server-side DISPLAY reads — public endpoint first, keyed
 * provider only as fallback (SERVER_DISPLAY_RPC_URLS). For high-volume reads
 * that feed a dashboard rather than a decision: vault reserves/fee schedule,
 * not order validation or ownership checks (those stay on ethCall/rpcCall,
 * which default to the keyed-first SERVER_RPC_URLS).
 */
export async function ethCallDisplay(to: string, data: string): Promise<string> {
  return rpcCall<string>("eth_call", [{ to, data }, "latest"], { urls: SERVER_DISPLAY_RPC_URLS });
}

/**
 * eth_call over the free endpoints only, still cached and coalesced.
 *
 * For reads that must never cost compute units but should not depend on one
 * hardcoded URL either. Callers that previously posted straight to
 * CHAIN.rpcUrls.default get failover to a second free endpoint and dedupe of
 * repeat reads, at the same price: nothing.
 */
export async function ethCallFree(to: string, data: string): Promise<string> {
  const params = [{ to, data }, "latest"];
  return withRpcCache("eth_call", params, async () => {
    const errors: string[] = [];
    for (const url of availableUrls(FREE_RPC_URLS)) {
      try {
        const data_ = await postRpc(url, "eth_call", params, 8_000);
        if (data_.error) {
          errors.push(data_.error.message || "RPC error");
          continue;
        }
        return data_.result as string;
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }
    throw new Error(`Free eth_call failed: ${errors.slice(-2).join(" | ")}`);
  });
}

/**
 * eth_call over a FOREIGN chain's free/keyed RPC (foreignRpcUrls), still
 * cached and coalesced -- the chain-parameterized sibling of ethCallFree
 * above, for the Marketplank-native foreign-chain listing feature's
 * on-chain ownership check (a native listing must confirm the seller
 * actually owns the token on the chain THEY'RE listing on, not Robinhood
 * Chain). Deliberately a NEW function rather than adding a chainSlug
 * parameter to ethCallFree/ethCall/rpcCall: those also serve Robinhood-chain
 * vault reads that must never accidentally be pointed at the wrong chain by
 * a missed/defaulted parameter -- see this file's own header on why
 * vaultRpcUrls() stays hardcoded to SERVER_RPC_URLS.
 */
export async function ethCallForeignFree(chainSlug: string, to: string, data: string): Promise<string> {
  // The real JSON-RPC wire params (sent to postRpc) MUST stay the clean
  // [{to,data}, "latest"] shape -- injecting chainSlug there would leak into
  // the actual eth_call request body. chainSlug is folded into the CACHE
  // key only (cacheParams), via method: "eth_call" so cacheTtlMs's switch
  // still matches its real "eth_call" case (LATEST_MS) instead of silently
  // falling through to the unknown-method default of 0 (no caching at all)
  // the way a synthetic method name like "eth_call:base-mainnet" would.
  const wireParams = [{ to, data }, "latest"];
  const cacheParams = [{ to, data, chainSlug }, "latest"];
  return withRpcCache("eth_call", cacheParams, async () => {
    const errors: string[] = [];
    for (const url of availableUrls(foreignRpcUrls(chainSlug))) {
      try {
        const data_ = await postRpc(url, "eth_call", wireParams, 8_000);
        if (data_.error) {
          errors.push(data_.error.message || "RPC error");
          continue;
        }
        return data_.result as string;
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }
    throw new Error(`Foreign eth_call (${chainSlug}) failed: ${errors.slice(-2).join(" | ")}`);
  });
}

/** Batch several eth_calls in one HTTP round-trip (less rate-limit pressure). */
export async function ethCallMany(
  calls: Array<{ to: string; data: string }>,
  opts?: { urls?: string[] }
): Promise<string[]> {
  const timeoutMs = 12_000;
  const errors: string[] = [];
  const urls = opts?.urls ?? vaultRpcUrls();

  // Providers bill every entry in a JSON-RPC array separately, so a batch saves
  // round-trips but no compute units. Dropping already-cached entries before
  // building the body is what actually saves money — and on the vault-stats hot
  // path most of these seven repeat unchanged between refreshes.
  const paramsFor = (c: { to: string; data: string }) => [{ to: c.to, data: c.data }, "latest"];
  const results = new Array<string | undefined>(calls.length);
  const missIndexes: number[] = [];
  calls.forEach((c, i) => {
    const cached = peekRpcCache<string>("eth_call", paramsFor(c));
    if (cached !== undefined) results[i] = cached;
    else missIndexes.push(i);
  });
  if (missIndexes.length === 0) return results as string[];

  const fill = (out: string[]): string[] => {
    missIndexes.forEach((originalIndex, k) => {
      results[originalIndex] = out[k];
      putRpcCache("eth_call", paramsFor(calls[originalIndex]), out[k]);
    });
    return results as string[];
  };

  const pending = missIndexes.map((i) => calls[i]);
  const batch = pending.map((c, i) => ({
    jsonrpc: "2.0" as const,
    id: i + 1,
    method: "eth_call",
    params: paramsFor(c),
  }));

  for (const url of availableUrls(urls)) {
    if (url.includes("blockscout.com")) continue; // no batches / rate limits
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    if (isMeteredRpcUrl(url)) recordRpc("eth_call", pending.length);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "User-Agent": "plank.love-vault/1.0",
        },
        body: JSON.stringify(batch),
        signal: ac.signal,
        cache: "no-store",
      });
      if (!res.ok) {
        recordUrlFailure(url);
        errors.push(`HTTP ${res.status} ${url}`);
        continue;
      }
      const data = (await res.json()) as Array<RpcResult<string> & { id?: number }> | RpcResult<string>;
      // Some RPCs reject batches — fall back to sequential for that URL.
      if (!Array.isArray(data)) {
        if ((data as RpcResult<string>).error) {
          recordUrlFailure(url);
          errors.push((data as RpcResult<string>).error?.message || "batch rejected");
          continue;
        }
        errors.push("unexpected batch response shape");
        continue;
      }
      const ordered = [...data].sort((a, b) => (a.id ?? 0) - (b.id ?? 0));
      if (ordered.length !== pending.length || ordered.some((r) => r.error || r.result == null)) {
        errors.push("batch incomplete");
        // Retry the batch once rather than fanning out to N individual calls.
        // The fan-out billed 2N requests to the provider for what is usually a
        // transient partial failure, and on a rate-limited provider it made the
        // rate limiting strictly worse.
        continue;
      }
      recordUrlSuccess(url);
      return fill(ordered.map((r) => r.result as string));
    } catch (error) {
      recordUrlFailure(url);
      errors.push(error instanceof Error ? error.message : String(error));
    } finally {
      clearTimeout(timer);
    }
  }

  // Sequential fallback across the same URL list — only for the entries that
  // missed cache. Goes through rpcCall (not the ethCall/SERVER_RPC_URLS
  // default) so a caller that passed a display-first `urls` list keeps that
  // preference on the fallback path too, and so these populate the cache.
  const out: string[] = [];
  for (const c of pending) {
    out.push(await rpcCall<string>("eth_call", [{ to: c.to, data: c.data }, "latest"], { urls }));
  }
  return fill(out);
}

/**
 * ethCallMany over SERVER_DISPLAY_RPC_URLS (public first, keyed fallback).
 *
 * For the same class of read as ethCallDisplay — vault dashboard reads that
 * are shown to every visitor, not gating a wallet prompt. vault-stats.ts's
 * readCoreVaultState (4 eth_calls, re-read on every SSE tick / stats poll)
 * is the primary caller and the single largest steady-state source of
 * metered eth_call volume before this existed.
 */
export async function ethCallManyDisplay(
  calls: Array<{ to: string; data: string }>
): Promise<string[]> {
  return ethCallMany(calls, { urls: SERVER_DISPLAY_RPC_URLS });
}

export async function ethBlockNumber(opts?: { urls?: string[] }): Promise<number> {
  const hex = await rpcCall<string>("eth_blockNumber", [], { urls: opts?.urls });
  return Number(BigInt(hex));
}

/** ethBlockNumber over SERVER_DISPLAY_RPC_URLS — see ethCallDisplay. */
export async function ethBlockNumberDisplay(): Promise<number> {
  return ethBlockNumber({ urls: SERVER_DISPLAY_RPC_URLS });
}

export async function ethGetLogs(
  filter: {
    address: string;
    topics: (string | string[] | null)[];
    fromBlock: string;
    toBlock: string;
  },
  opts?: { urls?: string[] }
): Promise<
  Array<{
    topics: string[];
    data: string;
    blockNumber: string;
    transactionHash: string;
    logIndex: string;
  }>
> {
  return rpcCall("eth_getLogs", [filter], { timeoutMs: 12_000, urls: opts?.urls });
}

/** ethGetLogs over SERVER_DISPLAY_RPC_URLS — see ethCallDisplay. */
export function ethGetLogsDisplay(filter: {
  address: string;
  topics: (string | string[] | null)[];
  fromBlock: string;
  toBlock: string;
}): ReturnType<typeof ethGetLogs> {
  return ethGetLogs(filter, { urls: SERVER_DISPLAY_RPC_URLS });
}
