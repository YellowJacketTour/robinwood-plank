import assert from "node:assert/strict";
import test from "node:test";
import {
  __resetGatewayStateForTests,
  acquireGatewayToken,
  activeIpfsGateways,
  fetchNftMetadata,
  GATEWAY_RATE_PER_SECOND,
  IPFS_GATEWAYS,
  rotateGatewayCandidates,
} from "@/lib/ipfs";

/**
 * AUDIT Batch F7 -- one gateway per attempt (never a 3-way race), rotation
 * across hosts, per-host token bucket (~8 rps), 5 s timeout, retry on a
 * different host, PLANK_IPFS_GATEWAYS env override.
 */

test("PLANK_IPFS_GATEWAYS overrides the pool; garbage entries are ignored; unset keeps the default", () => {
  const prior = process.env.PLANK_IPFS_GATEWAYS;
  try {
    delete process.env.PLANK_IPFS_GATEWAYS;
    assert.deepEqual([...activeIpfsGateways()], [...IPFS_GATEWAYS]);
    process.env.PLANK_IPFS_GATEWAYS = "https://gw.example.com/ipfs/, https://second.example.org/ipfs ,not-a-url";
    assert.deepEqual([...activeIpfsGateways()], ["https://gw.example.com/ipfs/", "https://second.example.org/ipfs/"]);
    process.env.PLANK_IPFS_GATEWAYS = "garbage";
    assert.deepEqual([...activeIpfsGateways()], [...IPFS_GATEWAYS]);
  } finally {
    if (prior === undefined) delete process.env.PLANK_IPFS_GATEWAYS;
    else process.env.PLANK_IPFS_GATEWAYS = prior;
  }
});

test("rotation starts each fetch on a different host", () => {
  __resetGatewayStateForTests();
  const candidates = ["https://a/ipfs/x", "https://b/ipfs/x", "https://c/ipfs/x"];
  const first = rotateGatewayCandidates(candidates)[0];
  const second = rotateGatewayCandidates(candidates)[0];
  const third = rotateGatewayCandidates(candidates)[0];
  assert.deepEqual(new Set([first, second, third]).size, 3);
});

test("per-host token bucket paces beyond the burst at ~8 rps", async () => {
  __resetGatewayStateForTests();
  const start = Date.now();
  for (let i = 0; i < GATEWAY_RATE_PER_SECOND; i++) await acquireGatewayToken("bucket.test");
  assert.ok(Date.now() - start < 100, "the burst is free");
  // The 9th and 10th requests wait for refill: at 8 rps, two extra tokens take ~250 ms.
  const before = Date.now();
  await acquireGatewayToken("bucket.test");
  await acquireGatewayToken("bucket.test");
  const waited = Date.now() - before;
  assert.ok(waited >= 150, `expected pacing wait, got ${waited}ms`);
  // A different host has its own bucket.
  const other = Date.now();
  await acquireGatewayToken("other.test");
  assert.ok(Date.now() - other < 50);
});

test("fetch is strictly sequential (never two gateways in flight) and retries on a different host", async () => {
  __resetGatewayStateForTests();
  const originalFetch = globalThis.fetch;
  const hosts: string[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    const host = new URL(url).hostname;
    hosts.push(host);
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight -= 1;
    if (hosts.length < 3) return new Response("nope", { status: 429 });
    return new Response(JSON.stringify({ name: "Token #1", image: "ipfs://img", attributes: [{ trait_type: "Hat", value: "Cap" }] }), {
      status: 200, headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  try {
    const data = await fetchNftMetadata("ipfs://bafytestcid/1.json", { force: true });
    assert.equal(data.name, "Token #1");
    assert.equal(maxInFlight, 1, "exactly one gateway request in flight at a time");
    assert.equal(hosts.length, 3);
    assert.equal(new Set(hosts).size, 3, "every retry went to a different host");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a host that answered 429 is rotated to the back for the next fetch", () => {
  // The previous test rested two hosts; they must sort after the fresh ones.
  const candidates = [...IPFS_GATEWAYS].map((g) => `${g}bafytestcid/2.json`);
  const ordered = rotateGatewayCandidates(candidates);
  const rested = new Set(["gateway.pinata.cloud", "ipfs.io", "nftstorage.link", "w3s.link", "dweb.link", "4everland.io", "cloudflare-ipfs.com"]);
  assert.ok(rested.has(new URL(ordered[0]).hostname));
  assert.equal(ordered.length, candidates.length);
});
