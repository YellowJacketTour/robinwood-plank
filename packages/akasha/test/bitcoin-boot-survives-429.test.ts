import { test } from "node:test";
import { ok, equal as eq } from "node:assert/strict";
import { readFileSync } from "node:fs";
import { EsploraBitcoinRpc } from "../src/hose/rpc/bitcoin.ts";

/**
 * THE ROOT CAUSE, in the worker's own words (provisioning proof run,
 * 2026-09-09):
 *
 *   [akasha-hose] fatal: Error:
 *     https://blockstream.info/api/blocks/tip/height: 429 Too Many Requests
 *       at Hose.bootBitcoin ... at Hose.boot ... at main
 *
 * The worker could not BOOT. Not a stalled backfill, not a slow tick -- the
 * process died before its first tick. That is why the archive had no
 * heartbeat, no phase rows, and a tip frozen for hours, and why three separate
 * investigations of the backfill were reading code that never ran.
 *
 * Both original hosts answered 200 from a developer machine at the same
 * moment, so the throttle was specific to the production IP.
 */

const MAIN = readFileSync(new URL("../src/hose/main.ts", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const RPC = readFileSync(new URL("../src/hose/rpc/bitcoin.ts", import.meta.url), "utf8").replace(/\r\n/g, "\n");

test("an already-locked chain does not fetch a tip to boot", () => {
  // getBestBlockHash is needed only to CHOOSE a lock block. Once
  // akasha_cursor holds one, the lock is a settled fact in the database --
  // but the fetch ran unconditionally, so one vendor throttle killed boot.
  const at = MAIN.indexOf("AN ALREADY-LOCKED CHAIN NEEDS NO TIP FETCH");
  ok(at > 0, "the guard must exist and say why");
  const body = MAIN.slice(at, MAIN.indexOf("const pinned = this.cfg.t0?.bitcoin;", at));
  ok(/const alreadyLocked = this\.store\.getCursor\("bitcoin"\)/.test(body), "it must read the cursor");
  ok(/return;/.test(body), "and must return before the tip fetch");

  // The guard must come BEFORE getBestBlockHash, or it guards nothing.
  const guard = MAIN.indexOf("const alreadyLocked = this.store.getCursor");
  const fetchTip = MAIN.indexOf("await rpc.getBestBlockHash()");
  ok(guard > 0 && fetchTip > 0);
  ok(guard < fetchTip, "the guard must precede the fetch it exists to skip");
});

test("a PINNED t0 still locks, so cutover behaviour is unchanged", () => {
  // The skip must not swallow an explicit pin -- that is how an operator
  // re-locks a chain deliberately.
  const at = MAIN.indexOf("const alreadyLocked = this.store.getCursor");
  const body = MAIN.slice(at, at + 400);
  ok(/!this\.cfg\.t0\?\.bitcoin/.test(body), "an explicit pin must still take the full path");
});

test("the self-parent repair survives the skip, best-effort", () => {
  // The early return could silently drop the repair that fixed the poisoned
  // lock row. It still runs -- but a failed repair must not throw, because a
  // poisoned row is recoverable next boot and a dead worker is not.
  const at = MAIN.indexOf("const alreadyLocked = this.store.getCursor");
  const body = MAIN.slice(at, MAIN.indexOf("const pinned = this.cfg.t0?.bitcoin;", at));
  ok(/repairSelfParent/.test(body), "the repair must still run on the skip path");
  ok(/\.catch\(\(\) => null\)/.test(body), "and its network read must not throw");
});

test("the host pool is a pool, not one spare", () => {
  const hosts = (RPC.match(/https:\/\/[a-z0-9.-]+\/api/g) ?? []).filter((h, i, a) => a.indexOf(h) === i);
  ok(hosts.length >= 4, `two hosts is one spare, not a pool (saw ${hosts.length})`);
});

test("429 is classified as retryable, not as a verdict on the data", async () => {
  // A 429 means "ask again later". Treating it like a 404 is what turned a
  // throttle into a fatal boot error.
  // Assert on the SET's contents by substring, not by a built regex: a
  // dynamically constructed  pattern around a number inside a comma list
  // proved unreliable here and failed while the code was correct.
  ok(RPC.includes("RETRYABLE_STATUS"), "retryable statuses must be named");
  const line = RPC.split(String.fromCharCode(10)).find((l) => l.includes("RETRYABLE_STATUS = new Set"));
  ok(line, "the set must be declared");
  for (const code of ["429", "503", "504"]) {
    ok(line!.includes(code), `${code} must be treated as retryable`);
  }
  // And a 404 must NOT be: "this block does not exist" is a real answer.
  ok(!line!.includes("404"), "404 is a verdict on the data, not a wait");
});

test("BEHAVIOUR: a throttled first host falls through to a healthy one", async () => {
  const calls: string[] = [];
  const rpc = new EsploraBitcoinRpc({
    hosts: ["https://throttled.example/api", "https://healthy.example/api"],
    fetchImpl: (async (url: string) => {
      calls.push(String(url));
      const throttled = String(url).includes("throttled");
      return {
        ok: !throttled,
        status: throttled ? 429 : 200,
        statusText: throttled ? "Too Many Requests" : "OK",
        text: async () => "ab".repeat(32),
        json: async () => ({}),
      };
    }) as never,
  } as never);

  const hash = await rpc.getBlockHashAtHeight(966_000);
  ok(hash, "a 429 on one host must not fail the read");
  ok(calls.some((c) => c.includes("healthy")), "the healthy host must actually be tried");
});
