import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

/**
 * Firehose invariants (SPEC-HOSE-FIREHOSE-2026-09-08).
 *
 * Two properties are TRUE TODAY and must not silently regress while `hose`
 * is being built. Both were verified by hand on 2026-09-08; these tests
 * are what stop the next refactor from undoing them.
 */

test("the OpenSea Stream is a courier hint -- it may never create a collection", () => {
  const src = readFileSync("lib/market/multichain/edge/opensea-stream.ts", "utf8");
  // A venue feed tells us what OpenSea saw, not what the chain did. If it
  // could register collections, a venue outage would become a gap in
  // EXISTENCE rather than a gap in one feed -- and a venue could inject
  // artifacts we never observed on-chain.
  assert.equal(
    /upsertTrackedCollection/.test(src),
    false,
    "opensea-stream must not call upsertTrackedCollection: existence comes from the chain, not a venue"
  );
  assert.equal(
    /INSERT\s+INTO\s+plank_multichain_collections/i.test(src),
    false,
    "opensea-stream must not insert collections directly"
  );
});

test("EVM discovery scans by topic across a block range, never by an address list", () => {
  const src = readFileSync("lib/market/multichain/discovery/hypersync-evm-scan.ts", "utf8");

  // Discovery must ask "what NFT transfers happened in these blocks", never
  // "what happened to these known contracts" -- the latter is the catalog
  // we are trying not to need, and it cannot find a collection we have not
  // already heard of.
  const discoveryQueries = [...src.matchAll(/logs:\s*\[\{\s*topics:/g)];
  assert.ok(
    discoveryQueries.length >= 1,
    "expected at least one topic-only (address-free) discovery query"
  );

  // Address-scoped queries ARE allowed, but only for per-collection work on
  // a genesis we already know: earliest-transfer lookup and membership
  // backfill. Any NEW address-filtered call site needs review against the
  // spec, so pin the count.
  const addressScoped = [...src.matchAll(/logs:\s*\[\{\s*address:/g)];
  assert.equal(
    addressScoped.length,
    2,
    "exactly two address-scoped scans are sanctioned (findEarliestTransferBlock, runAddressScopedMembershipScan); a new one must be justified against SPEC-HOSE-FIREHOSE"
  );
});
