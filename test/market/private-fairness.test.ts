import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { simulationCrashBps } from "../../lib/playtest-room-core";
import { privateCrashBpsFromReveal, verifyPrivateRound } from "../../public/arcade/private-fairness.js";

test("browser verifier reproduces the authoritative private crash derivation", async () => {
  for (let index = 0; index < 128; index += 1) {
    const reveal = createHash("sha256").update(`plank-private-proof:${index}`).digest("hex");
    assert.equal(await privateCrashBpsFromReveal(reveal), simulationCrashBps(reveal));
  }
});

test("private proof validates commitment and crash result together", async () => {
  const reveal = createHash("sha256").update("settled-round").digest("hex");
  const commitment = createHash("sha256").update(reveal, "hex").digest("hex");
  const crashBps = simulationCrashBps(reveal).toString();
  assert.deepEqual(await verifyPrivateRound({ commitment, reveal, crashBps }), {
    verified: true,
    commitmentMatches: true,
    crashMatches: true,
    derivedCrashBps: BigInt(crashBps),
  });
  assert.equal((await verifyPrivateRound({ commitment: "0".repeat(64), reveal, crashBps })).verified, false);
  assert.equal((await verifyPrivateRound({ commitment, reveal, crashBps: (BigInt(crashBps) + 1n).toString() })).verified, false);
});

test("private verifier rejects malformed proof fields without throwing", async () => {
  assert.deepEqual(await verifyPrivateRound({ commitment: "bad", reveal: "bad", crashBps: "NaN" }), {
    verified: false,
    commitmentMatches: false,
    crashMatches: false,
    derivedCrashBps: null,
  });
});
