import assert from "node:assert/strict";
import test from "node:test";
import { decryptXCredential, encryptXCredential } from "../../integrations/plankspace-app/app/x/crypto";

const key = Buffer.alloc(32, 7).toString("base64");
test("X credentials use randomized authenticated encryption", () => {
  const first = encryptXCredential("secret-token", key), second = encryptXCredential("secret-token", key);
  assert.notEqual(first, second);
  assert.equal(decryptXCredential(first, key), "secret-token");
  // Flip a character in the middle of the ciphertext. The old tamper replaced
  // the LAST base64 character with "x", which is a no-op whenever that
  // character's low padding bits already match -- a ~1/64 CI flake
  // ("Missing expected exception", seen 2026-09-06).
  const mid = Math.floor(first.length / 2);
  const flipped = `${first.slice(0, mid)}${first[mid] === "A" ? "B" : "A"}${first.slice(mid + 1)}`;
  assert.throws(() => decryptXCredential(flipped, key));
});

test("X credential encryption rejects missing or invalid keys", () => {
  assert.throws(() => encryptXCredential("secret", ""), /32-byte base64/i);
});
