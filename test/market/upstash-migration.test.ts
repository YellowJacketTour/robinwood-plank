import assert from "node:assert/strict";
import test from "node:test";

import {
  buildPostgresPlan,
  expectedCounts,
  readMarketSnapshot,
} from "../../scripts/lib/upstash-postgres-snapshot.mjs";
import {
  decodeJsonish,
  ReadonlyUpstashRest,
} from "../../scripts/lib/upstash-rest.mjs";

test("direct REST decoder preserves unsafe Redis integers", () => {
  assert.equal(decodeJsonish("9007199254740993"), "9007199254740993");
  assert.equal(decodeJsonish("42"), 42);
  assert.deepEqual(decodeJsonish('{"ok":true}'), { ok: true });
  assert.equal(decodeJsonish("0xabc"), "0xabc");
});

test("read-only REST client scans without exposing credentials in commands", async () => {
  const calls: Array<{ body: unknown; authorization: string | null }> = [];
  const pages = [
    ["7", ["plank:market:b"]],
    ["0", ["plank:market:a"]],
  ];
  const client = new ReadonlyUpstashRest({
    url: "https://example.upstash.io",
    token: "read-only-token",
    fetchImpl: async (_url: string, init: RequestInit) => {
      calls.push({
        body: JSON.parse(String(init.body)),
        authorization: new Headers(init.headers).get("authorization"),
      });
      return new Response(JSON.stringify({ result: pages.shift() }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });

  assert.deepEqual(await client.scanKeys("plank:market:*"), [
    "plank:market:a",
    "plank:market:b",
  ]);
  assert.deepEqual(
    calls.map((call) => call.body),
    [
      ["SCAN", "0", "MATCH", "plank:market:*", "COUNT", "100"],
      ["SCAN", "7", "MATCH", "plank:market:*", "COUNT", "100"],
    ]
  );
  assert.ok(calls.every((call) => call.authorization === "Bearer read-only-token"));
});

test("snapshot refuses lossy TTL import for hashes and sets", async () => {
  const source = {
    scanKeys: async () => ["plank:market:listings"],
    type: async () => "hash",
    ttl: async () => 30,
    hgetall: async () => ({}),
  };
  await assert.rejects(
    readMarketSnapshot(source),
    /Cannot preserve TTL=30s on hash/
  );
});

test("migration plan prefers modern order hashes and counts every storage shape", () => {
  const now = new Date("2026-07-30T00:00:00.000Z");
  const legacy = {
    id: "order-1",
    collectionSlug: "robinwood",
    maker: "0x1111111111111111111111111111111111111111",
    tokenId: "1",
    priceWei: "100",
    expiresAt: "2027-01-01T00:00:00.000Z",
  };
  const modern = { ...legacy, priceWei: "200" };
  const snapshot = {
    pattern: "plank:market:*",
    expiredDuringRead: [],
    entries: [
      {
        key: "plank:market:orders",
        type: "string",
        ttl: -1,
        capturedAt: now,
        count: 1,
        value: { listings: { "order-1": legacy }, offers: {} },
      },
      {
        key: "plank:market:listings",
        type: "hash",
        ttl: -1,
        capturedAt: now,
        count: 1,
        value: { "order-1": modern },
      },
      {
        key: "plank:market:served-order-hashes",
        type: "set",
        ttl: -1,
        capturedAt: now,
        count: 1,
        value: [`0x${"a".repeat(64)}`],
      },
      {
        key: "plank:market:cache",
        type: "string",
        ttl: 60,
        capturedAt: now,
        count: 1,
        value: { cached: true },
      },
      {
        key: "plank:market:index",
        type: "hash",
        ttl: -1,
        capturedAt: now,
        count: 1,
        value: { robinwood: ["1"] },
      },
      {
        key: "plank:market:set",
        type: "set",
        ttl: -1,
        capturedAt: now,
        count: 1,
        value: ["member"],
      },
    ],
  };

  const plan = buildPostgresPlan(snapshot);
  assert.equal(plan.orders[0].value.priceWei, "200");
  assert.equal(
    plan.values[0].expiresAt?.toISOString(),
    "2026-07-30T00:01:00.000Z"
  );
  assert.deepEqual(expectedCounts(plan), {
    orders: 1,
    listings: 1,
    offers: 0,
    servedHashes: 1,
    values: 1,
    hashFields: 1,
    setMembers: 1,
  });
});
