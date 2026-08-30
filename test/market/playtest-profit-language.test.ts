import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const source = readFileSync(new URL("../../public/arcade/crash.html", import.meta.url), "utf8");

test("a survived negative-net seat is never presented as a win", () => {
  assert.match(source, /const profitable = survived && net > 0n/);
  assert.match(source, /POOL DILUTED/);
  assert.match(source, /Exact settlement:/);
  assert.doesNotMatch(source, /const won = Boolean\(seat\?\.survived\)/);
});
