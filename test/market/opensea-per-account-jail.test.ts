import assert from "node:assert/strict";
import test from "node:test";
import { hasPostgresConfig } from "../../lib/postgres";

/**
 * Real bug found live 2026-08-27 (external research, confirmed against
 * OpenSea's own current docs): the app's 7-key pool is 7 real, distinct
 * accounts that genuinely multiply the real 600/hr rate limit -- but a
 * real 429 on any ONE account durably jailed the bare source name
 * ("opensea-stats"), blocking all 7 accounts at once. Confirmed live:
 * jail timers for all 7 pool keys matched to the millisecond, which is
 * only possible if one shared jail was gating all of them. Root cause:
 * orderCandidates only ever checked the in-memory, per-PROCESS jail --
 * meaningless since mesh-lane.ts spawns a fresh process per job -- and
 * the only thing setting the DURABLE (cross-process) jail was a generic
 * catch block with no idea which real account had actually failed.
 *
 * This proves the fix end to end: jailing one specific real account
 * durably must never affect any other account's own selectability.
 */
test(
  "jailing one real OpenSea account does not jail the others",
  { skip: !hasPostgresConfig() },
  async () => {
    const { recordOpenSeaAccountFailure, pickOpenSeaKey, loadOpenSeaKeyPool } = await import(
      "../../lib/market/multichain/discovery/opensea-key-pool"
    );
    const pool = await loadOpenSeaKeyPool();
    if (pool.length < 2) {
      // Single-key deployments have nothing to isolate -- not a failure of
      // this fix, just nothing to prove here.
      return;
    }
    const target = pool[0].providerAccount;
    // pickOpenSeaKey (not reserveOpenSeaKey) deliberately: it exercises the
    // exact same orderCandidates filtering this fix touches, with none of
    // reserveOpenSeaKey's real 6.2s-per-key pacing delay -- a real jail
    // duration short enough to keep this test fast would otherwise expire
    // mid-loop under that pacing, which is a test-timing artifact, not
    // evidence the fix is wrong (confirmed live while writing this test).
    await recordOpenSeaAccountFailure(target, true, 30_000);

    const seen = new Set<string>();
    for (let i = 0; i < pool.length * 2; i++) {
      const picked = await pickOpenSeaKey("live");
      if (picked) seen.add(picked.providerAccount);
    }
    assert.ok(!seen.has(target), "the jailed account must never be selected while jailed");
    assert.ok(seen.size > 0, "at least one OTHER real account must still be selectable -- the jail must not be pool-wide");
  }
);
