import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * The cutover switch: a door that opens both ways.
 *
 * Step 3 hands Bitcoin EXISTENCE to the akasha hose by adding
 * AKASHA_HOSE_OWNS_BITCOIN=1 to the mesh cron entry. It was the only step that
 * required a manual SSH edit, which made it feel irreversible and made it the
 * one thing nobody wanted to touch. Built as a switch instead: arm, disarm,
 * status, all one dispatch.
 *
 * WHY THE EVIDENCE SAYS ARMING IS SAFE. Bitcoin sat at exactly 19,621
 * collections for the whole of 2026-09-08 -- five readings across ~5 hours --
 * while the catalog still returns ~1,800 real rows. Those four pagers are
 * re-walking what is already archived. "Protecting" them protects a producer
 * of zero.
 *
 * WHAT IT MUST NEVER DO is arm while the hose is dead. That WOULD leave
 * Bitcoin with no discovery at all, which is the one outcome worse than a
 * pager finding nothing.
 */

const WORKFLOW = readFileSync(
  path.join(process.cwd(), ".github/workflows/inmotion.yml"),
  "utf8",
);

function job(): string {
  // Normalise line endings FIRST. This repo checks out with CRLF on Windows,
  // so matching on "...:\n" silently finds nothing and every assertion below
  // fails with "the job exists" -- blaming the workflow when the bug is in the
  // lookup. Same species as a fixed-offset window: an assumption about text
  // layout instead of a check.
  const src = WORKFLOW.replace(/\r\n/g, "\n");
  const at = src.indexOf("\n  cutover-bitcoin-existence:\n");
  assert.ok(at > 0, "the job exists");
  const rest = src.slice(at + 1);
  // Bound by the next job's comment banner or key, never a guessed length --
  // a fixed slice ran past the boundary and read a neighbour's prose once
  // already tonight.
  const banner = rest.indexOf("\n  # ---");
  const key = rest.slice(1).search(/\n {2}[a-z][a-z0-9-]*:\n/);
  const ends = [banner, key > 0 ? key + 1 : -1].filter((n) => n > 0);
  return ends.length ? rest.slice(0, Math.min(...ends)) : rest;
}

test("the switch flips the MESH entry, not the hose's own", () => {
  // matrix.ts reads the flag and matrix runs inside mesh-tick. Setting it on
  // the hose's cron line would change nothing while looking exactly like
  // success -- the failure shape this whole program exists to remove.
  const j = job();
  assert.ok(/mesh-tick-standalone\.mjs/.test(j), "the mesh entry is what gets rewritten");
  assert.ok(
    /UV_THREADPOOL_SIZE=4/.test(j),
    "the anchor is the mesh line's own env prefix, so the hose line cannot match",
  );
});

test("arming REFUSES unless the hose is provably alive", () => {
  const j = job();
  // Two independent checks, because either alone can lie: a cron entry proves
  // it is SCHEDULED, a recent log proves it actually RAN.
  assert.ok(
    /akasha-hose-standalone\.mjs/.test(j) && /refusing to arm: the hose has no cron entry/.test(j),
    "must refuse when the hose was never provisioned",
  );
  assert.ok(
    /find "\$log" -mmin -120/.test(j),
    "must refuse on a stale log: scheduled-but-failing is not alive",
  );
  assert.ok(
    /owning tip for/.test(j),
    "must see the hose actually locking a chain, not merely writing something",
  );
});

test("the switch goes BOTH ways, and can report without changing anything", () => {
  const j = job();
  for (const d of ["arm", "disarm", "status"]) {
    assert.ok(new RegExp(`"${d}"`).test(j) || new RegExp(`= ${d}`).test(j) || j.includes(d),
      `${d} is a supported direction`);
  }
  // status must not write.
  const statusAt = j.indexOf('if [ "$direction" = "status" ]');
  assert.ok(statusAt > 0, "status is handled");
  const statusBlock = j.slice(statusAt, statusAt + 200);
  assert.ok(/exit 0/.test(statusBlock), "status exits before any crontab write");
  assert.ok(!/crontab "\$cron_new"/.test(statusBlock), "status never installs a crontab");
});

