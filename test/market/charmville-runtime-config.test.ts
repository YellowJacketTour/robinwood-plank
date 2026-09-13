import { test } from "node:test";
import assert from "node:assert/strict";
import { charmvilleRuntimePrefix } from "../../lib/charmville/runtime-config";

const env = { NODE_ENV: "production", CHARMVILLE_ACCESS_MODE: "private", CHARMVILLE_RUNTIME_READY: "1", CHARMVILLE_RUNTIME_RELEASE: "alpha01_2026-09-13" };
test("runtime release selection requires readiness and valid server admission mode", () => {
  assert.equal(charmvilleRuntimePrefix(env), "/charmville/runtime/alpha01_2026-09-13/");
  for (const ready of [undefined, "", "true", "0", "1 "]) assert.equal(charmvilleRuntimePrefix({ ...env, CHARMVILLE_RUNTIME_READY: ready }), null);
  for (const mode of [undefined, "public", "disabled", "local-development"]) assert.equal(charmvilleRuntimePrefix({ ...env, CHARMVILLE_ACCESS_MODE: mode }), null);
  assert.equal(charmvilleRuntimePrefix({ ...env, NODE_ENV: "development", CHARMVILLE_ACCESS_MODE: "local-development" }), "/charmville/runtime/alpha01_2026-09-13/");
});
test("runtime release IDs reject URLs traversal encoding whitespace and oversized values", () => {
  for (const release of [undefined, "", "../a", ".", "..", "/alpha", "//other.test/a", "https://other.test", "alpha/beta", "alpha\\beta", "a%2fb", "a?b", "a#b", "a.b", "a b", " a", "a\n", "-a", "_a", "a".repeat(97)])
    assert.equal(charmvilleRuntimePrefix({ ...env, CHARMVILLE_RUNTIME_RELEASE: release }), null, String(release));
  assert.equal(charmvilleRuntimePrefix({ ...env, CHARMVILLE_RUNTIME_RELEASE: "A".repeat(96) }), `/charmville/runtime/${"A".repeat(96)}/`);
});
