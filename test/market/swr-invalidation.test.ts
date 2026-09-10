import assert from "node:assert/strict";
import test from "node:test";
import { swrJson, invalidateSwr } from "../../lib/market/swr-fetch";

test("commit invalidation fences a late response from overwriting the fresh snapshot", async () => {
  const original = globalThis.fetch;
  let resolveOld!: (response: Response) => void;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    if (calls === 1) return new Promise<Response>((resolve) => { resolveOld = resolve; });
    return Response.json({ version: 2 });
  };
  try {
    const old = swrJson("/test/commit-fence", { session: false });
    invalidateSwr("/test/commit-fence");
    const fresh = swrJson("/test/commit-fence", { session: false });
    assert.equal(calls, 1, "invalidation must not start a competing request");
    resolveOld(Response.json({ version: 1 }));
    assert.deepEqual(await old, { version: 2 });
    assert.deepEqual(await fresh, { version: 2 });
    assert.deepEqual(await swrJson("/test/commit-fence", { session: false }), { version: 2 });
    assert.equal(calls, 2);
  } finally { globalThis.fetch = original; invalidateSwr("/test/"); }
});


test("unrelated invalidation does not prevent caching and concurrent cold callers share one fetch", async () => {
  const original = globalThis.fetch;
  let release!: (response: Response) => void;
  let calls = 0;
  globalThis.fetch = async () => { calls++; return new Promise<Response>((resolve) => { release = resolve; }); };
  try {
    const callers = Array.from({ length: 20 }, () => swrJson("/test/shared-cold", { session: true }));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls, 1);
    invalidateSwr("/test/some-other-collection");
    release(Response.json({ stored: true }));
    for (const data of await Promise.all(callers)) assert.deepEqual(data, { stored: true });
    assert.deepEqual(await swrJson("/test/shared-cold"), { stored: true });
    assert.equal(calls, 1, "unrelated commit must not discard this cache write");
  } finally { globalThis.fetch = original; invalidateSwr("/test/"); }
});
