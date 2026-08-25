import assert from "node:assert/strict";
import test from "node:test";
import { ordNetSatsToPriceWei, resolveOrdNetCollectionSlug } from "../../lib/market/multichain/adapters/ordnet-shared";

test("ORD.NET sat prices preserve exact BTC units", () => {
  assert.equal(ordNetSatsToPriceWei(1), "10000000000");
  assert.equal(ordNetSatsToPriceWei(100_000_000), "1000000000000000000");
});

test("ORD.NET collection identity mapping is explicit", () => {
  const before = process.env.ORDNET_COLLECTION_SLUG_MAP;
  process.env.ORDNET_COLLECTION_SLUG_MAP = JSON.stringify({ canonical: "venue-slug" });
  try {
    assert.equal(resolveOrdNetCollectionSlug("canonical"), "venue-slug");
    assert.equal(resolveOrdNetCollectionSlug("untouched"), "untouched");
  } finally {
    if (before === undefined) delete process.env.ORDNET_COLLECTION_SLUG_MAP;
    else process.env.ORDNET_COLLECTION_SLUG_MAP = before;
  }
});
