import { SERVER_RPC_URLS } from "@/lib/server/rpc-urls";
import { recordRpc } from "@/lib/market/rpc-meter";
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
  // they land on the same bill and belong in the same meter. Batches are
  // billed per entry.
  try {
    const parsed = JSON.parse(raw) as
      | { method?: string }
      | Array<{ method?: string }>;
    for (const entry of Array.isArray(parsed) ? parsed : [parsed]) {
      if (entry?.method) recordRpc(entry.method);
    }
  } catch {
    /* malformed bodies are rejected by the upstream anyway */
  }

  let lastError: unknown = null;
  for (const url of SERVER_RPC_URLS) {
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
