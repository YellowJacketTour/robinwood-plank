import assert from "node:assert/strict";
import test from "node:test";
import { isSpamCollectionTitle, looksLikeContractName } from "@/lib/market/collection-title";

test("BNB scan scam titles are not collections", () => {
  assert.equal(
    isSpamCollectionTitle(
      "** GC BUYING TRANSACTION - https://etherscan.io/tx/0xd44c9b380c89bd28a944da81d82eb1c31475f768ab1480d027d0068a3af41f15"
    ),
    true
  );
  assert.equal(isSpamCollectionTitle("this wallet belongs to world wide vandals: 19W3m2p3e2HxUydV7gujyDioAmhJ53RZ4F"), true);
  assert.equal(isSpamCollectionTitle("https://ordinals.gorillaPool.io/content/f1be"), true);
  assert.equal(isSpamCollectionTitle("Courtyard.io"), false);
  assert.equal(isSpamCollectionTitle("RobinWood"), false);
});

test("hex and ERC721 are contract names not titles", () => {
  assert.equal(looksLikeContractName("ERC721"), true);
  assert.equal(looksLikeContractName("0x6510eca56da79445cd5902e145c06a2e7b8ab361"), true);
  assert.equal(looksLikeContractName("0x000a…4dd4"), true);
  assert.equal(looksLikeContractName("_-l_"), true);
  assert.equal(looksLikeContractName("25125"), true);
  assert.equal(looksLikeContractName("Decentraland"), false);
  assert.equal(looksLikeContractName("RobinWood"), false);
});
