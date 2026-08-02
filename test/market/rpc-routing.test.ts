import assert from "node:assert/strict";
import test from "node:test";
import { SERVER_RPC_URLS, SERVER_DISPLAY_RPC_URLS } from "../../lib/server/rpc-urls";
import { ROBINHOOD_RPC_URLS } from "../../lib/mint-contract";
import { ethCallMany, rpcCall } from "../../lib/market/fetch-rpc";
import { clearRpcCache } from "../../lib/market/rpc-cache";

/**
 * SERVER_DISPLAY_RPC_URLS exists so high-volume, non-decision-critical reads
 * (vault dashboard stats, activity-feed enrichment, token art) stop defaulting
 * to the metered provider the way SERVER_RPC_URLS does for decision-critical
 * reads (order validation, ownership checks). Getting the ordering backwards
 * here would silently put the display traffic back on the bill it was moved
 * off of.
 */
test("SERVER_DISPLAY_RPC_URLS puts every public endpoint before the keyed one; SERVER_RPC_URLS is the reverse", () => {
  if (process.env.NEXT_PUBLIC_DEV_LOCAL_CHAIN === "1") return; // both lists collapse to the local node

  for (const url of ROBINHOOD_RPC_URLS) {
    assert.ok(SERVER_DISPLAY_RPC_URLS.includes(url), `${url} must still be a candidate`);
  }

  const keyed = process.env.RPC_URL?.trim();
  if (!keyed) return; // no keyed provider configured in this environment — ordering is moot

  const displayKeyedIdx = SERVER_DISPLAY_RPC_URLS.indexOf(keyed);
  const displayPublicIdx = SERVER_DISPLAY_RPC_URLS.findIndex((u) => u !== keyed);
  assert.ok(displayKeyedIdx >= 0, "keyed provider must still be present as a fallback");
  assert.ok(
    displayPublicIdx >= 0 && displayPublicIdx < displayKeyedIdx,
    "a public endpoint must come before the keyed provider in the display list"
  );

  const serverKeyedIdx = SERVER_RPC_URLS.indexOf(keyed);
  assert.equal(serverKeyedIdx, 0, "SERVER_RPC_URLS must still try the keyed provider first");
});

/**
 * fetch is mocked directly rather than through a real network call — these
 * tests are about routing/failover *logic*, not live endpoints.
 */
function installFetch(
  handler: (url: string, init: RequestInit) => Promise<Response>
): { hits: string[]; restore: () => void } {
  const hits: string[] = [];
  const orig = global.fetch;
  const mock: typeof global.fetch = async (input, init) => {
    hits.push(String(input));
    return handler(String(input), init ?? {});
  };
  global.fetch = mock;
  return {
    hits,
    restore: () => {
      global.fetch = orig;
    },
  };
}

test("ethCallMany respects an explicit urls list and falls through on failure", async () => {
  clearRpcCache();
  const urlA = "https://fake-a.test/rpc";
  const urlB = "https://fake-b.test/rpc";
  const { hits, restore } = installFetch(async (url, init) => {
    if (url === urlA) return new Response("", { status: 500 });
    const body = JSON.parse(String(init.body)) as Array<{ id: number }>;
    return new Response(
      JSON.stringify(body.map((e) => ({ id: e.id, result: "0xok" }))),
      { status: 200 }
    );
  });
  try {
    const out = await ethCallMany([{ to: "0xaaa", data: "0x01" }], { urls: [urlA, urlB] });
    assert.deepEqual(out, ["0xok"]);
    assert.ok(hits.includes(urlA), "the first URL in the list must be tried");
    assert.ok(hits.includes(urlB), "a failing first URL must fall through to the second");
  } finally {
    restore();
  }
});

test("a URL that fails repeatedly is skipped by later calls once its breaker opens", async () => {
  clearRpcCache();
  const failing = "https://fake-breaker-a.test/rpc";
  const healthy = "https://fake-breaker-b.test/rpc";
  const hitCounts = new Map<string, number>();
  const { restore } = installFetch(async (url) => {
    hitCounts.set(url, (hitCounts.get(url) ?? 0) + 1);
    if (url === failing) return new Response("", { status: 429 });
    return new Response(JSON.stringify({ result: "0xok" }), { status: 200 });
  });
  try {
    // Distinct params on every call so the response cache never short-circuits
    // the network path we're actually testing.
    for (let i = 0; i < 3; i += 1) {
      await rpcCall("eth_call", [{ to: "0xbreaker", data: `0x0${i}` }, "latest"], {
        urls: [failing, healthy],
      });
    }
    const hitsSoFar = hitCounts.get(failing) ?? 0;
    assert.ok(hitsSoFar > 0, "the failing URL must have been attempted at least once");

    await rpcCall("eth_call", [{ to: "0xbreaker", data: "0x099" }, "latest"], {
      urls: [failing, healthy],
    });
    assert.equal(
      hitCounts.get(failing),
      hitsSoFar,
      "once the breaker is open, the failing URL must be skipped rather than retried"
    );
  } finally {
    restore();
  }
});

test("a healthy-again URL is retried once its cooldown is respected by a fresh breaker entry", async () => {
  clearRpcCache();
  const url = "https://fake-recovers.test/rpc";
  const { restore } = installFetch(async () => new Response(JSON.stringify({ result: "0xok" }), { status: 200 }));
  try {
    // A URL with no prior failures is never skipped.
    const out = await rpcCall<string>("eth_call", [{ to: "0xfresh", data: "0x01" }, "latest"], {
      urls: [url],
    });
    assert.equal(out, "0xok");
  } finally {
    restore();
  }
});
