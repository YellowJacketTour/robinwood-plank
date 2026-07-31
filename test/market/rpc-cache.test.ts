import assert from "node:assert/strict";
import test from "node:test";
import {
  cacheTtlMs,
  clearRpcCache,
  peekRpcCache,
  putRpcCache,
  withRpcCache,
} from "../../lib/market/rpc-cache";

/**
 * The cache exists to stop provider spend scaling with poll rate and tab count.
 * Its failure mode is worse than the spend it saves, though: caching a write, a
 * nonce, or an unmined receipt breaks transactions. These pin the safety rules
 * first and the savings second.
 */

test("writes and nonce reads are never cached", () => {
  for (const method of [
    "eth_sendRawTransaction",
    "eth_sendTransaction",
    "eth_getTransactionCount",
    "eth_estimateGas",
    "eth_gasPrice",
  ]) {
    assert.equal(cacheTtlMs(method, []), 0, `${method} must bypass the cache`);
  }
});

test("unknown methods are not cached", () => {
  assert.equal(cacheTtlMs("eth_someFutureMethod", []), 0);
});

test("a fixed block height is immutable; a moving tag is not", () => {
  const fixed = cacheTtlMs("eth_getBlockByNumber", ["0x1234", false]);
  const latest = cacheTtlMs("eth_getBlockByNumber", ["latest", false]);
  assert.ok(fixed > latest, "a mined block should outlive a 'latest' read");
  assert.ok(latest > 0 && latest <= 10_000, "'latest' must stay short-lived");
  for (const tag of ["pending", "safe", "finalized"]) {
    assert.equal(cacheTtlMs("eth_getBlockByNumber", [tag, false]), latest);
  }
});

test("eth_getLogs is cached only for an explicit closed range", () => {
  assert.equal(
    cacheTtlMs("eth_getLogs", [{ fromBlock: "0x1", toBlock: "latest" }]),
    0,
    "an open-ended range can still gain logs"
  );
  assert.equal(cacheTtlMs("eth_getLogs", [{}]), 0);
  assert.ok(cacheTtlMs("eth_getLogs", [{ fromBlock: "0x1", toBlock: "0x2" }]) > 0);
});

test("a repeat read inside the TTL does not reach the provider", async () => {
  clearRpcCache();
  let upstream = 0;
  const run = async () => {
    upstream += 1;
    return "0xresult";
  };

  const a = await withRpcCache("eth_call", [{ to: "0xabc", data: "0x01" }, "latest"], run);
  const b = await withRpcCache("eth_call", [{ to: "0xabc", data: "0x01" }, "latest"], run);

  assert.equal(a, "0xresult");
  assert.equal(b, "0xresult");
  assert.equal(upstream, 1, "second identical read must be served from cache");
});

test("different params are different entries", async () => {
  clearRpcCache();
  let upstream = 0;
  const run = async () => {
    upstream += 1;
    return `0x${upstream}`;
  };

  await withRpcCache("eth_call", [{ to: "0xabc", data: "0x01" }, "latest"], run);
  await withRpcCache("eth_call", [{ to: "0xabc", data: "0x02" }, "latest"], run);

  assert.equal(upstream, 2);
});

test("concurrent identical reads collapse into one upstream call", async () => {
  clearRpcCache();
  let upstream = 0;
  let release: (v: string) => void = () => {};
  const gate = new Promise<string>((r) => {
    release = r;
  });
  const run = async () => {
    upstream += 1;
    return gate;
  };

  const all = Promise.all(
    Array.from({ length: 10 }, () =>
      withRpcCache("eth_call", [{ to: "0xabc", data: "0x01" }, "latest"], run)
    )
  );
  release("0xshared");
  const results = await all;

  assert.equal(upstream, 1, "ten simultaneous readers must share one request");
  assert.deepEqual(new Set(results), new Set(["0xshared"]));
});

test("an empty result is not cached — an unmined receipt must not stick", async () => {
  clearRpcCache();
  let upstream = 0;
  const hash = `0x${"a".repeat(64)}`;
  const pendingThenMined = async () => {
    upstream += 1;
    return upstream === 1 ? null : { status: "0x1" };
  };

  const first = await withRpcCache("eth_getTransactionReceipt", [hash], pendingThenMined);
  const second = await withRpcCache("eth_getTransactionReceipt", [hash], pendingThenMined);

  assert.equal(first, null);
  assert.deepEqual(second, { status: "0x1" }, "must re-ask after a null receipt");
  assert.equal(upstream, 2);
});

test("a failed call is not cached", async () => {
  clearRpcCache();
  let upstream = 0;
  const failThenSucceed = async () => {
    upstream += 1;
    if (upstream === 1) throw new Error("boom");
    return "0xok";
  };

  await assert.rejects(
    withRpcCache("eth_call", [{ to: "0xabc", data: "0x09" }, "latest"], failThenSucceed)
  );
  const retry = await withRpcCache(
    "eth_call",
    [{ to: "0xabc", data: "0x09" }, "latest"],
    failThenSucceed
  );

  assert.equal(retry, "0xok");
  assert.equal(upstream, 2);
});

test("peek/put round-trip for the batch path, and peek never caches a write", () => {
  clearRpcCache();
  const params = [{ to: "0xdef", data: "0x77" }, "latest"];

  assert.equal(peekRpcCache("eth_call", params), undefined, "cold peek is a miss");
  putRpcCache("eth_call", params, "0xvalue");
  assert.equal(peekRpcCache("eth_call", params), "0xvalue");

  putRpcCache("eth_sendRawTransaction", ["0xsigned"], "0xtxhash");
  assert.equal(
    peekRpcCache("eth_sendRawTransaction", ["0xsigned"]),
    undefined,
    "a write must never become cacheable via put"
  );
});
