import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync("public/arcade/crash.html", "utf8");

test("normal long-poll timeouts preserve the shared room subscription", () => {
  assert.match(source, /if \(response\.status === 204\) continue;/);
  assert.doesNotMatch(source, /response\.status === 204 \|\| controller\.signal\.aborted\) return/);
});

test("the playtest has phone-safe portrait and landscape compositions", () => {
  assert.match(source, /100dvh/);
  assert.match(source, /env\(safe-area-inset-bottom\)/);
  assert.match(source, /min-height:48px/);
  assert.match(source, /orientation:landscape/);
  assert.match(source, /overscroll-behavior:contain/);
});
