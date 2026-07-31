import assert from "node:assert/strict";
import test from "node:test";

import { cuForMethod } from "../../lib/market/rpc-meter";

/**
 * The ownership index exists to stop provider spend scaling with the number of
 * DISTINCT tokens visitors look at. Its failure modes are worse than the spend
 * it saves, so these pin the safety rules first:
 *
 *   - it must never be given a TTL (migrations 002/003 exist because expiring a
 *     last-known-good snapshot blanks the UI during the outage it exists for);
 *   - "unknown owner" must never be storable as "no owner";
 *   - it must never be treated as authoritative for a security decision.
 */

test("collection-wide owner read is cheaper than per-token ownerOf", () => {
  const COLLECTION_SIZE = 1542;
  const perToken = cuForMethod("eth_call") * COLLECTION_SIZE;
  const collectionWide = cuForMethod("alchemy_getOwnersForContract");

  assert.equal(collectionWide, 600, "getOwnersForContract is 600 CU");
  assert.equal(perToken, 40_092, "1,542 x ownerOf is ~40k CU");
  assert.ok(
    collectionWide * 60 < perToken,
    "the whole point: one collection call must beat the fan-out by a wide margin"
  );
});

test("Alchemy NFT endpoints are metered, not treated as free", () => {
  // An unpriced method silently falls back to the 26 CU default, which would
  // under-report a 600 CU call by 23x and make a migration to the NFT API look
  // like a saving it is not.
  for (const [method, expected] of [
    ["alchemy_getOwnersForContract", 600],
    ["alchemy_getNFTsForOwner", 480],
    ["alchemy_getNFTsForContract", 600],
    ["alchemy_getNFTMetadata", 80],
  ] as const) {
    assert.equal(cuForMethod(method), expected, `${method} must be priced`);
  }
});

test("the owner index is never written with a TTL", async () => {
  // Guards the migration-003 rule at the source rather than in SQL: a future
  // edit adding `{ ex: ... }` here would silently reintroduce the exact bug
  // that blanked every sale surface for a week.
  const fs = await import("node:fs/promises");
  const source = await fs.readFile(
    new URL("../../lib/market/owner-index.ts", import.meta.url),
    "utf8"
  );
  const setCall = source.match(/kv\.set\([^)]*\)/s);
  assert.ok(setCall, "expected a kv.set call");
  assert.ok(
    !/\bex\s*:/.test(setCall[0]),
    "owner index snapshot must not carry an expiry — it is last-known-good, not a cache"
  );
});

test("owner index module does not fall back to per-token RPC", async () => {
  const fs = await import("node:fs/promises");
  const source = await fs.readFile(
    new URL("../../lib/market/alchemy-nft.ts", import.meta.url),
    "utf8"
  );
  // 0x6352211e is ownerOf(uint256). Reintroducing it here would rebuild the
  // fan-out this module was written to delete.
  assert.ok(
    !source.includes("6352211e"),
    "alchemy-nft must not issue per-token ownerOf calls"
  );
  assert.ok(
    !/from "@\/lib\/market\/fetch-rpc"/.test(source),
    "alchemy-nft must not reach for the JSON-RPC path"
  );
});

test("aggregator data is documented as non-authoritative", async () => {
  const fs = await import("node:fs/promises");
  for (const file of ["alchemy-nft.ts", "owner-index.ts"]) {
    const source = await fs.readFile(
      new URL(`../../lib/market/${file}`, import.meta.url),
      "utf8"
    );
    assert.match(
      source,
      /SERVER_RPC_URLS|authoritative/i,
      `${file} must state that ownership decisions stay on the authoritative RPC path`
    );
  }
});

test("order validation still reads ownerOf on chain, not the index", async () => {
  const fs = await import("node:fs/promises");
  const source = await fs.readFile(
    new URL("../../app/api/market/orders/route.ts", import.meta.url),
    "utf8"
  );
  // The listing owner check gates whether a listing is real. It must never be
  // served from a cached aggregator index.
  assert.ok(
    source.includes("0x6352211e"),
    "ownsToken must still perform a real ownerOf call"
  );
  assert.ok(
    !source.includes("owner-index"),
    "order validation must not consult the display-only ownership index"
  );
});
