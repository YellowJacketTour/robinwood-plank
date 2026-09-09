import { test } from "node:test";
import { ok, equal as eq, deepEqual } from "node:assert/strict";
import { EsploraBitcoinRpc } from "../src/hose/rpc/bitcoin.ts";

/**
 * The pool walked `hosts` in fixed order, so every request hit hosts[0] and
 * the rest were pure failover. Harmless while the backfill fetched one block
 * at a time -- a real hazard once the epoch walk fetches 16 heights
 * concurrently, because all 16 land on one free endpoint. That is how this
 * archive earned a 30-minute cooldown once already.
 */

function rpcWithSpy(hosts: string[], behaviour: (url: string) => { ok: boolean }) {
  const calls: string[] = [];
  const rpc = new EsploraBitcoinRpc({
    hosts,
    fetchImpl: (async (url: string) => {
      calls.push(String(url));
      const { ok: good } = behaviour(String(url));
      return {
        ok: good,
        status: good ? 200 : 503,
        statusText: good ? "OK" : "Service Unavailable",
        text: async () => "00".repeat(32),
        json: async () => ({}),
      };
    }) as never,
  } as never);
  return { rpc, calls };
}

const hostOf = (url: string) => new URL(url).host;

test("a burst of requests is spread across hosts, not aimed at one", async () => {
  const hosts = ["https://a.example/api", "https://b.example/api", "https://c.example/api"];
  const { rpc, calls } = rpcWithSpy(hosts, () => ({ ok: true }));

  await Promise.all([0, 1, 2, 3, 4, 5].map((i) => rpc.getBlockHashAtHeight(900_000 + i)));

  const used = new Set(calls.map(hostOf));
  eq(used.size, 3, `a 6-request burst used ${used.size} of 3 hosts: ${[...used].join(", ")}`);

  // And roughly evenly -- one host absorbing the burst is the bug.
  const perHost = new Map<string, number>();
  for (const c of calls) perHost.set(hostOf(c), (perHost.get(hostOf(c)) ?? 0) + 1);
  for (const [h, n] of perHost) ok(n <= 3, `${h} took ${n} of 6 requests; the point is to spread them`);
});

test("FAILOVER SURVIVES: a dead host costs one hop, never the request", async () => {
  // The property rotation could break. If the rotated order did not still
  // include every host, a single bad endpoint would start failing requests
  // outright instead of falling through.
  const hosts = ["https://dead.example/api", "https://good.example/api"];
  const { rpc, calls } = rpcWithSpy(hosts, (url) => ({ ok: !url.includes("dead") }));

  for (let i = 0; i < 4; i++) {
    const hash = await rpc.getBlockHashAtHeight(900_000 + i);
    ok(hash, `request ${i} must still succeed despite a dead host`);
  }
  ok(calls.some((c) => hostOf(c) === "dead.example"), "the dead host must still be attempted");
  ok(calls.some((c) => hostOf(c) === "good.example"), "and the good one must serve");
});

test("every host is tried before the call is allowed to fail", async () => {
  const hosts = ["https://x.example/api", "https://y.example/api", "https://z.example/api"];
  const { rpc, calls } = rpcWithSpy(hosts, () => ({ ok: false }));
  // getBlockHashAtHeight swallows and returns null; that is its contract.
  const got = await rpc.getBlockHashAtHeight(900_000);
  eq(got, null, "a total failure returns null, not a fabricated hash");
  deepEqual(new Set(calls.map(hostOf)).size, 3, "all three hosts must be attempted");
});

test("a single-host pool still works", async () => {
  const { rpc, calls } = rpcWithSpy(["https://only.example/api"], () => ({ ok: true }));
  const hash = await rpc.getBlockHashAtHeight(900_000);
  ok(hash, "one host must still serve");
  eq(calls.length, 1, "and must not be retried pointlessly");
});
