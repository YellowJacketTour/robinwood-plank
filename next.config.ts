import type { NextConfig } from "next";

/**
 * Security headers + ensure server secrets are never treated as public.
 * UNISWAP_API_KEY must never use the NEXT_PUBLIC_ prefix.
 */
const securityHeaders = [
  { key: "X-DNS-Prefetch-Control", value: "on" },
  { key: "X-Frame-Options", value: "SAMEORIGIN" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), interest-cohort=()",
  },
  {
    key: "Content-Security-Policy",
    value: [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob: https:",
      "font-src 'self' data:",
      "connect-src 'self' https://rpc.mainnet.chain.robinhood.com https://*.alchemy.com https://*.infura.io wss: https:",
      "frame-ancestors 'self'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join("; "),
  },
];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  async rewrites() {
    return [
      { source: "/opengraph-image", destination: "/plank-social.jpg" },
      { source: "/opengraph-image.png", destination: "/plank-social.jpg" },
    ];
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: securityHeaders,
      },
      {
        source: "/api/:path*",
        headers: [
          { key: "Cache-Control", value: "no-store, no-cache, must-revalidate, private" },
          { key: "Pragma", value: "no-cache" },
        ],
      },
      // Later entries win over an earlier match on the same path/header —
      // this carves a handful of public, non-sensitive, read-only
      // market-data routes out of the blanket no-store rule above. Every
      // one of these routes already sets its own short Cache-Control
      // header in code; the blanket rule was silently clobbering it, which
      // was the actual cause of "images and stats load slowly on every
      // refresh" — no route-level fix could work while this stayed in
      // front of it. Do NOT add wallet-specific, order-signing, or
      // transaction-submitting routes here.
      // Exact paths only — NOT a /:path* wildcard, which would also catch
      // /api/market/vault/stream (the SSE route) and break its live push
      // by letting it get cached.
      {
        source: "/api/market/vault/stats",
        headers: [{ key: "Cache-Control", value: "public, s-maxage=15, stale-while-revalidate=60" }],
      },
      {
        source: "/api/market/vault/held",
        headers: [{ key: "Cache-Control", value: "public, s-maxage=15, stale-while-revalidate=60" }],
      },
      {
        source: "/api/market/vault/activity",
        headers: [{ key: "Cache-Control", value: "public, s-maxage=15, stale-while-revalidate=60" }],
      },
      {
        source: "/api/market/activity",
        headers: [{ key: "Cache-Control", value: "public, s-maxage=15, stale-while-revalidate=60" }],
      },
      {
        source: "/api/market/rarity",
        headers: [{ key: "Cache-Control", value: "public, s-maxage=60, stale-while-revalidate=300" }],
      },
      {
        source: "/plank-social.jpg",
        headers: [
          {
            key: "Cache-Control",
            value: "public, max-age=31536000, immutable",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
