import { NextResponse } from "next/server";

/**
 * Shared Cache-Control profiles for public, non-sensitive GET APIs.
 * Edge (s-maxage) + browser (max-age) + stale-while-revalidate so Instant
 * Swap paints from CDN while a background refresh updates the worker.
 *
 * Never use these on wallet-specific, order-signing, or streaming routes.
 */
export const CacheProfile = {
  /** Live vault numbers — short edge TTL, generous SWR. */
  live: "public, max-age=5, s-maxage=15, stale-while-revalidate=60",
  /** Activity / held inventory — a bit stickier. */
  market: "public, max-age=10, s-maxage=20, stale-while-revalidate=120",
  /** Rarity / traits — immutable post-reveal, long edge cache. */
  rarity: "public, max-age=60, s-maxage=300, stale-while-revalidate=3600",
  /** Token metadata snapshot — short browser, medium edge. */
  token: "public, max-age=30, s-maxage=120, stale-while-revalidate=600",
  /** Content-addressed IPFS image/metadata — year immutable. */
  immutable: "public, max-age=31536000, immutable",
  /** Explicitly uncached (SSE, mutations, wallet). */
  none: "no-store, no-cache, must-revalidate, private",
} as const;

export type CacheProfileKey = keyof typeof CacheProfile;

export function cachedPublicJson(
  data: unknown,
  profile: CacheProfileKey = "market",
  init?: { status?: number; headers?: Record<string, string> }
): NextResponse {
  return NextResponse.json(data, {
    status: init?.status ?? 200,
    headers: {
      "Cache-Control": CacheProfile[profile],
      // Allow shared caches (CF) to store even if request has cookies.
      "CDN-Cache-Control": CacheProfile[profile],
      Vary: "Accept-Encoding",
      ...init?.headers,
    },
  });
}

export function cachedBinary(
  body: ArrayBuffer,
  contentType: string,
  profile: CacheProfileKey = "immutable"
): Response {
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": contentType,
      "Cache-Control": CacheProfile[profile],
      "CDN-Cache-Control": CacheProfile[profile],
      Vary: "Accept-Encoding",
    },
  });
}
