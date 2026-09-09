import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * The hose must be able to REACH production, not merely be complete.
 *
 * The gap this pins is the one that made "cut over" impossible even after the
 * package had 114 passing tests: `packages/akasha` is never copied into the
 * release tree, and every always-on worker on that host runs as a pre-built
 * esbuild bundle. A finished package that no deploy carries is not a step
 * closer to running -- it is a package.
 *
 * That is the same species as the rest of this file's neighbours: something
 * that reports "done" while the thing it claims to do cannot happen.
 */

const ROOT = process.cwd();
const PKG = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")) as {
  scripts: Record<string, string>;
};
const WORKFLOW = readFileSync(path.join(ROOT, ".github/workflows/inmotion.yml"), "utf8");

test("the hose has a bundle script shaped like its sibling workers", () => {
  const script = PKG.scripts["build:akasha-hose"];
  assert.ok(script, "no build:akasha-hose -- the hose cannot ship");
  assert.ok(/esbuild/.test(script), "workers ship as esbuild bundles; the host has no tsx");
  assert.ok(
    /--outfile=\.next\/standalone\/scripts\/akasha-hose-standalone\.mjs/.test(script),
    "must land in the standalone tree the release copies",
  );
  // pg is a native-ish dependency resolved on the host, exactly as every
  // other worker bundle marks it.
  assert.ok(/--external:pg\b/.test(script), "pg must stay external");
  assert.ok(/--external:pg-native/.test(script), "pg-native must stay external");
});

test("the release build actually runs that script", () => {
  assert.ok(
    /- run: npm run build:akasha-hose/.test(WORKFLOW),
    "a build script nothing invokes produces no bundle",
  );
});

test("the release VERIFIES the bundle exists", () => {
  // Every sibling has a `test -s` guard. Without one, a silently failing
  // esbuild step ships a release whose worker is simply absent -- and the
  // first symptom would be a chain with no writer.
  assert.ok(
    /test -s \.next\/standalone\/scripts\/akasha-hose-standalone\.mjs/.test(WORKFLOW),
    "an unverified bundle can go missing without failing the release",
  );
});

test("the worker refuses to run without the things that make it an archive", () => {
  const src = readFileSync(path.join(ROOT, "scripts/akasha-hose.ts"), "utf8");

  // No chains: nothing to own.
  assert.ok(/AKASHA_CHAINS is empty/.test(src), "must refuse with nothing to own");
  // No database: an in-memory tape forgets on restart, and a hose that looks
  // alive while persisting nothing is the exact failure this program removes.
  assert.ok(
    /no database configured/.test(src) && /process\.exit\(2\)/.test(src),
    "must refuse to start without a database",
  );
  // No tables: starting against a database without migration 104 would throw
  // on every flush while the process reported itself running.
  assert.ok(
    /information_schema\.tables/.test(src) && /104_akasha_tape/.test(src),
    "must check its own tables exist and name the migration that creates them",
  );
});

test("the worker writes akasha_* and never plank_*", () => {
  const src = readFileSync(path.join(ROOT, "scripts/akasha-hose.ts"), "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  // The separation is what makes staging safe: this can run beside the
  // existing mesh indefinitely because the two write disjoint tables.
  assert.ok(
    !/INSERT INTO plank_|UPDATE plank_|DELETE FROM plank_/i.test(code),
    "the hose must never write a plank_ table -- two writers on one tape is the failure",
  );
});

/**
 * The provisioning job's OWN text, bounded by where the job actually ends.
 *
 * A fixed `slice(at, at + 7000)` was used here and it broke the moment a new
 * job was added after this one: the window ran past the job boundary into
 * `cutover-bitcoin-existence`, which legitimately contains
 * AKASHA_HOSE_OWNS_BITCOIN=1, and the "provisioning must not arm the flag"
 * test failed on code that was not provisioning's.
 *
 * A guessed length is not a boundary. Jobs are top-level YAML keys at two
 * spaces of indent, so the next one of those is the real end.
 */
function provisioningJob(): string {
  const at = WORKFLOW.indexOf("provision-akasha-hose:");
  assert.ok(at > 0, "the provisioning job exists");
  // Stop at the next job's COMMENT BANNER, not at its YAML key. Every job here
  // is preceded by a `# ---` banner documenting it, and that banner is already
  // past this job -- the cutover job's own banner mentions
  // AKASHA_HOSE_OWNS_BITCOIN=1 while explaining what arming does, which is
  // exactly the string this file asserts provisioning must not contain.
  // Bounding on the key alone still swallows the neighbour's prose.
  const rest = WORKFLOW.slice(at);
  const banner = rest.indexOf("\n  # ---");
  const key = rest.search(/\n {2}[a-z][a-z0-9-]*:\n/);
  const ends = [banner, key].filter((n) => n > 0);
  const next = ends.length ? Math.min(...ends) : -1;
  return next > 0 ? WORKFLOW.slice(at, at + next) : WORKFLOW.slice(at);
}

test("a provisioning operation exists and proves the worker before scheduling it", () => {
  assert.ok(
    /- provision-akasha-hose/.test(WORKFLOW),
    "no operation to install the hose -- a bundle nothing schedules never runs",
  );
  const job = provisioningJob();

  // Prove-then-schedule. A worker that cannot complete one bounded pass must
  // never be installed to fail silently every minute with nobody watching --
  // that is a scheduled version of the silent-failure species.
  assert.ok(/--max-seconds=60/.test(job), "a bounded proof run happens first");
  assert.ok(
    job.indexOf("--max-seconds=60") < job.indexOf("crontab \"$cron_after\""),
    "the proof must run BEFORE the schedule is installed",
  );

  // Missing tables is its own actionable failure, not a generic non-zero.
  assert.ok(
    /proof_status" -eq 3/.test(job) && /migration 104/.test(job),
    "exit 3 must be reported as 'run deploy first so 104 applies'",
  );

  // And the schedule must be observed firing before success is declared.
  assert.ok(/cron_observed/.test(job), "never trust a schedule until it has been seen to run");
});

test("the scheduled entry is Bitcoin-only and connection-frugal", () => {
  const job = provisioningJob();
  assert.ok(/AKASHA_CHAINS=bitcoin/.test(job), "one family at a time is the supported cutover");
  assert.ok(!/AKASHA_CHAINS=[a-z,]*solana/.test(job), "Solana is unpinned and must not be scheduled");
  // A background archiver on a shared box must never be what exhausts the pool.
  assert.ok(/PGPOOL_MAX=2/.test(job), "two connections only");
  // Started under a lock, like every other always-on worker here: the cron
  // line is a printf whose `%s -n %s` takes $flock_bin and $lock_file as
  // ARGUMENTS, so the literal path never appears inline.
  assert.ok(/'\* \* \* \* \* cd %s && %s -n %s/.test(job), "the live entry runs under flock -n");
  assert.ok(
    /"\$flock_bin" "\$lock_file"/.test(job),
    "and the lock it takes is the hose's own, not a shared one",
  );
});

test("provisioning does NOT arm the cutover flag", () => {
  const job = provisioningJob();
  // Installing the writer and retiring the old pager are separate acts. If
  // provisioning armed the flag, Bitcoin would lose its catalog pager at the
  // same moment the hose first started -- before anyone had seen it hold a
  // tip across a restart.
  assert.ok(
    !/AKASHA_HOSE_OWNS_BITCOIN=1/.test(job),
    "provisioning must never arm the flag: that is a separate, later decision",
  );
});
