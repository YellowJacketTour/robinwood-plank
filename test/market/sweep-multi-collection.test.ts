import assert from "node:assert/strict";
import test from "node:test";
import { sweepForeignListingsMultiCollection } from "../../lib/market/multichain/trading/foreign-fulfill";

// Both guard checks in sweepForeignListingsMultiCollection run BEFORE any
// wallet/network call (connectedRouter), so these are real, unmocked
// assertions of the function's own fail-fast behavior -- not testing
// against a stub.

test("sweepForeignListingsMultiCollection rejects an empty specs array before touching the network", async () => {
  await assert.rejects(
    () => sweepForeignListingsMultiCollection({ chainSlug: "eth-mainnet", specs: [] }),
    /at least one collection is required/
  );
});

test("sweepForeignListingsMultiCollection rejects a request exceeding the real 50-item MAX_SWEEP_ITEMS cap before sending a doomed transaction", async () => {
  await assert.rejects(
    () =>
      sweepForeignListingsMultiCollection({
        chainSlug: "eth-mainnet",
        specs: [
          { collectionSlug: "collection-a", count: 30 },
          { collectionSlug: "collection-b", count: 25 },
        ],
      }),
    /capped at 50 items total/
  );
});

test("sweepForeignListingsMultiCollection does NOT reject a request exactly at the cap boundary on the client-side guard alone (50 total is allowed; only >50 is rejected)", async () => {
  // This will fail LATER (no wallet in a test environment), but it must
  // NOT fail with the "capped at 50" message -- proving the boundary is
  // > 50, not >= 50, matching the real contract's own `count > MAX_SWEEP_ITEMS`.
  await assert.rejects(
    () =>
      sweepForeignListingsMultiCollection({
        chainSlug: "eth-mainnet",
        specs: [
          { collectionSlug: "collection-a", count: 25 },
          { collectionSlug: "collection-b", count: 25 },
        ],
      }),
    (err: unknown) => err instanceof Error && !/capped at 50 items total/.test(err.message)
  );
});
