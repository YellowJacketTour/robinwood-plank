import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const source = readFileSync(new URL("../../public/arcade/crash.html", import.meta.url), "utf8");

test("a survived negative-net seat is never presented as a win", () => {
  assert.match(source, /const profitable = survived && net > 0n/);
  // A survived seat that lost money must still read as a loss. The headline
  // now leads with the REALIZED return (payout ÷ stake), which is < 1.00x in
  // exactly that case, and names the lock multiplier only as context — the
  // lock is claim weight, not a payout multiple.
  assert.match(source, /RETURNED · LOCKED \$\{locked\}×/);
  assert.match(source, /const realized = seat && BigInt\(seat\.stake/);
  assert.match(source, /Exact settlement:/);
  assert.doesNotMatch(source, /const won = Boolean\(seat\?\.survived\)/);
});
