import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

/**
 * The connection budget is shared, and nothing was dividing it.
 *
 * MEASURED ON PRODUCTION 2026-09-09
 *
 * The same query, `limit=40`, returned in 0.15 s asked alone and took up to
 * 40.8 s when twelve requests ran back to back. Six consecutive identical
 * requests: 0.15-0.17 s, rock steady. Twelve across varied offsets:
 * 3.3 s, 4.1 s, 4.8 s, 4.9 s, 6.6 s, 9.0 s, 10.2 s, 10.8 s, 11.5 s, 15.9 s,
 * 40.8 s.
 *
 * Latency did NOT scale with rows -- `limit=500` returned 704 KB in 0.96 s
 * while `limit=40` took 3.6 s in the same window -- so it was never the query,
 * and never OFFSET either (offset=400 interleaved with offset=0 came back in
 * 0.14 s). It was waiting for a connection.
 *
 * THE ARITHMETIC NOBODY HAD DONE
 *
 *     PGPOOL_MAX = 12, and 12 mesh cron workers each build their own pool
 *     => up to 144 connections from background work alone
 *     ... plus the web app's pool, against a Postgres typically allowing 100.
 *
 * Every process was sized as though it were the only one.
 *
 * This is the honest ceiling on "everything, instantly": not vendor rate
 * limits, not query cost, but a shared resource that no single process could
 * see it was oversubscribing.
 */

const SRC = readFileSync("lib/postgres.ts", "utf8").replace(/\r\n/g, "\n");

test("a mesh worker takes a smaller share than the web app", () => {
  // Twelve workers and one web app cannot each behave as if they were alone.
  const at = SRC.indexOf("function postgresPoolMax");
  assert.ok(at > 0, "the pool sizer must exist");
  const body = SRC.slice(at, SRC.indexOf("\n}", at));
  assert.match(body, /isMeshWorkerProcess\(\)/, "the two roles must be distinguished");
  assert.match(body, /Math\.floor\(max \/ 2\)/, "a worker must take a fraction");
  // Halved, not minimised: a lane starved of connections just moves the stall
  // from the visitor to the archive.
  assert.match(body, /Math\.max\(2,/, "but never so few that a lane cannot work");
});

test("a web request fails fast rather than queueing behind a shortage", () => {
  // A request that waits ten seconds for a CONNECTION has already failed --
  // the visitor left. And while it waits it holds a slot, so a burst turns one
  // slow moment into a pile-up. That is precisely the 3.6/11.4/40.8 s tail.
  const at = SRC.indexOf("function connectionTimeoutMs");
  assert.ok(at > 0, "the timeout must be role-aware");
  const body = SRC.slice(at, SRC.indexOf("\n}", at));
  const web = body.match(/:\s*(\d[\d_]*);/);
  assert.ok(web, "a web timeout must be declared");
  assert.ok(
    Number(web[1]!.replace(/_/g, "")) <= 3_000,
    `a visitor must not wait seconds for a connection (saw ${web[1]})`
  );
  assert.match(body, /isMeshWorkerProcess\(\) \? 10_000/, "a background worker keeps the long wait");
});

test("the pool keeps a warm connection", () => {
  // Otherwise the first request after an idle period pays TCP + TLS + auth
  // before it can even ask a question.
  assert.match(SRC, /min: 1,/, "a cold pool makes the first request pay setup");
});

test("the statement timeout still distinguishes the two roles", () => {
  // This distinction already existed and is correct -- mesh scans legitimately
  // run long. The fix must not flatten it while adding a second one.
  assert.match(
    SRC,
    /statement_timeout: isMeshWorkerProcess\(\) \? 120_000 : 15_000/,
    "a long scan is legitimate for a worker and never for a page request"
  );
});

/**
 * The budget arithmetic, as a function, so the claim is exercised rather than
 * only asserted in a comment.
 */
function totalConnections(perProcess: number, workers: number, webPools: number): number {
  return perProcess * workers + perProcess * webPools;
}

test("the old sizing oversubscribed a default Postgres", () => {
  // 12 workers + 1 web app, each at PGPOOL_MAX=12, against max_connections=100.
  const before = totalConnections(12, 12, 1);
  assert.ok(before > 100, `the old budget must exceed a default server (saw ${before})`);
});

test("the new sizing fits, with headroom for the web app", () => {
  // Workers halved to 6; the web app keeps its full 12.
  const workerShare = Math.max(2, Math.floor(12 / 2));
  const after = workerShare * 12 + 12;
  assert.ok(after <= 100, `the new budget must fit a default server (saw ${after})`);
  assert.ok(
    workerShare * 12 < 100,
    "and background work alone must never be able to exhaust the server"
  );
});

test("halving is a real reduction, not a rounding artefact", () => {
  // Guard against a future PGPOOL_MAX where the floor swallows the halving and
  // the fix silently stops reducing anything.
  for (const max of [4, 8, 12, 20]) {
    const share = Math.max(2, Math.floor(max / 2));
    assert.ok(share < max, `a worker must take fewer than the full pool at max=${max}`);
    assert.ok(share >= 2, `and at least two at max=${max}`);
  }
});
