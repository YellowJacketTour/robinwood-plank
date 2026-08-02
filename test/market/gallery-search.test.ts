import test from "node:test";
import assert from "node:assert/strict";
import {
  buildGallerySearchIndex,
  isAddressLikeQuery,
  matchesGalleryQuery,
} from "../../lib/gallery-search";

function idx(input: Parameters<typeof buildGallerySearchIndex>[0]) {
  return buildGallerySearchIndex(input);
}

function matches(
  query: string,
  index: ReturnType<typeof buildGallerySearchIndex>,
  tokenId: number,
) {
  return matchesGalleryQuery(query, index.searchText, index.words, index.owner, tokenId);
}

const holoYes = idx({
  tokenId: 42,
  name: "Plank #42",
  attributes: [
    { trait_type: "Base", value: "Oak" },
    { trait_type: "Background", value: "Rare" },
    { trait_type: "Holographic", value: "Yes" },
  ],
});
const holoNo = idx({
  tokenId: 43,
  name: "Plank #43",
  attributes: [
    { trait_type: "Base", value: "Pine" },
    { trait_type: "Background", value: "Rare" },
    { trait_type: "Holographic", value: "No" },
  ],
});

test("'holo' only matches tokens whose Holographic value is Yes, not every token that carries the trait", () => {
  // Every token carries a Holographic attribute (Yes or No) — before the fix,
  // the bare trait_type name "Holographic" was indexed unconditionally, so
  // "holo" prefix-matched it regardless of value and returned the whole
  // collection instead of just the foil pieces.
  assert.equal(matches("holo", holoYes, 42), true);
  assert.equal(matches("holo", holoNo, 43), false);
  assert.equal(matches("holographic", holoNo, 43), false);
  // "foil" is an explicit community synonym added alongside "holo".
  assert.equal(matches("foil", holoYes, 42), true);
});

test("multi-term queries AND together and actually narrow", () => {
  // "rare holo" should behave like two separate constraints, not fail
  // outright on the second word.
  assert.equal(matches("rare holo", holoYes, 42), true);
  assert.equal(matches("rare holo", holoNo, 43), false);
  // Order doesn't matter.
  assert.equal(matches("holo rare", holoYes, 42), true);
  // A third, unrelated term correctly drops the match.
  assert.equal(matches("rare holo maple", holoYes, 42), false);
});

test("a numeric query is an exact token-id match, not a substring/fuzzy one", () => {
  const t234 = idx({ tokenId: 234, name: "Plank #234", attributes: [] });
  const t1234 = idx({ tokenId: 1234, name: "Plank #1234", attributes: [] });
  const t12340 = idx({ tokenId: 12340, name: "Plank #12340", attributes: [] });

  // Before the fix: "1234" fuzzy-matched #234 (edit distance 1) and
  // substring-matched #12340 (which contains "1234"). Both were wrong.
  assert.equal(matches("1234", t234, 234), false);
  assert.equal(matches("1234", t1234, 1234), true);
  assert.equal(matches("1234", t12340, 12340), false);

  // The "#id" form the placeholder advertises behaves the same way.
  assert.equal(matches("#1234", t234, 234), false);
  assert.equal(matches("#1234", t1234, 1234), true);
});

test("a numeric query never matches purely by coincidental overlap with an owner's hex address", () => {
  const owned = idx({
    tokenId: 900,
    name: "Plank #900",
    attributes: [{ trait_type: "Base", value: "Oak" }],
    owner: "0xaaaa1234bbbbccccddddeeeeffff00001111bbbb",
  });

  // Before the fix, a bare decimal query qualified as "address-like" (digits
  // are a subset of hex), so "1234" matched any owner whose address happened
  // to contain that digit run anywhere — nothing to do with the id or the
  // owner actually being searched for.
  assert.equal(matches("1234", owned, 900), false);

  // A real vanity/hex fragment (has a–f letters) still correctly matches the
  // owner — the fix only excludes pure decimal runs, not genuine hex.
  assert.equal(matches("aaaa1234", owned, 900), true);
  assert.equal(isAddressLikeQuery("aaaa1234"), true);
  assert.equal(isAddressLikeQuery("1234"), false);
});

test("a blank query matches everything, not nothing", () => {
  assert.equal(matches("", holoYes, 42), true);
  assert.equal(matches("   ", holoYes, 42), true);
});

test("trait words remain fuzzy/prefix tolerant (unlike numeric id terms)", () => {
  // A typo in a trait word should still be forgiving — only the id path was
  // tightened, not general trait search.
  assert.equal(matches("rar", holoYes, 42), true); // prefix
  assert.equal(matches("holograpic", holoYes, 42), true); // one-letter typo
});
