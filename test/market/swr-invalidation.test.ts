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
    assert.deepEqual(await swrJson("/test/commit-fence", { session: false }), { version: 2 });
    resolveOld(Response.json({ version: 1 }));
    await old;
    assert.deepEqual(await swrJson("/test/commit-fence", { session: false }), { version: 2 });
    assert.equal(calls, 2);
  } finally { globalThis.fetch = original; invalidateSwr("/test/"); }
});
