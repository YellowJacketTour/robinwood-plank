import assert from "node:assert/strict";
import test from "node:test";
import { looksLikeSolanaPubkey } from "@/lib/market/multichain/solana-pubkey";
import { lookupTraitCategory, lookupTraitCount } from "@/components/market/ForeignDetailsModal";

test("Magic Eden symbols are not Solana pubkeys (Claynosaurz must resolve via listings)", () => {
  assert.equal(looksLikeSolanaPubkey("Claynosaurz"), false);
  assert.equal(looksLikeSolanaPubkey("claynosaurz"), false);
  assert.equal(looksLikeSolanaPubkey("degods"), false);
  assert.equal(looksLikeSolanaPubkey("Dq4vxvvxMBJaZAKoBDrVuG9FCLfQXGe59PYVX2XdpcJm"), true);
});

test("trait % lookup is case-insensitive so Solana Edition vs EDITION still counts", () => {
  const counts = { Edition: { First: 10, Second: 90 } };
  const cat = lookupTraitCategory(counts, "EDITION");
  assert.ok(cat);
  assert.equal(lookupTraitCount(cat, "first"), 10);
});
