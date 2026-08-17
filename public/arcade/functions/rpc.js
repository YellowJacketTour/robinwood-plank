// Cloudflare Pages Function: proxies JSON-RPC to Robinhood Chain Testnet's
// public RPC, fixes its broken CORS header, and short-TTL caches responses
// so this page's several parallel polling widgets (crash state, Vault,
// Powerboard, Progression, Fuel, plus a background keeper) don't each hit
// the upstream independently every poll tick.
//
// Three real bugs this fixes, found in that order:
//
// 1. CORS: the public RPC (rpc.testnet.chain.robinhood.com) sends
//    "Access-Control-Allow-Origin: *,*" -- a duplicated value every
//    browser's fetch() rejects outright, even though the same request
//    succeeds fine from curl/node (neither enforces CORS). That looked
//    like "nothing works" from the browser while every non-browser check
//    passed clean.
//
// 2. RATE LIMIT: once CORS was fixed, this page's real request volume
//    started hitting the upstream's real, documented rate limit -- 429s,
//    surfaced client-side as the SAME kind of failure the CORS bug
//    caused (a call silently not completing), badly enough to genuinely
//    stall a round at IGNITION for 20+ seconds. Slowing this page's own
//    poll rate was tried first and made a DIFFERENT thing worse (see
//    crash.html's comment on pollTimer): a round can fully resolve within
//    one slow poll, so the client can jump straight past LIVE and never
//    render the launch at all.
//
// 3. IN-MEMORY CACHE DOESN'T WORK HERE: a first attempt cached responses
//    in a plain JS Map at module scope, on the assumption a Workers
//    isolate stays warm and shares that memory across requests. Under
//    real concurrent load (many polling widgets firing near-simultaneous
//    requests) Cloudflare spins up MULTIPLE isolates in parallel, each
//    with its own separate Map -- most requests still missed the cache
//    and the 429 storm barely improved. Cloudflare's Cache API
//    (`caches.default`) is the actual edge-shared cache primitive here;
//    switching to it is what actually cuts real upstream request volume.
const UPSTREAM = "https://rpc.testnet.chain.robinhood.com";
// Rounds run on a 20s cadence; sub-second read freshness was never
// actually needed for correctness, only for smooth animation, and the
// client itself keeps polling at its own 400/600ms cadence regardless --
// a few-second cache here just means several of those polls share one
// upstream answer instead of each re-fetching.
const CACHE_TTL_SECONDS = 3;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

export async function onRequestPost(context) {
  const bodyText = await context.request.text();
  let parsed;
  try {
    parsed = JSON.parse(bodyText);
  } catch (_) {
    parsed = null;
  }

  // Never cache a transaction submission, and never cache the nonce read
  // (eth_getTransactionCount) -- a stale nonce across a rapid sequence of
  // txs from the same signer (the keeper's lock -> reveal -> settle, or
  // several admin-panel actions back to back) would cause real "nonce too
  // low"/"already known" failures. Everything else here is a view read
  // where a few seconds' staleness is a fine tradeoff against real
  // rate-limiting.
  const NEVER_CACHE = new Set(["eth_sendRawTransaction", "eth_getTransactionCount"]);
  const cacheable = parsed && parsed.method && !NEVER_CACHE.has(parsed.method);

  const cache = caches.default;
  // The Cache API keys on Request (effectively its URL) -- there's no
  // JSON-RPC-aware keying built in, so encode method+params (never `id`,
  // which every caller sets differently and would otherwise defeat the
  // cache entirely) into a synthetic cache-key URL that's never actually
  // fetched.
  const cacheKey = cacheable
    ? new Request(
        "https://rpc-cache.internal/" + encodeURIComponent(parsed.method + ":" + JSON.stringify(parsed.params || []))
      )
    : null;

  if (cacheKey) {
    const hit = await cache.match(cacheKey);
    if (hit) {
      const hitJson = await hit.json();
      // Re-stamp the cached result with THIS request's own id -- JSON-RPC
      // callers match responses to requests by id, so echoing the cached
      // response's original id would silently break every caller after
      // the first.
      return new Response(JSON.stringify({ ...hitJson, id: parsed.id }), {
        status: 200,
        headers: { "Content-Type": "application/json", ...CORS_HEADERS, "X-RPC-Cache": "HIT" },
      });
    }
  }

  const upstream = await fetch(UPSTREAM, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: bodyText,
  });
  const text = await upstream.text();

  if (cacheKey && upstream.status === 200) {
    // Fire-and-forget: don't make the caller wait on the cache write.
    context.waitUntil(
      cache.put(
        cacheKey,
        new Response(text, {
          headers: { "Content-Type": "application/json", "Cache-Control": `max-age=${CACHE_TTL_SECONDS}` },
        })
      )
    );
  }

  return new Response(text, {
    status: upstream.status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS, "X-RPC-Cache": "MISS" },
  });
}

export async function onRequestGet() {
  return new Response(JSON.stringify({ ok: true, note: "POST JSON-RPC requests here" }), {
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}
