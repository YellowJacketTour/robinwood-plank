// Only these arcade paths belong to the invite gateway (session, cookie-gated
// manifest, server clock) or are HTML the site rewrites; everything else under
// /arcade/ is a static asset the edge can serve without touching origin.
const ORIGIN_ONLY = new Set([
  "/arcade/crash.html",
  "/arcade/table.html",
  "/arcade/deploy-addresses.local.json",
  "/arcade/practice-clock.js",
]);
const IMMUTABLE = /^\/arcade\/(vendor|art)\//;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    if (!path.startsWith("/arcade/") || ORIGIN_ONLY.has(path) || request.method !== "GET" && request.method !== "HEAD") {
      return fetch(request);
    }
    // Assets ignore the per-deploy ?v= stamp; the stamp still defeats a stale
    // HTML cache, and content is revalidated by ETag below.
    const assetUrl = new URL(url); assetUrl.search = "";
    const asset = await env.ASSETS.fetch(new Request(assetUrl, request));
    if (asset.status === 404) return fetch(request);
    const headers = new Headers(asset.headers);
    headers.set("Cache-Control", IMMUTABLE.test(path)
      ? "public, max-age=31536000, immutable"
      : "no-cache, must-revalidate");
    headers.set("X-Plank-Edge", "assets");
    headers.set("Cross-Origin-Resource-Policy", "same-origin");
    return new Response(asset.body, { status: asset.status, headers });
  },
};
