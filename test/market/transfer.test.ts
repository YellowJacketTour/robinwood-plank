import assert from "node:assert/strict";
import test from "node:test";
import { validateRecipient } from "../../lib/market/transfer";

const SENDER = "0x9819000000000000000000000000000000000000";
const OTHER = "0x1b29111111111111111111111111111111111111";

test("validateRecipient accepts and checksums a well-formed different address", () => {
  const out = validateRecipient(OTHER.toLowerCase(), SENDER);
  assert.equal(out.toLowerCase(), OTHER.toLowerCase());
});

test("validateRecipient rejects a malformed address rather than guessing", () => {
  assert.throws(() => validateRecipient("not-an-address", SENDER), /valid wallet address/i);
  assert.throws(() => validateRecipient("0x123", SENDER), /valid wallet address/i);
});

test("validateRecipient rejects the zero address — that's a burn, not a send", () => {
  assert.throws(
    () => validateRecipient("0x0000000000000000000000000000000000000000", SENDER),
    /zero address/i
  );
});

test("validateRecipient rejects sending to yourself, case-insensitively", () => {
  assert.throws(() => validateRecipient(SENDER, SENDER), /same as your own wallet/i);
  assert.throws(() => validateRecipient(SENDER.toLowerCase(), SENDER), /same as your own wallet/i);
  assert.throws(() => validateRecipient(SENDER.toUpperCase().replace("0X", "0x"), SENDER), /same as your own wallet/i);
});

test("validateRecipient trims surrounding whitespace before validating", () => {
  const out = validateRecipient(`  ${OTHER}  `, SENDER);
  assert.equal(out.toLowerCase(), OTHER.toLowerCase());
});
