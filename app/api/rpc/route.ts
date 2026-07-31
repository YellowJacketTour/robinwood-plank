import { CLIENT_PROXY_RPC_URLS, isMeteredRpcUrl } from "@/lib/server/rpc-urls";
import { recordRpc } from "@/lib/market/rpc-meter";
import { peekRpcCache, putRpcCache } from "@/lib/market/rpc-cache";
import { publicError, publicJson, rateLimit } from "@/lib/security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Same-origin JSON-RPC proxy for Robinhood Chain reads.
 *
 * The public RPC (rpc.mainnet.chain.robinhood.com) sends a malformed
 * duplicate `Access-Control-Allow-Origin: *,*` header — confirmed via real
 * browser network inspection, not assumed. Browsers reject a response with
 * more than one value there, so every direct client-side `eth_call` fails
 * with a CORS error even though the RPC itself answered fine. This is the
 * exact same class of problem the IPFS gateways had (a header issue outside
 * our control), fixed the same way: do the request server-side, where
 * fetch() doesn't enforce or even look at CORS headers, and hand the client
 * back a plain same-origin response.
 */
const MAX_BODY_BYTES = 64 * 1024;

type UpstreamRpc = { jsonrpc?: string; id?: unknown; result?: unknown; error?: unknown };

/**
 * POST a JSON-RPC body to the first provider that answers with parseable JSON.
 * A well-formed JSON-RPC error is a successful proxy; only transport failures
 * or non-JSON bodies fall through to the next provider.
 */
async function proxyToRpc(
  body: string
): Promise<
  | { ok: true; parsed: UpstreamRpc | UpstreamRpc[]; metered: boolean }
  | { ok: false; response: Response }
> {
  let lastError: unknown = null;
  for (const url of CLIENT_PROXY_RPC_URLS) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        signal: AbortSignal.timeout(10_000),
        cache: "no-store",
      });
      const text = await res.text();
      try {
        return {
          ok: true,
          parsed: JSON.parse(text) as UpstreamRpc | UpstreamRpc[],
          metered: isMeteredRpcUrl(url),
        };
      } catch {
        lastError = new Error(`Non-JSON response from ${url}`);
        continue;
      }
    } catch (error) {
      lastError = error;
    }
  }
  return {
    ok: false,
    response: publicError(lastError, "Could not reach Robinhood Chain right now."),
  };
}

export async function POST(req: Request) {
  // Gallery/inventory views can fire hundreds of eth_call reads walking the
  // collection — sized like the IPFS proxies, not a single-wallet budget.
  const limited = rateLimit(req, { key: "rpc-proxy", limit: 3000, windowMs: 60_000 });
  if (limited) return limited;

  const raw = await req.text();
  if (!raw || raw.length > MAX_BODY_BYTES) {
    return publicJson({ error: "BAD_BODY", message: "Invalid JSON-RPC body." }, 400);
  }

  // Client reads proxy through here to the same provider the server uses, so
  // they land on the same bill. This is the single choke point for every
  // browser-side read in the app: caching here means a page that polls hard, or
  // twenty tabs polling at once, cost one upstream call per distinct read per
  // TTL instead of one per poll. Writes and nonce reads are never cached — see
  // NEVER_CACHE in lib/market/rpc-cache.ts.
  type RpcEntry = { jsonrpc?: string; id?: unknown; method?: string; params?: unknown[] };
  let entries: RpcEntry[] | null = null;
  let isBatch = false;
  try {
    const parsed = JSON.parse(raw) as RpcEntry | RpcEntry[];
    isBatch = Array.isArray(parsed);
    entries = isBatch ? (parsed as RpcEntry[]) : [parsed as RpcEntry];
  } catch {
    entries = null; // malformed; let upstream reject it
  }

  if (entries && entries.every((e) => typeof e?.method === "string")) {
    const cached = entries.map((e) => peekRpcCache<unknown>(e.method!, e.params ?? []));
    const missIdx = cached.map((v, i) => (v === undefined ? i : -1)).filter((i) => i >= 0);

    if (missIdx.length === 0) {
      const body = entries.map((e, i) => ({ jsonrpc: "2.0", id: e.id ?? null, result: cached[i] }));
      return new Response(JSON.stringify(isBatch ? body : body[0]), {
        status: 200,
        headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      });
    }

    // Only the misses go upstream. Ids are rewritten so the response maps back
    // to the caller's original ids regardless of what the provider echoes.
    const missEntries = missIdx.map((i, k) => ({ ...entries![i], jsonrpc: "2.0", id: k + 1 }));
    const upstream = await proxyToRpc(JSON.stringify(isBatch ? missEntries : missEntries[0]));
    if (!upstream.ok) return upstream.response;

    // Only the keyed provider costs anything; a public-RPC answer is free.
    if (upstream.metered) for (const e of missEntries) recordRpc(e.method!);

    const raws = Array.isArray(upstream.parsed) ? upstream.parsed : [upstream.parsed];
    const byId = new Map(raws.map((r) => [Number(r?.id ?? 0), r]));
    const merged = entries.map((e, i) => {
      if (cached[i] !== undefined) return { jsonrpc: "2.0", id: e.id ?? null, result: cached[i] };
      const k = missIdx.indexOf(i) + 1;
      const r = byId.get(k) ?? raws[missIdx.indexOf(i)];
      if (r && r.error == null && r.result != null) {
        putRpcCache(e.method!, e.params ?? [], r.result);
      }
      return { ...r, id: e.id ?? null };
    });

    return new Response(JSON.stringify(isBatch ? merged : merged[0]), {
      status: 200,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  }

  let lastError: unknown = null;
  for (const url of CLIENT_PROXY_RPC_URLS) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: raw,
        signal: AbortSignal.timeout(10_000),
        cache: "no-store",
      });
      // A well-formed JSON-RPC error response is still a successful proxy —
      // only a transport failure or non-JSON body should fall through to
      // the next RPC.
      const text = await res.text();
      try {
        JSON.parse(text);
      } catch {
        lastError = new Error(`Non-JSON response from ${url}`);
        continue;
      }
      return new Response(text, {
        status: 200,
        headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      });
    } catch (error) {
      lastError = error;
    }
  }

  return publicError(lastError, "Could not reach Robinhood Chain right now.");
}
