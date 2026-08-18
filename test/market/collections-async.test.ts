import assert from "node:assert/strict";
import test from "node:test";
import { getCollectionAsync } from "../../lib/market/collections-server";

test("getCollectionAsync resolves a curated slug (robinwood) without touching the DB", async () => {
  const collection = await getCollectionAsync("robinwood");
  assert.equal(collection?.slug, "robinwood");
});

test("getCollectionAsync returns undefined for a garbage slug that isn't a curated name AND isn't address-shaped -- fails closed, never throws", async () => {
  const collection = await getCollectionAsync("not-a-real-collection-or-address");
  assert.equal(collection, undefined);
});

test("getCollectionAsync returns undefined for an address-shaped slug with no matching row -- fails closed rather than fabricating a collection for an arbitrary address", async () => {
  // A real-shaped but almost-certainly-untracked address. If Postgres
  // isn't configured in this test environment, listTrackedCollections()
  // is expected to fail and getCollectionAsync catches that (see its own
  // `.catch(() => [])`), so this must resolve to undefined either way --
  // never throw, and never accept an address nobody has vetted.
  const collection = await getCollectionAsync("0x000000000000000000000000000000000000dead");
  assert.equal(collection, undefined);
});

test("getCollectionAsync rejects a malformed 'address' (wrong length / not hex) before ever touching the DB", async () => {
  const tooShort = await getCollectionAsync("0x1234");
  const notHex = await getCollectionAsync("0xZZZZ567890123456789012345678901234567890");
  assert.equal(tooShort, undefined);
  assert.equal(notHex, undefined);
});
