import assert from "node:assert/strict";
import test from "node:test";
import { Interface } from "ethers";
import { decodePunkOffer, isPublicCryptoPunkAsk } from "../../lib/market/multichain/native-market-adapters/cryptopunks";

const iface = new Interface(["function punksOfferedForSale(uint256) view returns (bool,uint256,address,uint256,address)"]);

test("decodes a live CryptoPunks native listing exactly", () => {
  const encoded = iface.encodeFunctionResult("punksOfferedForSale", [true, 7804, "0x1111111111111111111111111111111111111111", 123n, "0x0000000000000000000000000000000000000000"]);
  assert.deepEqual(decodePunkOffer(7804, true, encoded), {
    tokenId: "7804", seller: "0x1111111111111111111111111111111111111111", minValue: "123", onlySellTo: "0x0000000000000000000000000000000000000000",
  });
});

test("rejects inactive, failed, and mismatched slots", () => {
  const inactive = iface.encodeFunctionResult("punksOfferedForSale", [false, 7, "0x1111111111111111111111111111111111111111", 0n, "0x0000000000000000000000000000000000000000"]);
  const mismatch = iface.encodeFunctionResult("punksOfferedForSale", [true, 8, "0x1111111111111111111111111111111111111111", 1n, "0x0000000000000000000000000000000000000000"]);
  assert.equal(decodePunkOffer(7, true, inactive), null);
  assert.equal(decodePunkOffer(7, false, mismatch), null);
  assert.equal(decodePunkOffer(7, true, mismatch), null);
});

test("only positive unrestricted asks enter the public CryptoPunks book", () => {
  const base = { tokenId: "1", seller: "0x1111111111111111111111111111111111111111" };
  assert.equal(isPublicCryptoPunkAsk({ ...base, minValue: "1", onlySellTo: "0x0000000000000000000000000000000000000000" }), true);
  assert.equal(isPublicCryptoPunkAsk({ ...base, minValue: "0", onlySellTo: "0x0000000000000000000000000000000000000000" }), false);
  assert.equal(isPublicCryptoPunkAsk({ ...base, minValue: "1", onlySellTo: "0x2222222222222222222222222222222222222222" }), false);
});
