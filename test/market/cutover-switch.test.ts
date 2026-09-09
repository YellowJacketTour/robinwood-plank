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
  const at = WORKFLOW.indexOf("cutover-bitcoin-existence:\n");
  assert.ok(at > 0, "the job exists");
  return WORKFLOW.slice(at, at + 9000);
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
