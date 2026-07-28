import { NextResponse } from "next/server";
import { TradeApiError } from "@/lib/uniswap-server";

/** Simple per-IP sliding window rate limit (in-memory; fine for single-node). */
const buckets = new Map<string, { count: number; resetAt: number }>();

/** Cap on total live buckets — hard bound on memory even under a rotating-IP
 * flood (audit R-1b: the Map used to grow without any eviction). */
const MAX_BUCKETS = 50_000;

/** Max request body we will read, in bytes (~64 KB). A signed Seaport order is
 * well under 4 KB; anything larger is junk we must not parse or store
 * (audit S-1: a 20 MB body was accepted and persisted). */
export const MAX_BODY_BYTES = 64 * 1024;

/**
 * Best-effort client IP for rate limiting.
 *
 * SECURITY (audit R-1): X-Forwarded-For is fully attacker-controlled, and the
 * LEFTMOST entry is the least trustworthy — a spammer rotates it to defeat the
 * limiter. We trust only values our own platform edge sets:
 *   - `x-vercel-forwarded-for` (Vercel injects the real client IP here), else
 *   - the RIGHTMOST hop of `x-forwarded-for` (the address our infra actually
 *     received the connection from — closest to us, hardest to spoof), else
 *   - `x-real-ip`.
 * Never the leftmost XFF element. Falls back to a single shared "unknown"
 * bucket, which is deliberately strict (one shared limit) rather than open.
 */
export function getClientIp(req: Request): string {
  const vercel = req.headers.get("x-vercel-forwarded-for");
  if (vercel) {
    // Vercel's value is the client IP directly (may carry a port); take the
    // first token but from a header the client cannot set through the edge.
    const ip = vercel.split(",")[0]?.trim();
    if (ip) return ip;
  }
  const xf = req.headers.get("x-forwarded-for");
  if (xf) {
    const parts = xf.split(",").map((s) => s.trim()).filter(Boolean);
    // Rightmost = the hop nearest our infrastructure, not the client's claim.
    const rightmost = parts[parts.length - 1];
    if (rightmost) return rightmost;
  }
  return req.headers.get("x-real-ip") || "unknown";
}

/** Drop expired buckets; if still over the hard cap, evict the soonest-to-reset
 * entries. Runs opportunistically inside rateLimit. */
function evictBuckets(now: number): void {
  for (const [id, b] of buckets) {
    if (now >= b.resetAt) buckets.delete(id);
  }
  if (buckets.size <= MAX_BUCKETS) return;
  const entries = [...buckets.entries()].sort((a, b) => a[1].resetAt - b[1].resetAt);
  const toDrop = buckets.size - MAX_BUCKETS;
  for (let i = 0; i < toDrop; i++) buckets.delete(entries[i][0]);
}

/**
 * @returns null if allowed, or a 429 NextResponse if limited
 */
export function rateLimit(
  req: Request,
  opts: { key: string; limit: number; windowMs: number }
): NextResponse | null {
  const ip = getClientIp(req);
  const id = `${opts.key}:${ip}`;
  const now = Date.now();

  // Bound memory: evict expired/overflow buckets before inserting a new one.
  if (buckets.size >= MAX_BUCKETS) evictBuckets(now);

  const cur = buckets.get(id);

  if (!cur || now >= cur.resetAt) {
    buckets.set(id, { count: 1, resetAt: now + opts.windowMs });
    return null;
  }

  cur.count += 1;
  if (cur.count > opts.limit) {
    return NextResponse.json(
      { error: "RATE_LIMIT", message: "Too many requests. Slow down and try again." },
      {
        status: 429,
        headers: {
          "Retry-After": String(Math.ceil((cur.resetAt - now) / 1000)),
          "Cache-Control": "no-store",
        },
      }
    );
  }
  return null;
}

