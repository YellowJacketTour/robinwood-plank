import { test } from "node:test";
import { ok, deepEqual } from "node:assert/strict";
import { readFileSync } from "node:fs";
import { assertLegalGap } from "../src/hose/gap.ts";

/**
 * THREE ALLOWLISTS, ONE TRUTH.
 *
 * A gap reason is gated in three independent places: the GapReason union, the
 * LEGAL_REASONS array in gap.ts, and a CHECK constraint in SQL. Nothing forced
 * them to agree, and they did not:
 *
 *   - SQL has permitted `epoch_backfill` since migration 104. Neither the type
 *     nor the runtime list ever contained it.
 *   - `incomplete_tx_walk` was added to the type and to SQL, but not to the
 *     runtime list.
 *
 * The second one failed LOUDLY in the log and SILENTLY in the data. Measured
 * live 2026-09-09: `repair ok 486, fail 23, "illegal gap reason
 * incomplete_tx_walk"`. Those 23 blocks were known to be partly-read, were
 * correctly denied coverage, and then lost their gap too -- so the archive had
 * neither a claim nor a to-do for them. Worse than either outcome alone.
 */

const GAP_SRC = readFileSync(new URL("../src/hose/gap.ts", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const TYPES_SRC = readFileSync(new URL("../src/shared/types.ts", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const MIGRATION = readFileSync(
  new URL("../../../deploy/inmotion/postgres/migrations/112_gap_reason_incomplete_tx_walk.sql", import.meta.url),
  "utf8",
).replace(/\r\n/g, "\n");

/** The reasons named in the latest CHECK constraint. */
function sqlReasons(): string[] {
  const at = MIGRATION.lastIndexOf("CHECK (reason IN (");
  ok(at > 0, "the migration must define the allowed set");
  const block = MIGRATION.slice(at, MIGRATION.indexOf("));", at));
  return [...block.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!).sort();
}

/** The reasons in gap.ts's runtime array. */
function runtimeReasons(): string[] {
  const at = GAP_SRC.indexOf("const LEGAL_REASONS: GapReason[] = [");
  ok(at > 0, "the runtime allowlist must exist");
  const block = GAP_SRC.slice(at, GAP_SRC.indexOf("];", at));
  return [...block.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]!).sort();
}

/** The members of the GapReason union. */
function typeReasons(): string[] {
  const at = TYPES_SRC.indexOf("export type GapReason =");
  ok(at > 0, "the union must exist");
  const block = TYPES_SRC.slice(at, TYPES_SRC.indexOf(";", at));
  return [...block.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]!).sort();
}

test("the SQL constraint and the runtime allowlist agree exactly", () => {
  deepEqual(
    runtimeReasons(),
    sqlReasons(),
    "a reason SQL accepts but the runtime rejects is thrown away; the reverse is a write that fails",
  );
});

test("the GapReason union and the runtime allowlist agree exactly", () => {
  deepEqual(
    typeReasons(),
    runtimeReasons(),
    "a union member missing from LEGAL_REASONS typechecks and then throws at runtime",
  );
});

test("both reasons that had drifted are now present everywhere", () => {
  for (const reason of ["epoch_backfill", "incomplete_tx_walk"]) {
    ok(sqlReasons().includes(reason), `SQL must allow ${reason}`);
    ok(runtimeReasons().includes(reason), `the runtime must allow ${reason}`);
    ok(typeReasons().includes(reason), `the union must contain ${reason}`);
  }
});

test("THE GUARD STILL FIRES for a reason nobody allows", () => {
  // Widening must not have turned the check into a rubber stamp.
  let threw = false;
  try {
    assertLegalGap("because_i_felt_like_it" as never, true);
  } catch {
    threw = true;
  }
  ok(threw, "an unknown reason must still be rejected");
});

test("incomplete_tx_walk needs no artifact, unlike attention_history", () => {
  // attention_history requires an artifact genesis; a truncated block does not
  // -- it is a range we reached and could not finish, not a subject we chose.
  assertLegalGap("incomplete_tx_walk" as never, false);
  let threw = false;
  try {
    assertLegalGap("attention_history" as never, false);
  } catch {
    threw = true;
  }
  ok(threw, "attention_history must still require an artifact");
});
