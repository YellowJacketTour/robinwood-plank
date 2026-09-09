/** Run only against a disposable test database, with no other build/test job
 * reading this checkout. Every temporary source edit is restored in finally. */
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { Pool } from "pg";

if (!/test/i.test(process.env.PGDATABASE ?? "")) throw new Error("Use an isolated PGDATABASE containing 'test'.");
const root = new URL("../", import.meta.url);
const protocol = "lib/market/multichain/edge/change-protocol.ts";
const cases = [
  ["case-sensitive identity", protocol, "normalizeContractAddress(changed.chainSlug, changed.collectionKey)", "changed.collectionKey.toLowerCase()"],
  ["subscription bound", protocol, "value.length > 64", "value.length > 640"],
  ["resnapshot on reconnect", "lib/market/multichain/edge/change-feed.ts", 'this.broadcast(this.resync("listener-ready"));', '/* mutation: omit resnapshot */'],
  ["slow reader bound", "lib/market/multichain/edge/socket-server.ts", "ws.bufferedAmount > 262_144", "ws.bufferedAmount > 999_999"],
  ["full attention identity", "lib/market/demand-intent-key.ts", "[...new Set(intent.tokenIds ?? [])].sort()", "[]"],
  ["late cache write fence", "lib/market/swr-fetch.ts", "if (epoch !== invalidationEpoch) return data;", "/* mutation: accept stale write */"],
  ["case-sensitive projection", "lib/market/multichain/collection-key-sql.ts", "AND collection_slug = $2)", "AND lower(collection_slug) = lower($2))"],
  ["live token read cannot enqueue", "app/api/market/multichain/tokens/route.ts", 'searchParams.get("projection") === "1"', 'searchParams.get("projection") === "disabled"'],
  ["live rarity read cannot enqueue", "app/api/market/multichain/rarity/route.ts", 'needsIndex && searchParams.get("projection") !== "1"', 'needsIndex'],
  ["unbuilt live catalog preserves view", "components/market/MultichainCollectionView.tsx", "if (projectionOnly && last?.building && accumulated.length === 0) return;", "/* mutation: apply unknown empty snapshot */"],
  ["failed live catalog preserves view", "components/market/MultichainCollectionView.tsx", "if (!projectionOnly) {\n        setTokens(accumulated);", "if (true) {\n        setTokens(accumulated);"],
];
const testFiles = ["test/market/market-realtime.test.ts", "test/market/swr-invalidation.test.ts", "test/market/live-projection.test.ts", "test/market/live-catalog-callback.test.ts"];
const results = [];
function run(name, applied) {
  if (!applied) throw new Error(`Mutation did not apply: ${name}`);
  const result = spawnSync(process.execPath, ["node_modules/tsx/dist/cli.mjs", "--test", ...testFiles],
    { cwd: root, encoding: "utf8", timeout: 55_000, env: process.env });
  const output = result.stdout + result.stderr;
  const killed = result.status !== 0 && /AssertionError|ERR_ASSERTION|assertion|test failed|condition reached/.test(output);
  const entry = { name, applied, killed, exitCode: result.status };
  results.push(entry);
  console.log(JSON.stringify(entry));
  if (!killed) throw new Error(`Mutation survived or failed for an unrelated reason: ${name}\n${output}`);
}
const hash = (text) => createHash("sha256").update(text).digest("hex");
for (const [name, path, before, after] of cases) {
  const file = new URL(path, root);
  const original = readFileSync(file, "utf8");
  if (original.split(before).length !== 2) throw new Error(`Ambiguous mutation: ${name}`);
  const mutated = original.replace(before, after);
  try {
    writeFileSync(file, mutated);
    run(name, readFileSync(file, "utf8") === mutated && hash(original) !== hash(mutated));
  } finally { writeFileSync(file, original); }
}
const pool = new Pool();
const sql = readFileSync(new URL("deploy/inmotion/postgres/migrations/110_market_change_notifications.sql", root), "utf8").split("\nDO $$")[0];
try {
  const mutated = sql.replace("scope_count > 32", "scope_count > 320");
  await pool.query(mutated);
  const stored = await pool.query("SELECT pg_get_functiondef('plank_notify_market_changes'::regproc) AS source");
  run("overflow requires full resnapshot", stored.rows[0].source.includes("scope_count > 320"));
} finally { await pool.query(sql); await pool.end(); }
console.log(JSON.stringify({ mutationResults: results }));
