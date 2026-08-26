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
      // WoodAmp community tracks: without an explicit media-src, audio
      // falls back to default-src 'self' and any community-hosted track
      // URL is silently blocked. Hosted files stay same-origin; https:
      // covers admin-approved remote tracks (Phase 2).
      "media-src 'self' https:",
      // WoodAmp embed tracks play through the providers' official iframe
      // players (postMessage-controlled, no provider SDK script — so
      // script-src stays untouched). Without frame-src, iframes fall back to
      // default-src 'self' and the embeds are silently blocked.
      "frame-src 'self' https://www.youtube-nocookie.com https://www.youtube.com https://w.soundcloud.com https://dexscreener.com https://www.dextools.io https://dextools.io",
      "connect-src 'self' https://rpc.mainnet.chain.robinhood.com https://*.alchemy.com https://*.infura.io wss: https:",
      "frame-ancestors 'self'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join("; "),
  },
];

const nextConfig: NextConfig = {
  // Arbitrary NFT CDNs (OpenSea seadn, Magic Eden, Ordinals, IPFS gateways).
  // ListingCard also marks remote art unoptimized; this keep next/image from
  // crashing the whole collection page when a fallback uses collection.image.
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "**.seadn.io" },
      { protocol: "https", hostname: "i.seadn.io" },
      { protocol: "https", hostname: "i2c.seadn.io" },
      { protocol: "https", hostname: "openseauserdata.com" },
      { protocol: "https", hostname: "**.openseauserdata.com" },
      { protocol: "https", hostname: "img.seadn.io" },
      { protocol: "https", hostname: "**.magiceden.dev" },
      { protocol: "https", hostname: "**.magiceden.io" },
      { protocol: "https", hostname: "arweave.net" },
      { protocol: "https", hostname: "**.arweave.net" },
      { protocol: "https", hostname: "ipfs.io" },
      { protocol: "https", hostname: "**.ipfs.io" },
      { protocol: "https", hostname: "nftstorage.link" },
      { protocol: "https", hostname: "**.nftstorage.link" },
      { protocol: "https", hostname: "ordinals.com" },
      { protocol: "https", hostname: "www.ordinals.com" },
      { protocol: "https", hostname: "turbo.ordinalswallet.com" },
      { protocol: "https", hostname: "media.ordinalswallet.com" },
      { protocol: "https", hostname: "cdn.ordinalswallet.com" },
      { protocol: "https", hostname: "static.unisat.io" },
      { protocol: "https", hostname: "next-cdn.unisat.space" },
      { protocol: "https", hostname: "we-assets.pinit.io" },
      { protocol: "https", hostname: "coin-images.coingecko.com" },
      { protocol: "https", hostname: "www.miladymaker.net" },
      { protocol: "https", hostname: "miladymaker.net" },
      { protocol: "https", hostname: "ord-mirror.magiceden.dev" },
      { protocol: "https", hostname: "creator-hub-prod.s3.us-east-2.amazonaws.com" },
      { protocol: "https", hostname: "**.alchemy.com" },
      { protocol: "https", hostname: "**.cloudinary.com" },
      { protocol: "https", hostname: "lh3.googleusercontent.com" },
    ],
  },
  // Dev-only: the dev server rejects cross-origin requests by default, which
  // blocks sharing a local preview through a tunnel. Has no effect on
  // production builds — it only widens which origins `next dev` will answer.
  //
  // REAL BUG FOUND AND FIXED 2026-08-23: "127.0.0.1" was missing here even
  // though local dev/testing this whole session (launch scripts, health
  // checks, this exact conversation's browser verification) hits the app
  // via http://127.0.0.1:3800, not http://localhost:3800. Confirmed live:
  // visiting via 127.0.0.1 silently hung every on-demand dynamic import()
  // (e.g. MarketView.tsx's `await import("@/lib/market/swr-fetch")` inside
  // its listings-refresh callback) forever with no error and no network
  // request ever firing -- the real order-book API worked fine when called
  // directly, and the exact same page worked perfectly via localhost:3800
  // in the same browser session. This wasn't a code bug in any feature;
  // it silently broke Buy & Sell (and anything else behind a dynamic
  // import) for every 127.0.0.1 visitor. See the server's own emitted
  // warning ("Blocked cross-origin request... add it to allowedDevOrigins")
  // -- this is that exact fix, applied.
  allowedDevOrigins: ["*.trycloudflare.com", "127.0.0.1", "localhost"],
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
      // Admin uploads are content-addressed (name embeds the sha256 prefix),
      // so a stored file never changes — immutable is safe and lets audio
      // seek without refetching.
      {
        source: "/api/media/:name*",
        headers: [
          {
            key: "Cache-Control",
            value: "public, max-age=31536000, immutable",
          },
        ],
      },
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
      // Precomputed by scripts/refresh-market-data.ts --multichain on the
      // existing cron (lib/market/multichain/sync.ts), never live-fetched
      // per request -- a 2-minute browser/CDN cache costs nothing and keeps
      // this endpoint from ever becoming a per-visitor hit against Postgres,
      // let alone the underlying rate-limited third-party NFT APIs.
      {
        source: "/api/market/multichain",
        headers: [
          {
            key: "Cache-Control",
            value: "public, max-age=120, s-maxage=300, stale-while-revalidate=600",
          },
        ],
      },
      {
        source: "/api/market/multichain/collection",
        headers: [{ key: "Cache-Control", value: "public, max-age=30, s-maxage=120, stale-while-revalidate=600" }],
      },
      {
        source: "/api/market/multichain/feed",
        headers: [{ key: "Cache-Control", value: "public, max-age=30, s-maxage=300, stale-while-revalidate=1800" }],
      },
      {
        source: "/api/market/multichain/holder-count",
        headers: [{ key: "Cache-Control", value: "public, max-age=60, s-maxage=600, stale-while-revalidate=3600" }],
      },
      {
        source: "/api/market/multichain/rarity",
        headers: [{ key: "Cache-Control", value: "public, max-age=30, s-maxage=300, stale-while-revalidate=3600" }],
      },
      {
        source: "/api/market/multichain/trait-index",
        headers: [{ key: "Cache-Control", value: "public, max-age=60, s-maxage=600, stale-while-revalidate=3600" }],
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
