import { test } from "node:test";
import assert from "node:assert/strict";
import { runtimeDestination } from "../../app/charmville/world/runtime-destination";
import { NATIVE_RUNTIME_ORIGIN, NATIVE_RUNTIME_URL } from "../../app/charmville/world/native-runtime";

test("production has no implicit localhost fallback without a gated release", () => {
  assert.equal(runtimeDestination(false, null, "https://plank.love"), null);
  assert.equal(runtimeDestination(true, null, "https://plank.love"), null);
  assert.equal(runtimeDestination(false, null, "http://localhost:3017"), null);
  assert.deepEqual(runtimeDestination(true, null, "http://localhost:3017"), { origin: NATIVE_RUNTIME_ORIGIN, url: NATIVE_RUNTIME_URL, requiresSession: false });
});
test("protected runtime uses server-selected sameorigin release and requires boot", () => {
  const result = runtimeDestination(false, "/charmville/runtime/alpha01-r03/", "https://plank.love");
  assert.equal(result?.origin, "https://plank.love"); assert.equal(result?.requiresSession, true);
  assert.match(result?.url ?? "", /^\/charmville\/runtime\/alpha01-r03\/play\/\?test=/);
  assert.equal(new URL(result!.url, "https://plank.love").origin, "https://plank.love");
});
test("runtime routing rejects client URL injection and malformed page origins", () => {
  for (const prefix of ["https://other.test/", "//other.test/", "/charmville/runtime/../", "/charmville/runtime/a%2fb/", "/charmville/runtime/a/?x", "/charmville/runtime/a/evil/"])
    assert.equal(runtimeDestination(true, prefix, "http://localhost:3017"), null);
  for (const origin of ["", "null", "file:///tmp/game", "https://plank.love/path", "https://plank.love/"])
    assert.equal(runtimeDestination(false, "/charmville/runtime/alpha01/", origin), null);
});