test("the rewrite must change exactly one line and drop none", () => {
  const j = job();
  // A sed over a crontab is the dangerous part: a bad pattern could mangle or
  // delete unrelated entries -- the KOTH watcher, the stream worker, the
  // gap finder. Line-count and changed-line assertions bound that blast
  // radius to the single line intended.
  assert.ok(/before_n" -ne "\$after_n/.test(j), "line count must be preserved");
  assert.ok(/changed" -ne 1/.test(j), "exactly one line may differ");
  assert.ok(
    j.indexOf("changed\" -ne 1") < j.indexOf('crontab "$cron_new"'),
    "both checks must run BEFORE the crontab is installed",
  );
});

test("the result is read back, not assumed", () => {
  const j = job();
  const verifyAt = j.indexOf("verify=");
  const writeAt = j.indexOf('crontab "$cron_new"');
  assert.ok(verifyAt > writeAt, "verification happens after the write");
  assert.ok(/arm did not take effect/.test(j) && /disarm did not take effect/.test(j),
    "both directions verify their own outcome");
});

test("idempotent: arming an armed host is a no-op, not a double-edit", () => {
  const j = job();
  assert.ok(/already armed, nothing to do/.test(j));
  assert.ok(/already disarmed, nothing to do/.test(j));
});

test("the sed patterns are exact inverses", () => {
  // Simulated on the real cron shapes, because a mismatched pair would arm
  // fine and then fail to disarm -- a one-way door wearing a switch's label.
  const FLAG = "AKASHA_HOSE_OWNS_BITCOIN=1";
  const mesh =
    "* * * * * cd /app/current && /usr/bin/flock -n /app/shared/market-mesh.lock " +
    "/usr/bin/env UV_THREADPOOL_SIZE=4 MESH_IN_PROCESS=1 PGPOOL_MAX=12 /node --env-file=/env /app/mesh-tick-standalone.mjs --limit=10";

  const armed = mesh.replace("/usr/bin/env UV_THREADPOOL_SIZE=4", `/usr/bin/env ${FLAG} UV_THREADPOOL_SIZE=4`);
  assert.ok(armed.includes(FLAG), "arm inserts the flag");
  assert.notEqual(armed, mesh);

  const disarmed = armed.replace(`${FLAG} `, "");
  assert.equal(disarmed, mesh, "disarm returns the line byte-for-byte to its original");
});

test("the hose's own cron line is NOT touched by either pattern", () => {
  // The hose line has its own env prefix (AKASHA_CHAINS=bitcoin ...), so the
  // mesh anchor must not match it. If it did, arming would edit the wrong
  // entry and the flag would never reach the process that reads it.
  const hose =
    "* * * * * cd /app/current && /usr/bin/flock -n /app/shared/akasha-hose.lock " +
    "/usr/bin/env AKASHA_CHAINS=bitcoin PGPOOL_MAX=2 UV_THREADPOOL_SIZE=2 /node --env-file=/env /app/akasha-hose-standalone.mjs";
  const after = hose.replace("/usr/bin/env UV_THREADPOOL_SIZE=4", "MATCHED");
  assert.equal(after, hose, "the mesh anchor must not match the hose line");
});

test("the liveness check does not use a fixed tail window", () => {
  // MEASURED 2026-09-09: `tail -n 200 | grep 'owning tip for'` REFUSED a
  // healthy hose. The worker prints one ~400-char health line every 60s, so a
  // 59-minute boot emits ~59 of them and the single "owning tip" line per boot
  // is pushed out of a 200-line window by its own output. The refusal fired
  // while the same log showed `locked at 966127` and `restored tape: 1
  // cursors, 47 headers, 73 events`.
  //
  // Freshness is already answered by the `find -mmin -120` check on the FILE.
  // This check only asks "has this worker ever locked a chain", so the whole
  // log is the right window. A guessed line count is not a boundary.
  const j = job();
  assert.ok(
    !/tail -n \d+ "\$log" \| grep -q 'owning tip for'/.test(j),
    "a fixed tail can be outrun by the worker's own health output",
  );
  assert.ok(
    /grep -q 'owning tip for' "\$log"/.test(j),
    "search the whole log for the marker",
  );
  // And the freshness check must still be there -- searching the whole log
  // without it would accept a hose that locked a chain days ago and died.
  assert.ok(/find "\$log" -mmin -120/.test(j), "file freshness is still checked separately");
});
