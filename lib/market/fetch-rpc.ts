/**
 * Minimal JSON-RPC over fetch — more reliable on Cloudflare Workers than
 * ethers' JsonRpcProvider (which can hang on node:http under nodejs_compat).
 */

import { SERVER_RPC_URLS } from "@/lib/server/rpc-urls";
import { recordRpc } from "@/lib/market/rpc-meter";
import { peekRpcCache, putRpcCache, withRpcCache } from "@/lib/market/rpc-cache";

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

async function postRpc(
  url: string,
  method: string,
  params: unknown[],
  timeoutMs: number
): Promise<RpcResult<unknown>> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  // Metered before the await: a call that times out or 429s is still billed.
  recordRpc(method);
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
      return { error: { message: `HTTP 429 ${url}`, code: 429 } };
    }
    if (!res.ok) {
      return { error: { message: `HTTP ${res.status} ${url}`, code: res.status } };
    }
    return (await res.json()) as RpcResult<unknown>;
  } finally {
    clearTimeout(timer);
  }
}

export async function rpcCall<T = unknown>(
  method: string,
  params: unknown[],
  opts?: { timeoutMs?: number }
): Promise<T> {
  // Identical concurrent reads collapse into one upstream request, and
  // repeat reads inside the TTL are free. See lib/market/rpc-cache.ts.
  return withRpcCache(method, params, () => rpcCallUncached<T>(method, params, opts));
}

async function rpcCallUncached<T = unknown>(
  method: string,
  params: unknown[],
  opts?: { timeoutMs?: number }
): Promise<T> {
  const timeoutMs = opts?.timeoutMs ?? 8_000;
  const errors: string[] = [];

  // Prefer official RH RPC; Blockscout is last-resort and rate-limits hard.
  for (const url of vaultRpcUrls()) {
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

/** Batch several eth_calls in one HTTP round-trip (less rate-limit pressure). */
export async function ethCallMany(
  calls: Array<{ to: string; data: string }>
): Promise<string[]> {
  const timeoutMs = 12_000;
  const errors: string[] = [];

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

  for (const url of vaultRpcUrls()) {
    if (url.includes("blockscout.com")) continue; // no batches / rate limits
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    recordRpc("eth_call", pending.length);
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
        errors.push(`HTTP ${res.status} ${url}`);
        continue;
      }
      const data = (await res.json()) as Array<RpcResult<string> & { id?: number }> | RpcResult<string>;
      // Some RPCs reject batches — fall back to sequential for that URL.
      if (!Array.isArray(data)) {
        if ((data as RpcResult<string>).error) {
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
      return fill(ordered.map((r) => r.result as string));
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    } finally {
      clearTimeout(timer);
    }
  }

  // Sequential fallback across the URL list — only for the entries that missed
  // cache. ethCall routes through rpcCall, so these populate the cache too.
  const out: string[] = [];
  for (const c of pending) {
    out.push(await ethCall(c.to, c.data));
  }
  return fill(out);
}

export async function ethBlockNumber(): Promise<number> {
  const hex = await rpcCall<string>("eth_blockNumber", []);
  return Number(BigInt(hex));
}

export async function ethGetLogs(filter: {
  address: string;
  topics: (string | string[] | null)[];
  fromBlock: string;
  toBlock: string;
}): Promise<
  Array<{
    topics: string[];
    data: string;
    blockNumber: string;
    transactionHash: string;
    logIndex: string;
  }>
> {
  return rpcCall("eth_getLogs", [filter], { timeoutMs: 12_000 });
}
