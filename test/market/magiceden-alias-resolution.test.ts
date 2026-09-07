import assert from "node:assert/strict";
import test from "node:test";
import { resolveMagicEdenAliasForCollection } from "../../lib/market/multichain/adapters/helius-solana";
import { coingeckoIdCandidatesForNonEvm } from "../../lib/market/multichain/discovery/coingecko-nft-stats";

/**
 * AUDIT lens 1 #7 (Batch E4): a Helius row's Magic Eden symbol is resolved
 * from real data only -- one DAS member mint -> ME /v2/tokens/{mint} ->
 * its `collection` field. Both the DAS step and HTTP are injected here.
 */
const COLLECTION = "CoLLeCtion1111111111111111111111111111111111";
const MINT = "MiNt11111111111111111111111111111111111111111";

function stubFetch(handler: (url: string) => { status: number; body?: unknown }): typeof fetch & { calls: string[] } {
  const calls: string[] = [];
  const f = (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    const r = handler(url);
    return new Response(r.body === undefined ? null : JSON.stringify(r.body), { status: r.status, headers: { "content-type": "application/json" } });
  }) as typeof fetch & { calls: string[] };
  f.calls = calls;
  return f;
}

test("resolves the ME symbol from the member token's collection field", async () => {
  const fetchImpl = stubFetch(() => ({ status: 200, body: { mintAddress: MINT, collection: "  degods " } }));
  const alias = await resolveMagicEdenAliasForCollection(COLLECTION, { firstMember: async () => MINT, fetchImpl });
  assert.equal(alias, "degods");
  assert.equal(fetchImpl.calls.length, 1);
  assert.ok(fetchImpl.calls[0].endsWith(`/v2/tokens/${MINT}`), fetchImpl.calls[0]);
});

test("no DAS member (or a DAS failure) -> null without any ME call", async () => {
  const fetchImpl = stubFetch(() => ({ status: 200, body: { collection: "never-used" } }));
  assert.equal(await resolveMagicEdenAliasForCollection(COLLECTION, { firstMember: async () => null, fetchImpl }), null);
  assert.equal(
    await resolveMagicEdenAliasForCollection(COLLECTION, {
      firstMember: async () => {
        throw new Error("DAS pool exhausted");
      },
      fetchImpl,
    }),
    null
  );
  assert.equal(fetchImpl.calls.length, 0, "the ME lookup must not run without a real member mint");
});

test("ME 404/400 -> null (negative-cacheable); missing/empty collection field -> null; never a name guess", async () => {
  const member = async () => MINT;
  assert.equal(await resolveMagicEdenAliasForCollection(COLLECTION, { firstMember: member, fetchImpl: stubFetch(() => ({ status: 404 })) }), null);
  assert.equal(await resolveMagicEdenAliasForCollection(COLLECTION, { firstMember: member, fetchImpl: stubFetch(() => ({ status: 400 })) }), null);
  assert.equal(await resolveMagicEdenAliasForCollection(COLLECTION, { firstMember: member, fetchImpl: stubFetch(() => ({ status: 200, body: { name: "DeGods #1" } })) }), null);
  assert.equal(await resolveMagicEdenAliasForCollection(COLLECTION, { firstMember: member, fetchImpl: stubFetch(() => ({ status: 200, body: { collection: "   " } })) }), null);
});

test("ME 429/5xx throws so the lane can jail the source instead of negative-caching a rate limit", async () => {
  const member = async () => MINT;
  await assert.rejects(() => resolveMagicEdenAliasForCollection(COLLECTION, { firstMember: member, fetchImpl: stubFetch(() => ({ status: 429 })) }), /429/);
  await assert.rejects(() => resolveMagicEdenAliasForCollection(COLLECTION, { firstMember: member, fetchImpl: stubFetch(() => ({ status: 503 })) }), /503/);
});

test("coingeckoIdCandidatesForNonEvm: alias first, mint addresses never, slug keys kept, no duplicates", () => {
  assert.deepEqual(coingeckoIdCandidatesForNonEvm({ contractAddress: COLLECTION, aliasSymbol: "DeGods" }), ["degods"]);
  assert.deepEqual(coingeckoIdCandidatesForNonEvm({ contractAddress: COLLECTION, aliasSymbol: null }), [], "a bare mint address is never a CG id");
  assert.deepEqual(coingeckoIdCandidatesForNonEvm({ contractAddress: "bitcoin-frogs", aliasSymbol: null }), ["bitcoin-frogs"]);
  assert.deepEqual(coingeckoIdCandidatesForNonEvm({ contractAddress: "Bitcoin-Frogs", aliasSymbol: "bitcoin-frogs" }), ["bitcoin-frogs"]);
});
