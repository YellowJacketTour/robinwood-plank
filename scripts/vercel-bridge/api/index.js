export const config = { runtime: "edge" };

/**
 * Sticky mobile/wallet DNS still dials old Vercel IPs for plank.love.
 * Many wallet WebViews break on cross-origin 302. Serve a tiny HTML
 * handoff with meta-refresh + visible link instead.
 */
const LIVE = "https://plank-love.garden-equity-field-0042.workers.dev";

function escapeHtmlAttr(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export default async function handler(req) {
  const incoming = new URL(req.url);
  const dest = LIVE + incoming.pathname + incoming.search + (incoming.hash || "");
  // dest is built from attacker-controlled path/query/hash. It's safe as a
  // 302 Location header and inside JSON.stringify() for the JS redirect
  // below, but the two places it's interpolated into raw HTML attributes
  // (content="...", href="...") need HTML-attribute escaping or a crafted
  // path/query containing a `"` or `>` could break out and inject markup.
  const destAttr = escapeHtmlAttr(dest);

  // Prefer instant redirect for normal browsers
  const ua = (req.headers.get("user-agent") || "").toLowerCase();
  const isWalletish =
    /metamask|trust|coinbase|rainbow|phantom|zerion|imtoken|tokenpocket|wallet|webview|fbav|instagram/i.test(
      ua
    );

  if (!isWalletish) {
    return new Response(null, {
      status: 302,
      headers: {
        Location: dest,
        "Cache-Control": "no-store",
        "X-Plank-Bridge": "302-to-cf-worker",
      },
    });
  }

  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <meta http-equiv="refresh" content="0;url=${destAttr}"/>
  <title>Opening Marketplank…</title>
  <style>
    body{font-family:system-ui,sans-serif;background:#14100b;color:#f8d98a;margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:1.5rem;text-align:center}
    a{color:#f8d98a;font-weight:700;font-size:1.15rem}
    p{opacity:.8;max-width:22rem;line-height:1.45}
  </style>
  <script>location.replace(${JSON.stringify(dest)});</script>
</head>
<body>
  <div>
    <p>Loading Marketplank…</p>
    <p><a href="${destAttr}">Tap here if it doesn’t open</a></p>
  </div>
</body>
</html>`;

  return new Response(html, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "X-Plank-Bridge": "html-handoff-to-cf-worker",
    },
  });
}
