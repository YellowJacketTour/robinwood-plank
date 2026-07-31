import type { NextConfig } from "next";
import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";

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
      // static.cloudflareinsights.com: Cloudflare injects its Web Analytics
      // beacon at the edge whenever the feature is on for the zone, which it
      // is. Without this the browser blocks it on every single page load — a
      // console error for every visitor, and analytics that silently never
      // report. Turn the feature off in the Cloudflare dashboard rather than
      // dropping this entry, otherwise the error simply comes back.
      "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://static.cloudflareinsights.com",
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
  // Dev-only: the dev server rejects cross-origin requests by default, which
  // blocks sharing a local preview through a tunnel. Has no effect on
  // production builds — it only widens which origins `next dev` will answer.
  allowedDevOrigins: ["*.trycloudflare.com"],
  // Minimal, traced Node runtime for the InMotion Docker image.
  // OpenNext can still consume the normal build artifacts on its own branch.
  output: "standalone",
  // GitHub Actions supplies the commit SHA. This lets rolling deployments
  // detect clients that still reference assets from the previous image.
  deploymentId: process.env.DEPLOYMENT_VERSION?.trim() || undefined,
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
      // Marketplank is a live application shell. Never let an edge or hosting
      // proxy carry its HTML across an immutable release switch.
      {
        source: "/market",
        headers: [
          {
            key: "Cache-Control",
            value: "no-store, no-cache, must-revalidate, private",
          },
          { key: "Pragma", value: "no-cache" },
        ],
      },
      {
        source: "/",
        headers: [
          {
            key: "Cache-Control",
            value: "public, max-age=0, s-maxage=60, stale-while-revalidate=120",
          },
        ],
      },
      {
        source: "/api/:path*",
        headers: [
          { key: "Cache-Control", value: "no-store, no-cache, must-revalidate, private" },
          { key: "Pragma", value: "no-cache" },
        ],
      },
      // Preserve the vault EventSource stream through nginx/Passenger-style
      // reverse proxies. The proxy still needs buffering disabled in its own
      // vhost; this response header is the application-side half.
      {
        source: "/api/market/vault/stream",
        headers: [{ key: "X-Accel-Buffering", value: "no" }],
      },
      // Later entries win over an earlier match on the same path/header —
      // carve public read-only routes out of the blanket no-store above.
      // Exact paths only — never /api/market/vault/stream (SSE).
      {
        source: "/api/market/vault/stats",
        headers: [
          {
            key: "Cache-Control",
            value: "public, max-age=5, s-maxage=15, stale-while-revalidate=60",
          },
        ],
      },
      {
        source: "/api/market/vault/held",
        headers: [
          {
            key: "Cache-Control",
            value: "public, max-age=10, s-maxage=20, stale-while-revalidate=120",
          },
        ],
      },
      {
        source: "/api/market/vault/activity",
        headers: [
          {
            key: "Cache-Control",
            value: "public, max-age=10, s-maxage=20, stale-while-revalidate=120",
          },
        ],
      },
      {
        source: "/api/market/activity",
        headers: [
          {
            key: "Cache-Control",
            value: "public, max-age=10, s-maxage=20, stale-while-revalidate=120",
          },
        ],
      },
      {
        source: "/api/market/rarity",
        headers: [
          {
            key: "Cache-Control",
            value: "public, max-age=60, s-maxage=300, stale-while-revalidate=3600",
          },
        ],
      },
      {
        source: "/api/market/token",
        headers: [
          {
            key: "Cache-Control",
            value: "public, max-age=30, s-maxage=120, stale-while-revalidate=600",
          },
        ],
      },
      {
        source: "/api/market/traits",
        headers: [
          {
            key: "Cache-Control",
            value: "public, max-age=60, s-maxage=300, stale-while-revalidate=3600",
          },
        ],
      },
      {
        source: "/api/market/treasury",
        headers: [
          {
            key: "Cache-Control",
            value: "public, max-age=10, s-maxage=30, stale-while-revalidate=120",
          },
        ],
      },
      {
        source: "/api/ipfs/image",
        headers: [{ key: "Cache-Control", value: "public, max-age=31536000, immutable" }],
      },
      {
        source: "/api/ipfs/metadata",
        headers: [
          {
            key: "Cache-Control",
            value: "public, max-age=86400, s-maxage=86400, stale-while-revalidate=604800",
          },
        ],
      },
      {
        source: "/images/:path*",
        headers: [{ key: "Cache-Control", value: "public, max-age=86400, stale-while-revalidate=604800" }],
      },
      // 4.7 MB self-hosted WalletConnect runtime, lazy-loaded on first wallet
      // connect. Unhashed checked-in artifact, so a day + SWR week — never
      // immutable, it can change on deploy.
      {
        source: "/wallet-connect-bundle.js",
        headers: [
          { key: "Cache-Control", value: "public, max-age=86400, stale-while-revalidate=604800" },
        ],
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

// Enable Cloudflare bindings during `next dev`.
initOpenNextCloudflareForDev();
