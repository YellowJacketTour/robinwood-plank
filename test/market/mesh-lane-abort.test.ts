import assert from "node:assert/strict";
import test from "node:test";
import { laneShouldStop } from "../../scripts/mesh-lane";

/**
 * AUDIT lens 5 A / A8 (2026-09-06): cooperative cancellation. mesh-tick's
 * withTimeout aborts an AbortSignal when a lane overruns; evm-metadata,
 * opensea-membership and opensea-stats consult laneShouldStop between
 * iterations so the lane stops within one iteration.
 */

test("laneShouldStop: no signal -> deadline alone decides", () => {
  assert.equal(laneShouldStop(undefined, 1_000, 999), false);
  assert.equal(laneShouldStop(undefined, 1_000, 1_000), true);
});

test("laneShouldStop: an aborted signal stops the loop even with time left", () => {
  const controller = new AbortController();
  assert.equal(laneShouldStop(controller.signal, Number.MAX_SAFE_INTEGER, 0), false);
  controller.abort(new Error("lane exceeded 120000ms"));
  assert.equal(laneShouldStop(controller.signal, Number.MAX_SAFE_INTEGER, 0), true);
});

test("a loop wired like the handlers stops within one iteration of the abort", async () => {
  const controller = new AbortController();
  const deadline = Date.now() + 60_000;
  let iterations = 0;
  const lane = (async () => {
    while (!laneShouldStop(controller.signal, deadline)) {
      iterations += 1;
      await new Promise((r) => setTimeout(r, 5));
      if (iterations >= 1_000) throw new Error("loop never stopped");
    }
    return iterations;
  })();
  await new Promise((r) => setTimeout(r, 25));
  controller.abort();
  const atAbort = iterations;
  const total = await lane;
  assert.ok(total >= 1, "ran at least once");
  assert.ok(total - atAbort <= 1, `stopped within one iteration (ran ${total - atAbort} more)`);
});
