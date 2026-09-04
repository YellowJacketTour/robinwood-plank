import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const migrationRoot = join(process.cwd(), "deploy", "inmotion", "postgres", "migrations");
const expected = [
  "090_plankspace_native.sql",
  "091_plankspace_profile_seed_repair.sql",
  "092_plankspace_post_media.sql",
  "093_plankspace_profiles_social_woodstock.sql",
  "094_plankspace_widgets_woodstock.sql",
  "095_woodstock_live_schema_repair.sql",
  "096_plankspace_profile_customization.sql",
  "097_plankspace_x_integration.sql",
  "098_plankspace_x_action_limits.sql",
];

test("PlankSpace migrations follow current master without version collisions", () => {
  const files = readdirSync(migrationRoot).filter((file) => /^\d+.*\.sql$/.test(file)).sort();
  assert.deepEqual(files.filter((file) => file.includes("plankspace") || file.includes("woodstock")), expected);
  assert.equal(files.at(-1), expected.at(-1));
  for (const expectedFile of expected) {
    const prefix = expectedFile.match(/^\d+/)?.[0];
    assert.deepEqual(
      files.filter((file) => file.startsWith(`${prefix}_`)),
      [expectedFile],
      `${expectedFile} must own its post-master prefix`
    );
  }
});

test("PlankSpace migration SQL is additive and rerunnable", () => {
  for (const file of expected) {
    const sql = readFileSync(join(migrationRoot, file), "utf8");
    assert.doesNotMatch(sql, /\b(?:DROP\s+TABLE|DROP\s+COLUMN|TRUNCATE|DELETE\s+FROM)\b/i, file);

    for (const statement of sql.matchAll(/CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?!IF\s+NOT\s+EXISTS)/gi)) {
      assert.fail(`${file} has a non-idempotent index statement: ${statement[0]}`);
    }
  }
});
