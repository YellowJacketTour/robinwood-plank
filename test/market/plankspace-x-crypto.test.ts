import assert from "node:assert/strict";
import test from "node:test";
import { decryptXCredential, encryptXCredential } from "../../integrations/plankspace-app/app/x/crypto";

const key = Buffer.alloc(32, 7).toString("base64");
test("X credentials use randomized authenticated encryption", () => {
  const first = encryptXCredential("secret-token", key), second = encryptXCredential("secret-token", key);
  assert.notEqual(first, second);
  assert.equal(decryptXCredential(first, key), "secret-token");
  assert.throws(() => decryptXCredential(`${first.slice(0, -1)}x`, key));
});

test("X credential encryption rejects missing or invalid keys", () => {
  assert.throws(() => encryptXCredential("secret", ""), /32-byte base64/i);
});
