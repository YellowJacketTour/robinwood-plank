import assert from "node:assert/strict";
import test from "node:test";
import {
  shouldFetchJsonUriFallback,
  traitsFromAttributes,
} from "../../lib/market/multichain/discovery/solana-token-hydrate";
import { backfillTraitsFromJsonUri, JSON_URI_FALLBACK_PER_PAGE } from "../../lib/market/multichain/discovery/helius-rarity-index-runner";

/** AUDIT lens 4 #9 (Batch F9): Solana json_uri fallback when DAS attributes are empty. */

test("traitsFromAttributes: Metaplex attributes -> trait rows; non-scalar and blank types dropped", () => {
  assert.deepEqual(
    traitsFromAttributes([
      { trait_type: "Background", value: "Blue" },
      { trait_type: " Eyes ", value: 3 },
      { trait_type: "Rare", value: true },
      { trait_type: "", value: "x" },
      { trait_type: "Nested", value: { a: 1 } },
      { trait_type: "Blank", value: "   " },
      null,
      "junk",
    ]),
    [
      { traitType: "Background", value: "Blue" },
      { traitType: "Eyes", value: "3" },
      { traitType: "Rare", value: "true" },
    ]
  );
  assert.deepEqual(traitsFromAttributes(undefined), []);
  assert.deepEqual(traitsFromAttributes("nope"), []);
});

test("shouldFetchJsonUriFallback: only when DAS traits are empty AND a real pointer exists", () => {
  assert.equal(shouldFetchJsonUriFallback([], "https://arweave.net/abc"), true);
  assert.equal(shouldFetchJsonUriFallback([], "ar://abc"), true);
  assert.equal(shouldFetchJsonUriFallback([], "ipfs://Qm123"), true);
  assert.equal(shouldFetchJsonUriFallback([{ traitType: "A", value: "B" }], "https://arweave.net/abc"), false);
  assert.equal(shouldFetchJsonUriFallback([], ""), false);
  assert.equal(shouldFetchJsonUriFallback([], null), false);
  assert.equal(shouldFetchJsonUriFallback([], "javascript:alert(1)"), false);
});

test("backfillTraitsFromJsonUri: fills only trait-less assets, bounded per page, keeps DAS values when present", async () => {
  const asset = (id: string, attrs: Array<{ trait_type: string; value: string }> | undefined, jsonUri: string | null) => ({
    id,
    content: { json_uri: jsonUri, metadata: { name: id === "has-name" ? "DAS name" : null, attributes: attrs }, links: { image: null } },
  });
  const resolved: string[] = [];
  const resolve = async (uri: string | null | undefined) => {
    resolved.push(uri ?? "");
    if (uri === "https://meta/fail") return null;
    return { name: `off ${uri}`, imageUrl: `https://img/${uri?.split("/").pop()}`, traits: [{ traitType: "Hat", value: "Cap" }] };
  };
  const input = [
    asset("a", [], "https://meta/a"),
    asset("b", [{ trait_type: "X", value: "Y" }], "https://meta/b"),
    asset("c", undefined, null),
    asset("d", [], "https://meta/fail"),
    asset("has-name", [], "https://meta/e"),
  ];
  const { assets, attempted, filled } = await backfillTraitsFromJsonUri(input, { resolve, concurrency: 2 });
  assert.deepEqual(resolved.sort(), ["https://meta/a", "https://meta/e", "https://meta/fail"]);
  assert.equal(attempted, 3);
  assert.equal(filled, 2);
  assert.deepEqual(assets[0].content?.metadata?.attributes, [{ trait_type: "Hat", value: "Cap" }]);
  assert.equal(assets[0].content?.metadata?.name, "off https://meta/a");
  assert.equal(assets[0].content?.links?.image, "https://img/a");
  assert.deepEqual(assets[1].content?.metadata?.attributes, [{ trait_type: "X", value: "Y" }], "DAS traits are never overwritten");
  assert.equal(assets[2], input[2], "no pointer -> untouched");
  assert.equal(assets[3], input[3], "fetch failure -> untouched, not fabricated");
  assert.equal(assets[4].content?.metadata?.name, "DAS name", "DAS name wins over off-chain name");
  assert.equal(input[0].content?.metadata?.attributes?.length, 0, "input is not mutated");

  // Per-page bound.
  const many = Array.from({ length: JSON_URI_FALLBACK_PER_PAGE + 50 }, (_, i) => asset(String(i), [], `https://meta/${i}`));
  let n = 0;
  const bounded = await backfillTraitsFromJsonUri(many, { resolve: async () => { n += 1; return { name: null, imageUrl: null, traits: [] }; } });
  assert.equal(n, JSON_URI_FALLBACK_PER_PAGE);
  assert.equal(bounded.attempted, JSON_URI_FALLBACK_PER_PAGE);
  assert.equal(bounded.filled, 0, "an empty attributes array in the JSON is not a fill");
});
