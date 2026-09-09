import assert from "node:assert/strict";
import test from "node:test";
import { profileUrl, recordCollectionProfile, readCollectionProfile } from "../../lib/market/multichain/collection-profile";
import { closePostgres, hasPostgresConfig, postgresQuery } from "../../lib/postgres";

test("collection profile rejects executable and credential-bearing links", () => {
  for (const value of ["javascript:alert(1)", "data:text/html,hello", "https://user:secret@example.com", "bad url", null]) assert.equal(profileUrl(value), null);
  assert.equal(profileUrl("https://x.com/pudgypenguins"), "https://x.com/pudgypenguins");
});

test("concurrent profile sources preserve independent fields and omitted links", { skip: !hasPostgresConfig() }, async () => {
  const address = `0x${Date.now().toString(16).padStart(40, "d")}`;
  try {
    await Promise.all([
      recordCollectionProfile("eth-mainnet", address, { website: "https://example.com/" }, "first"),
      recordCollectionProfile("eth-mainnet", address, { twitter: "https://x.com/collection" }, "second"),
    ]);
    await recordCollectionProfile("eth-mainnet", address, { website: null, twitter: "javascript:void(0)", description: "Collection description" }, "third");
    const profile = await readCollectionProfile("eth-mainnet", address.toUpperCase().replace("0X", "0x"));
    assert.equal(profile?.website?.value, "https://example.com/");
    assert.equal(profile?.twitter?.source, "second");
    assert.equal(profile?.description?.value, "Collection description");
    assert.ok(Number.isFinite(Date.parse(profile!.website!.observedAt)));
  } finally {
    await postgresQuery("DELETE FROM plank_kv_hash_fields WHERE key_name=$1", [`plank:collection-profile:eth-mainnet:${address}`]);
    await closePostgres();
  }
});
