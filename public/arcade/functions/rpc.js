// Cloudflare Pages Function: proxies JSON-RPC to Robinhood Chain Testnet's
// public RPC and returns a single, valid Access-Control-Allow-Origin header.
//
// Real bug this fixes: the public RPC (rpc.testnet.chain.robinhood.com)
// sends "Access-Control-Allow-Origin: *,*" -- a duplicated value that every
// browser's fetch() rejects as an invalid CORS response, even though the
// same request succeeds fine from curl/node (neither enforces CORS). That
// silently broke EVERY contract read/write from crash.html and the admin
// panel once actually loaded in a browser -- the "nothing starts flying"
// and "widget flickering in and out" symptoms were this, not a game bug.
//
// Only used by the friend-test static bundle (see scripts/testnet-casino-
// setup.ts's rpcUrl, and the deploy notes for staging this alongside
// crash.html/dev-panel-testnet.html) -- not part of the main Next.js app.
const UPSTREAM = "https://rpc.testnet.chain.robinhood.com";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

export async function onRequestPost(context) {
  const body = await context.request.text();
  const upstream = await fetch(UPSTREAM, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
  const text = await upstream.text();
  return new Response(text, {
    status: upstream.status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

export async function onRequestGet() {
  return new Response(JSON.stringify({ ok: true, note: "POST JSON-RPC requests here" }), {
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}
