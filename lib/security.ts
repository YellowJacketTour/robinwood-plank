import { NextResponse } from "next/server";
import { TradeApiError } from "@/lib/uniswap-server";

/** Simple per-IP sliding window rate limit (in-memory; fine for single-node). */
const buckets = new Map<string, { count: number; resetAt: number }>();

export function getClientIp(req: Request): string {
  const xf = req.headers.get("x-forwarded-for");
  if (xf) return xf.split(",")[0]?.trim() || "unknown";
  return req.headers.get("x-real-ip") || "unknown";
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
  let raw: unknown;
  try {
    raw = await req.json();
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
  const message =
    typeof obj.message === "string" && !looksSecret(obj.message)
      ? obj.message.slice(0, 400)
      : fallback;
  const error =
    typeof obj.error === "string" && !looksSecret(obj.error)
      ? obj.error.slice(0, 80)
      : "UPSTREAM";
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
