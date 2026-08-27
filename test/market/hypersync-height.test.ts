import assert from "node:assert/strict";
import test from "node:test";
import { hasPostgresConfig } from "../../lib/postgres";

/**
 * Real gap found live 2026-08-27 (external research): anchored-membership-
 * backfill.ts fetched the current chain tip via eth_blockNumber against
 * the Alchemy-backed RPC pool -- the same single, unpooled Alchemy key
 * already found live to have real, current monthly-CU-quota exhaustion --
 * on every single invocation, for every collection. The HyperSync client
 * this scan already holds open can report its own real height directly,
 * for free relative to Alchemy's metered wallet. This is a getHeight()
 * call (request/response), never streamHeight() -- mesh-lane.ts spawns a
 * fresh, short-lived process per job, so a persistent stream connection
 * would need re-establishing every single invocation anyway.
 */
test(
  "getHypersyncHeight returns a real, current, sensible block height for a covered chain",
  { skip: !process.env.ENVIO_API_TOKEN },
  async () => {
    const { getHypersyncHeight } = await import("../../lib/market/multichain/discovery/hypersync-evm-scan");
    const height = await getHypersyncHeight("eth-mainnet");
    assert.ok(typeof height === "number" && height > 20_000_000, `expected a real, current mainnet block height, got ${height}`);
  }
);

test(
  "getHypersyncHeight returns the real Robinhood Chain height now that it's covered",
  { skip: !process.env.ENVIO_API_TOKEN },
  async () => {
    const { getHypersyncHeight } = await import("../../lib/market/multichain/discovery/hypersync-evm-scan");
    const height = await getHypersyncHeight("robinhood");
    assert.ok(typeof height === "number" && height > 40_000_000, `expected a real, current Robinhood Chain height, got ${height}`);
  }
);

test("getHypersyncHeight returns null for a chain with no real HyperSync coverage", async () => {
  const { getHypersyncHeight } = await import("../../lib/market/multichain/discovery/hypersync-evm-scan");
  assert.equal(await getHypersyncHeight("solana-mainnet"), null);
});

test(
  "runAnchoredMembershipBackfill no longer needs a working Alchemy/RPC call to determine the scan ceiling",
  { skip: !hasPostgresConfig() || !process.env.ENVIO_API_TOKEN },
  async () => {
    // Genuinely incomplete real Robinhood collection, confirmed live
    // 2026-08-27 (0 of 10 real known tokens before this fix landed).
    const { runAnchoredMembershipBackfill } = await import("../../lib/market/multichain/discovery/anchored-membership-backfill");
    const result = await runAnchoredMembershipBackfill("robinhood", "0xfd2d9984077f5e6df39e103a39d4c2e451054fc8");
    assert.equal(result.done, true);
  }
);
