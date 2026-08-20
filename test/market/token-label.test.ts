import assert from "node:assert/strict";
import test from "node:test";
import { displayTokenLabel, looksLikeRawTokenId, shortTokenId } from "@/lib/market/token-label";

test("Solana mint is not a display name", () => {
  const mint = "Dq4vxvvxMBJaZAKoBDrVuG9FCLfQXGe59PYVX2XdpcJm";
  assert.equal(looksLikeRawTokenId(mint), true);
  assert.equal(displayTokenLabel({ tokenId: mint, tokenName: "Claynosaur #4122" }), "Claynosaur #4122");
  assert.equal(displayTokenLabel({ tokenId: mint }), shortTokenId(mint));
  assert.equal(displayTokenLabel({ tokenId: mint, rarityName: mint }), shortTokenId(mint));
});
