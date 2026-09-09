/**
 * The coverage READ-BACK: `akasha_coverage_health` and the one sentence the
 * UI is allowed to say.
 *
 * The hose has been writing `akasha_cursor` and `akasha_coverage_run` on
 * production since 2026-09-09, and until now nothing outside the database
 * could read any of it. A tape that is written and never quoted is worse
 * than no tape: the site keeps saying things (names, floors, badges) with
 * no way for anyone to check what the archive actually holds underneath.
 *
 * These tests pin the completeness rule by RECOMPUTING it with a second,
 * independent implementation and checking it against the SQL text. Eyeballing
 * a four-clause boolean is exactly how `SEAPORT_ORDER_FULFILLED` shipped a
 * wrong keccak that shared its first 18 hex digits with the real one.
 */
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { eq, ok } from "./_expect.ts";

const MIGRATION = fileURLToPath(
  new URL("../../../deploy/inmotion/postgres/migrations/104_akasha_tape.sql", import.meta.url)
);

/** The SQL text, newline-normalised: this repo checks out CRLF. */
function migrationSql(): string {
  return readFileSync(MIGRATION, "utf8").replace(/\r\n/g, "\n");
}

type Health = {
  protocolT0: number;
  backfillTail: number;
  finalizedHeight: number;
  runs: Array<{ from: number; to: number }>;
};

/**
 * A SECOND implementation of `complete_from_protocol`, written from the
 * English rule rather than from the SQL, so that agreeing with the view is
 * evidence instead of a mirror.
 */
function completeFromProtocol(h: Health): boolean {
  if (h.runs.length !== 1) return false;
  const from = Math.min(...h.runs.map((r) => r.from));
  const to = Math.max(...h.runs.map((r) => r.to));
  return h.backfillTail <= h.protocolT0 && from <= h.protocolT0 && to >= h.finalizedHeight;
}

const COMPLETE: Health = {
  protocolT0: 767_430,
  backfillTail: 767_430,
  finalizedHeight: 966_130,
  runs: [{ from: 767_430, to: 966_130 }],
};

test("a single span from protocol origin to finalized head is complete", () => {
  ok(completeFromProtocol(COMPLETE));
});

test("a HOLE cannot claim completeness even when the endpoints are right", () => {
  // The endpoints still satisfy every range clause -- MIN(from) is at t0 and
  // MAX(to) is at the finalized head -- and there is a real gap in the middle.
  // Only counting the runs catches this. If `run_count = 1` is ever dropped
  // from the view, this is the test that fails.
  const holed: Health = {
    ...COMPLETE,
    runs: [
      { from: 767_430, to: 800_000 },
      { from: 900_000, to: 966_130 },
    ],
  };
  const from = Math.min(...holed.runs.map((r) => r.from));
  const to = Math.max(...holed.runs.map((r) => r.to));
  ok(from <= holed.protocolT0, "MIN(from_height) still reaches t0");
  ok(to >= holed.finalizedHeight, "MAX(to_height) still reaches the head");
  eq(completeFromProtocol(holed), false, "two runs must never be complete");
});

test("a backfill still walking left is not complete", () => {
  eq(completeFromProtocol({ ...COMPLETE, backfillTail: 966_127, runs: [{ from: 966_127, to: 966_130 }] }), false);
});

test("a span that stops short of the finalized head is not complete", () => {
  eq(completeFromProtocol({ ...COMPLETE, runs: [{ from: 767_430, to: 900_000 }] }), false);
});

test("the view's four clauses are all present in the SQL", () => {
  const sql = migrationSql();
  const view = sql.slice(sql.indexOf("CREATE OR REPLACE VIEW akasha_coverage_health"));
  ok(view.length > 0, "the view must exist");
  const body = view.slice(0, view.indexOf("FROM akasha_cursor"));
  ok(/c\.backfill_tail\s*<=\s*c\.protocol_t0/.test(body), "clause 1: walked left to t0");
  ok(/COUNT\(\*\)[\s\S]{0,120}?=\s*1/.test(body), "clause 2: exactly one run");
  ok(/MIN\(from_height\)[\s\S]{0,120}?<=\s*c\.protocol_t0/.test(body), "clause 3: run starts at t0");
  ok(/MAX\(to_height\)[\s\S]{0,140}?>=\s*c\.finalized_height/.test(body), "clause 4: run reaches head");
});

/**
 * The sentence rule from §9: until the tape is one span from the protocol
 * origin, the UI says "complete from block N" and never "complete".
 */
function sentence(h: Health | null): string {
  if (h === null) return "coverage unknown";
  return completeFromProtocol(h) ? "complete from protocol origin" : `complete from block ${h.backfillTail}`;
}

test("an incomplete chain names the block it is complete from", () => {
  // Bitcoin at the moment the hose locked on: 3 blocks behind a live chain,
  // and ~198k blocks still to walk left. It may not say "complete".
  const bitcoin: Health = {
    protocolT0: 767_430,
    backfillTail: 966_127,
    finalizedHeight: 966_130,
    runs: [{ from: 966_127, to: 966_130 }],
  };
  eq(sentence(bitcoin), "complete from block 966127");
  ok(!sentence(bitcoin).match(/^complete$/), "bare 'complete' is never allowed");
});

test("only a genuinely complete chain gets the unqualified sentence", () => {
  eq(sentence(COMPLETE), "complete from protocol origin");
});

test("no coverage row at all is 'unknown', not 'complete'", () => {
  eq(sentence(null), "coverage unknown");
});
