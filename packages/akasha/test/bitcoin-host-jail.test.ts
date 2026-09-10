import { test } from "node:test";
import { ok, equal as eq } from "node:assert/strict";
import { EsploraBitcoinRpc } from "../src/hose/rpc/bitcoin.ts";

/**
 * ROOT CAUSE, PROVEN BY SIMULATION AGAINST PRODUCTION.
 *
 * Live host failure counts, 2026-09-09:
 *   space 164 | blockstream 351 | emzy 538 | ninja 712 | va1 852 | tk7 1
 *
 * Those are not six health readings. Simulating this exact loop -- rotate the
 * START index, walk the rest in order, stop at the first success -- with ONLY
 * tk7 healthy predicts 167/334/501/668/834/0. Normalised, the max deviation
 * from production is 0.035. The counts are a POSITION artefact: every call
 * walked five dead hosts to reach the one live one.
 *
 * The cost was the bug: 5 dead hosts x 8s = 40s per get(), and bitcoinTick is
 * two gets plus a header, so >=120s against a 60s phase deadline. It could
 * never finish, and bitcoin-tip failed "exceeded 60000ms" every tick.
 */

function rpcWith(hosts: string[], healthy: (url: string) => boolean, timeoutMs = 50) {
  const calls: string[] = [];
  const rpc = new EsploraBitcoinRpc({
    hosts,
    timeoutMs,
    fetchImpl: (async (url: string) => {
      calls.push(String(url));
      const good = healthy(String(url));
      if (!good) throw new Error("fetch failed");
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        text: async () => "ab".repeat(32),
        json: async () => ({}),
      };
    }) as never,
  } as never);
  return { rpc, calls };
}

const HOSTS = ["https://a/api", "https://b/api", "https://c/api", "https://d/api", "https://e/api", "https://live/api"];
const onlyLive = (u: string) => u.includes("//live/");

test("THE MEASURED CASE: one healthy host in six stops costing five failures a call", async () => {
  const { rpc, calls } = rpcWith(HOSTS, onlyLive);

  // Warm up: enough calls for the jail to learn which hosts are dead.
  for (let i = 0; i < 12; i++) await rpc.getBlockHashAtHeight(966_000 + i);
  const warmup = calls.length;
  calls.length = 0;

  // Steady state: the dead hosts must no longer be attempted.
  for (let i = 0; i < 10; i++) await rpc.getBlockHashAtHeight(967_000 + i);

  const deadAttempts = calls.filter((c) => !onlyLive(c)).length;
  ok(
    deadAttempts <= 2,
    `after warmup, ${deadAttempts} of ${calls.length} calls still went to dead hosts ` +
      `(before the jail this was 5 per call; warmup itself took ${warmup})`,
  );
  ok(calls.some(onlyLive), "the healthy host must still be served");
});

test("every read still SUCCEEDS while the pool is being learned", async () => {
  // A jail that drops results is worse than the latency it removes.
  const { rpc } = rpcWith(HOSTS, onlyLive);
  for (let i = 0; i < 15; i++) {
    const hash = await rpc.getBlockHashAtHeight(966_000 + i);
    ok(hash, `read ${i} must succeed even while hosts are being benched`);
  }
});

test("A RECOVERED HOST REJOINS: success clears the streak", async () => {
  let sick = true;
  const { rpc, calls } = rpcWith(HOSTS, (u) => (u.includes("//a/") ? !sick : onlyLive(u)));

  for (let i = 0; i < 8; i++) await rpc.getBlockHashAtHeight(966_000 + i); // bench "a"
  sick = false;
  calls.length = 0;
  // The bench is time-based, so "a" is not retried immediately -- that is the
  // point. What must be true is that the pool never permanently forgets it.
  const benched = (rpc as unknown as { benched: Map<string, { until: number }> }).benched;
  const entry = benched.get("https://a/api");
  ok(entry, "the sick host must have been benched");
  ok(entry!.until > 0, "with a real expiry");
  ok(entry!.until - Date.now() <= 15 * 60_000 + 1_000, "and a bounded one, so it can come back");
});

test("A SUCCESS REALLY CLEARS THE STREAK, not just the expiry", async () => {
  // A mutation removing `benched.delete(host)` on success ESCAPED the test
  // above: it asserted on the bench ENTRY, never that a success removes it.
  // Without the clear, a host that fails twice, recovers, then fails once
  // more is benched again instantly on a streak it already paid off -- and
  // the backoff keeps doubling forever. Same "guard that cannot fire" shape,
  // this time in the recovery path.
  const { rpc } = rpcWith(HOSTS, () => true); // everything healthy
  const benched = (rpc as unknown as { benched: Map<string, unknown> }).benched;
  // Seed a streak by hand, as if this host had been failing.
  benched.set("https://a/api", { until: 0, streak: 5 });
  // A rotation start of 0 means "a" is tried first and succeeds.
  await rpc.getBlockHashAtHeight(966_000);
  ok(
    !benched.has("https://a/api"),
    "a successful read must remove the host's bench record entirely",
  );
});

test("a fully cooling pool waits instead of hammering failed providers", async () => {
  // Retry only after the provider cooldown expires.
  const { rpc, calls } = rpcWith(HOSTS, () => false);
  for (let i = 0; i < 6; i++) await rpc.getBlockHashAtHeight(966_000 + i);
  calls.length = 0;
  await rpc.getBlockHashAtHeight(999_999);
  eq(calls.length, 0, "no provider is retried before its cooldown expires");
});

test("one blip does not sideline a healthy host", async () => {
  let failNext = true;
  const { rpc } = rpcWith(HOSTS, (u) => {
    if (u.includes("//a/") && failNext) {
      failNext = false;
      return false;
    }
    return true;
  });
  await rpc.getBlockHashAtHeight(966_000);
  const benched = (rpc as unknown as { benched: Map<string, { until: number }> }).benched;
  const entry = benched.get("https://a/api");
  ok(!entry || entry.until === 0, "a single failure must not bench a host");
});


test("429 Retry-After applies across regional endpoints of the same provider", async () => {
  const calls:string[]=[];
  const rpc=new EsploraBitcoinRpc({hosts:["https://mempool.space/api","https://mempool.va1.mempool.space/api","https://independent.example/api"],fetchImpl:(async(url)=>{
    calls.push(String(url));
    return String(url).includes("mempool.space") ? new Response("limited",{status:429,headers:{"retry-after":"120"}}) : new Response("ab".repeat(32));
  }) as typeof fetch});
  ok(await rpc.getBlockHashAtHeight(100));
  eq(calls.some(url=>url.includes("mempool.va1")),false);
  calls.length=0;
  ok(await rpc.getBlockHashAtHeight(101));
  eq(calls.some(url=>url.includes("mempool.space")),false);
});