/** Parse JSON body safely; never trust raw client payloads. */
export async function readJsonBody<T extends Record<string, unknown>>(
  req: Request
): Promise<T> {
  // Reject oversized bodies BEFORE reading/parsing them (audit S-1). Check the
  // declared Content-Length first (cheap), then enforce the same cap on the
  // bytes actually read, since Content-Length can be absent or lie.
  const declared = req.headers.get("content-length");
  if (declared) {
    const n = Number(declared);
    if (Number.isFinite(n) && n > MAX_BODY_BYTES) {
      throw new TradeApiError(413, "BODY_TOO_LARGE", "Request body is too large.");
    }
  }

  let text: string;
  try {
    const buf = await req.arrayBuffer();
    if (buf.byteLength > MAX_BODY_BYTES) {
      throw new TradeApiError(413, "BODY_TOO_LARGE", "Request body is too large.");
    }
    text = new TextDecoder().decode(buf);
  } catch (err) {
    if (err instanceof TradeApiError) throw err;
    throw new TradeApiError(400, "BAD_JSON", "Request body must be valid JSON.");
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new TradeApiError(400, "BAD_JSON", "Request body must be valid JSON.");
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new TradeApiError(400, "BAD_JSON", "Request body must be a JSON object.");
  }
  return raw as T;
}

/**
 * Public API error responses — never echo secrets, stack traces, or upstream
 * headers. Logs stay server-side only.
 */
export function publicError(
  err: unknown,
  fallbackMessage = "Unexpected server error."
): NextResponse {
  if (err instanceof TradeApiError) {
    return NextResponse.json(
      { error: err.code, message: err.message },
      { status: err.status, headers: { "Cache-Control": "no-store" } }
    );
  }
  console.error("[api]", err instanceof Error ? err.message : err);
  return NextResponse.json(
    { error: "INTERNAL", message: fallbackMessage },
    { status: 500, headers: { "Cache-Control": "no-store" } }
  );
}

/** JSON success with no-store (trade quotes must never be cached). */
export function publicJson(data: unknown, status = 200): NextResponse {
  return NextResponse.json(data, {
    status,
    headers: {
      "Cache-Control": "no-store, no-cache, must-revalidate, private",
      Pragma: "no-cache",
    },
  });
}

/**
 * Sanitize Uniswap error bodies before returning to the browser.
 * Drops anything that might accidentally include credentials or internals.
 */
export function sanitizeUpstreamError(data: unknown, fallback: string): {
  error: string;
  message: string;
} {
  if (!data || typeof data !== "object") {
    return { error: "UPSTREAM", message: fallback };
  }
  const obj = data as Record<string, unknown>;
  // Uniswap often returns `detail` / `errorCode` rather than `message` / `error`
  let rawMsg =
    (typeof obj.message === "string" && obj.message) ||
    (typeof obj.detail === "string" && obj.detail) ||
    fallback;

  // Map Uniswap gas / sim noise to actionable copy
  if (/Failed to fetch gas fee|FAILED_TO_ESTIMATE_GAS|simulate transaction/i.test(rawMsg)) {
    if (/TRANSFER_FAILED|insufficient/i.test(rawMsg)) {
      rawMsg =
        "Not enough balance or allowance for this swap. Add ETH for gas (and PLANK if selling), or lower the amount.";
    } else {
      rawMsg =
        "Could not fetch gas fee (busy or rate limited). Wait a few seconds, get a fresh quote, and try again.";
    }
  } else if (/rate.?limit|too many requests|throttl/i.test(rawMsg)) {
    rawMsg = "Routing rate limited — wait a few seconds and retry.";
  }

  const message = !looksSecret(rawMsg) ? String(rawMsg).slice(0, 400) : fallback;
  const rawErr =
    (typeof obj.error === "string" && obj.error) ||
    (typeof obj.errorCode === "string" && obj.errorCode) ||
    "UPSTREAM";
  const error = !looksSecret(rawErr) ? String(rawErr).slice(0, 80) : "UPSTREAM";
  return { error, message };
}

function looksSecret(s: string): boolean {
  const lower = s.toLowerCase();
  if (
    lower.includes("api-key") ||
    lower.includes("apikey") ||
    lower.includes("x-api-key") ||
    lower.includes("authorization") ||
    lower.includes("bearer ")
  ) {
    return true;
  }
  // If our env key is loaded, never echo any substring of it.
  const key = process.env.UNISWAP_API_KEY?.trim();
  if (key && key.length >= 8 && s.includes(key)) return true;
  return false;
}
