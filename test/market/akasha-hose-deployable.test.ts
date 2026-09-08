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
