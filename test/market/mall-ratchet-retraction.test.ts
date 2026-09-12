import assert from "node:assert/strict";
import test from "node:test";
import { monotone, observe, retract, maxFold } from "../../lib/market/multichain/monotone";

/**
 * THE REAL INCIDENT, REPLAYED.
 *
 * archival-ledger.ts's own comment records it (measured live 2026-09-08):
 *
 *   "Migration 106 cleared Friendship Bracelets' known_supply and set
 *    chain_confirmed = FALSE so a better value could be written -- which
 *    RE-ENABLED this branch, and an Art Blocks token id near 2,038,964
 *    immediately re-inflated known_supply to 2,000,343. The number came back
 *    LARGER than the 2,000,335 the migration had just cleared."
 *
 * Art Blocks encodes `tokenId = projectId * 1_000_000 + invocation`, so the
 * highest id observed is a statement about the whole shared CORE, never about
 * one project. The observation was real; the INFERENCE from it was wrong.
 *
 * The repair available at the time was to clear the field. That cannot work,
 * and the reason is mathematical rather than a coding slip: `max` has no
 * inverse. Clearing discards the high-water mark AND every observation that
 * justified it, so the next read re-observes the same poisoned source and the
 * value returns -- which is exactly what happened, larger.
 *
 * This file pins that the evidence-carrying fold makes the correct repair
 * expressible: withdraw the SOURCE, keep everything else, recompute.
 *
 * It does NOT replace the MALL_SUPPLY_RATIO guard. That guard encodes real
 * domain knowledge no generic algebra can infer (that a mall core's id space
 * says nothing about one project's supply). What this changes is that a wrong
 * observation can now be WITHDRAWN instead of being permanent -- so the guard
 * has a repair path behind it rather than being the only line of defence.
 */

/**
 * The real numbers from the incident.
 *
 * Note these are DIFFERENT quantities and must not be conflated: the ledger's
 * comment records BOTH an Art Blocks token id "near 2,038,964" (the poisoned
 * observation) and the known_supply values 2,000,335 -> 2,000,343 that the
 * inference path produced around it. The exact mapping between them runs
 * through the venue-supply cross-check in archival-ledger.ts and is not
 * reproduced here.
 *
 * What this file pins is the SHAPE -- clearing a non-invertible max cannot
 * repair it -- so the mall observation is modelled as a single poisoned source
 * whose own magnitude is what dominates. Inventing an arithmetic link between
 * the two would be asserting a mechanism I have not verified.
 */
const CLEARED_VALUE = 2_000_335;
const CAME_BACK_LARGER = 2_000_343;
/** The Art Blocks mall id that drove the re-inflation. */
const MALL_ID = 2_038_964;
/** What Friendship Bracelets' own venue supply actually supports. */
const REAL_PROJECT_SUPPLY = 721;

test("the incident's own numbers show clearing produced a LARGER value", () => {
  // The fact that makes "clear it and let a better value be written" provably
  // not a repair: what came back exceeded what was cleared.
  assert.ok(
    CAME_BACK_LARGER > CLEARED_VALUE,
    "measured live 2026-09-08: known_supply returned larger than the migration had just cleared"
  );
});

test("clearing the field cannot fix a non-invertible max -- the value returns", () => {
  // The shape the code had: a bare high-water mark, no evidence kept.
  let highWater: number | null = null;
  const seeMaxId = (id: number) => {
    if (highWater == null || id > highWater) highWater = id;
  };

  seeMaxId(REAL_PROJECT_SUPPLY);
  seeMaxId(MALL_ID);
  assert.equal(highWater, MALL_ID, "the mall id sets the high-water mark");

  // Migration 106: clear it so a better value can be written.
  highWater = null;
  // The source is still live. The very next read re-observes it.
  seeMaxId(MALL_ID);
  assert.equal(
    highWater,
    MALL_ID,
    "clearing without retracting re-inflates on the next read -- the 2026-09-08 shape"
  );
  assert.notEqual(
    highWater,
    REAL_PROJECT_SUPPLY,
    "and the real project evidence is unrecoverable, because it was never kept"
  );
});

test("retracting the poisoned SOURCE recovers the value the real evidence supports", () => {
  let supply = monotone(maxFold, [
    { source: "projected-tokens", value: REAL_PROJECT_SUPPLY },
    { source: "artblocks-core-max-id", value: MALL_ID },
  ]);
  assert.equal(supply.value, MALL_ID, "before retraction the mall id dominates");

  // The thing actually learned: "ids from the shared core do not describe this
  // project". Not "the number is wrong" -- the SOURCE is wrong.
  supply = retract(supply, maxFold, "artblocks-core-max-id");

  assert.equal(
    supply.value,
    REAL_PROJECT_SUPPLY,
    "the denominator falls back to real project evidence instead of staying at the mall high-water mark"
  );
});

test("the poisoned source re-observing after a retraction does NOT resurrect the old value silently", () => {
  let supply = monotone(maxFold, [
    { source: "projected-tokens", value: REAL_PROJECT_SUPPLY },
    { source: "artblocks-core-max-id", value: MALL_ID },
  ]);
  supply = retract(supply, maxFold, "artblocks-core-max-id");
  assert.equal(supply.value, REAL_PROJECT_SUPPLY);

  // A retraction is not a permanent ban -- if the same source speaks again it
  // is counted again. That is correct and must be explicit: the defence
  // against a KNOWN-bad source is the MALL_SUPPLY_RATIO guard refusing to
  // admit the observation, not the fold pretending it never happened.
  supply = observe(supply, maxFold, { source: "artblocks-core-max-id", value: MALL_ID });
  assert.equal(
    supply.value,
    MALL_ID,
    "re-observation is honest: suppression is the guard's job, not the fold's"
  );

  // And the guard's verdict is expressible as a retraction, repeatably.
  supply = retract(supply, maxFold, "artblocks-core-max-id");
  assert.equal(supply.value, REAL_PROJECT_SUPPLY, "the repair is available every time, not once");
});

test("a supply with no evidence is null, so the UI renders unknown rather than a confident wrong number", () => {
  let supply = monotone(maxFold, [{ source: "artblocks-core-max-id", value: MALL_ID }]);
  supply = retract(supply, maxFold, "artblocks-core-max-id");
  assert.equal(
    supply.value,
    null,
    "archival-ledger.ts's own rule: an unknown supply renders as 'unknown_supply' with no percentage, " +
      "which is strictly better than a confident 2%"
  );
  assert.notEqual(supply.value, 0, "a fabricated zero would divide into a 100% coverage claim");
});
