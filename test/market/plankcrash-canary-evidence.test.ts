import assert from "node:assert/strict";
import test from "node:test";
import { canonicalJson, normalizeAddresses, receiptGas } from "../../scripts/lib/testnet-canary-evidence.js";

const addresses = {
  crash: "0x0000000000000000000000000000000000000001",
  bank: "0x0000000000000000000000000000000000000002",
  fuelBooster: "0x0000000000000000000000000000000000000003",
  progression: "0x0000000000000000000000000000000000000004",
  powerboard: "0x0000000000000000000000000000000000000005",
  beacon: "0x0000000000000000000000000000000000000006",
};

test("canonicalJson is stable across insertion order", () => {
  assert.equal(canonicalJson({ z: 1, a: { d: 2, c: 3 } }), canonicalJson({ a: { c: 3, d: 2 }, z: 1 }));
});

test("normalizeAddresses rejects missing, invalid, and duplicate contracts", () => {
  assert.deepEqual(normalizeAddresses(addresses), addresses);
  assert.throws(() => normalizeAddresses({ ...addresses, crash: "not-an-address" }), /Invalid or missing crash/);
  assert.throws(() => normalizeAddresses({ ...addresses, crash: addresses.bank }), /must be distinct/);
});

test("receiptGas records exact bigint cost without number coercion", () => {
  assert.deepEqual(receiptGas(123_456n, 78_901n), {
    gasUsed: "123456",
    effectiveGasPriceWei: "78901",
    totalGasCostWei: "9740801856",
  });
});
