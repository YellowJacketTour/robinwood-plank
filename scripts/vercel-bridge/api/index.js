export const config = { runtime: "edge" };

const ORIGIN = "https://plank-love.garden-equity-field-0042.workers.dev";

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailers",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
]);

/**
 * Bridge for phones still dialing cached Vercel IPs for plank.love.
 * Proxies the full Cloudflare Worker origin so the address bar stays plank.love.
 *
 * Must forward Next.js RSC / router headers or the client shows a soft 404
 * after first paint when JS hydrates against the wrong payload.
 */
export default async function handler(req) {
  const incoming = new URL(req.url);
  const target = ORIGIN + incoming.pathname + incoming.search;

  const headers = new Headers();
  req.headers.forEach((value, key) => {
    const k = key.toLowerCase();
    if (HOP_BY_HOP.has(k)) return;
    // Avoid leaking Vercel internal headers upstream
    if (k.startsWith("x-vercel-")) return;
    headers.set(key, value);
  });
  headers.set("x-plank-bridge", "1");
  headers.set("x-forwarded-host", incoming.hostname);
  headers.set("x-forwarded-proto", "https");

  let upstream;
  try {
    upstream = await fetch(target, {
      method: req.method,
      headers,
      redirect: "manual",
      body:
        req.method === "GET" || req.method === "HEAD" ? undefined : req.body,
      // @ts-expect-error duplex needed for streaming body on some runtimes
      duplex: "half",
    });
  } catch {
    return new Response(
      `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
<title>plank.love</title>
<body style="font-family:system-ui;padding:2rem;background:#14100b;color:#f8d98a">
<h1>Temporary bridge error</h1>
<p>Open the live Cloudflare host:</p>
<p><a style="color:#f8d98a" href="https://plank-love.garden-equity-field-0042.workers.dev${incoming.pathname}">Continue to Marketplank</a></p>
</body>`,
      { status: 502, headers: { "content-type": "text/html; charset=utf-8" } }
    );
  }

  // Absolute redirect to workers.dev → rewrite to same path on plank.love
  if (upstream.status >= 300 && upstream.status < 400) {
    const loc = upstream.headers.get("location");
    if (loc) {
      try {
        const u = new URL(loc, ORIGIN);
        if (
          u.hostname.includes("workers.dev") ||
          u.hostname.includes("plank.love")
        ) {
          const rewritten = incoming.origin + u.pathname + u.search + u.hash;
          return Response.redirect(rewritten, upstream.status);
        }
      } catch {
        /* fall through */
      }
    }
  }

  const out = new Headers();
  upstream.headers.forEach((value, key) => {
    const k = key.toLowerCase();
    if (HOP_BY_HOP.has(k)) return;
    if (k === "content-encoding") return;
    out.set(key, value);
  });
  out.set("x-plank-bridged", "vercel-to-cf");
  out.set("cache-control", "public, max-age=0, must-revalidate");

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: out,
  });
}
