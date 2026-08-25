import { test } from "node:test";
import assert from "node:assert/strict";
import { toArchivalApiShape } from "../../lib/market/multichain/archival-ledger.ts";

test("toArchivalApiShape: null/undefined row -> null (never fabricated)", () => {
  assert.equal(toArchivalApiShape(null), null);
  assert.equal(toArchivalApiShape(undefined), null);
});

test("toArchivalApiShape: real supply_ratio row maps every field, coercing numeric-as-text pg values", () => {
  const shape = toArchivalApiShape({
    chain_slug: "eth-mainnet",
    collection_key: "0xf87e31492faf9a91b02ee0deaad50d51d56d5d4d",
    known_supply: "93643",
    tokens_ever_hydrated: "8001",
    archival_score: "0.0854",
    score_method: "supply_ratio",
    last_archived_at: new Date("2026-08-25T00:00:00Z"),
  });
  assert.deepEqual(shape, {
    archivalScore: 0.0854,
    scoreMethod: "supply_ratio",
    tokensEverHydrated: 8001,
    knownSupply: 93643,
    lastArchivedAt: "2026-08-25T00:00:00.000Z",
  });
});

test("toArchivalApiShape: unknown_supply row keeps archivalScore/knownSupply null -- never invents a percentage", () => {
  const shape = toArchivalApiShape({
    chain_slug: "eth-mainnet",
    collection_key: "somecollection",
    known_supply: null,
    tokens_ever_hydrated: "12",
    archival_score: null,
    score_method: "unknown_supply",
    last_archived_at: "2026-08-24T10:00:00.000Z",
  });
  assert.equal(shape?.archivalScore, null);
  assert.equal(shape?.knownSupply, null);
  assert.equal(shape?.scoreMethod, "unknown_supply");
  assert.equal(shape?.tokensEverHydrated, 12);
  assert.equal(shape?.lastArchivedAt, "2026-08-24T10:00:00.000Z");
});

test("toArchivalApiShape: null score_method column falls back to the honest 'unknown_supply' default, not a fabricated method", () => {
  const shape = toArchivalApiShape({
    chain_slug: "eth-mainnet",
    collection_key: "somecollection",
    known_supply: null,
    tokens_ever_hydrated: "0",
    archival_score: null,
    score_method: null,
    last_archived_at: null,
  });
  assert.equal(shape?.scoreMethod, "unknown_supply");
  assert.equal(shape?.lastArchivedAt, null);
});
