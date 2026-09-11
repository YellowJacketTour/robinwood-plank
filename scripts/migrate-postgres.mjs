import { promises as fs } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { withMarketMigrationDrain } from "./market-migration-drain.mjs";
import { notificationDeferralCandidate, canDeferNotificationLock } from "./notification-migration-policy.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.resolve(
  scriptDir,
  "..",
  "deploy",
  "inmotion",
  "postgres",
  "migrations"
);

function required(name) {
  const raw = process.env[name];
  const value = name === "PGPASSWORD" ? raw : raw?.trim();
  if (!value) throw new Error(`Missing ${name}.`);
  return value;
}

function integerEnv(name, fallback, min, max) {
  const value = Number(process.env[name]?.trim() || fallback);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}.`);
  }
  return value;
}

const sslMode = process.env.PGSSLMODE?.trim().toLowerCase();
const ssl =
  !sslMode || sslMode === "disable"
    ? false
    : { rejectUnauthorized: sslMode === "verify-ca" || sslMode === "verify-full" };

const pool = new Pool({
  host: required("PGHOST"),
  port: integerEnv("PGPORT", 5432, 1, 65_535),
  database: required("PGDATABASE"),
  user: required("PGUSER"),
  password: required("PGPASSWORD"),
  max: 1,
  connectionTimeoutMillis: 10_000,
  // 2026-09-07: a migration ALTER waiting on a lock held by the always-on
  // workers was cancelled by a 30 s statement timeout. Migrations run with
  // no statement timeout and a 2-minute LOCK timeout instead, so a real
  // deadlock still fails loudly while a long-running ALTER can finish.
  statement_timeout: 0,
  options: "-c lock_timeout=120000",
  application_name: "plank-love-migrations",
  ssl,
});

const files = (await fs.readdir(migrationsDir))
  .filter((file) => /^\d+.*\.sql$/.test(file))
  .sort();

// `--check`: report pending migrations without applying anything. Exit 0
// when the schema is current, 3 when at least one file is pending. The
// deploy uses this to skip the full pre-migration pg_dump (40+ minutes on
// the production database as of 2026-09-06) on releases that carry no
// schema change, while keeping the backup on every release that does.
const checkOnly = process.argv.includes("--check");
const allowDeferredNotifications = process.argv.includes("--defer-locked-notifications");
const deferred = [];

const client = await pool.connect();
try {
  const version = await client.query("SHOW server_version_num");
  const serverVersion = Number(version.rows[0].server_version_num);
  console.log(`[postgres-migrate] server_version_num=${serverVersion}`);
  if (serverVersion < 90500) throw new Error("Market migrations require PostgreSQL 9.5 or newer.");
  if (serverVersion < 100000) {
    const temporary = await client.query("SELECT has_database_privilege(current_user, current_database(), 'TEMP') AS allowed");
    if (!temporary.rows[0].allowed) throw new Error("Legacy market notifications require database TEMP privilege.");
  }
  await client.query(`
    CREATE TABLE IF NOT EXISTS plank_schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  if (checkOnly) {
    const applied = await client.query("SELECT version FROM plank_schema_migrations");
    const appliedSet = new Set(applied.rows.map((row) => row.version));
    const pending = files.filter((file) => !appliedSet.has(file));
    if (pending.length === 0) {
      console.log("[postgres-migrate] check: schema is current, nothing pending");
      process.exitCode = 0;
    } else {
      console.log(`[postgres-migrate] check: ${pending.length} pending: ${pending.join(", ")}`);
      process.exitCode = 3;
    }
    client.release();
    await pool.end();
    process.exit();
  }

  for (const file of files) {
    const alreadyApplied = await client.query(
      "SELECT 1 FROM plank_schema_migrations WHERE version = $1",
      [file]
    );
    if (alreadyApplied.rowCount) {
      console.log(`[postgres-migrate] already applied ${file}`);
      continue;
    }

    const sql = await fs.readFile(path.join(migrationsDir, file), "utf8");
    const deferrable = notificationDeferralCandidate(allowDeferredNotifications, file, sql);
    await client.query("BEGIN");
    const drained = process.env.PLANK_MIGRATION_WRITERS_QUIESCED === "1" && serverVersion >= 90600
      && /^(110|111)_/.test(file);
    try {
      // The 2s clamp exists so a deferrable migration gives up quickly rather
      // than stalling a deploy behind another role's maintenance lock. But the
      // drain's first blocker sweep is at graceMs (30s), so when BOTH are on
      // the clamp fires first and the drain never runs at all. Measured on the
      // 2026-09-11 rollout: guard acquired the last writer lock at 04:02:40.95,
      // the migration began at 04:02:42.12 and failed at 04:02:44.19 -- 2s, on
      // a same-user lock the deferral path cannot forgive either. Give the
      // drain room to do its job; the clamp still applies when it is not armed.
      if (deferrable && !drained) await client.query("SET LOCAL lock_timeout = '2s'");
      if (drained) {
        await client.query("SET LOCAL lock_timeout = '90s'");
        await withMarketMigrationDrain(client, pool.options, () => client.query(sql));
      } else {
        await client.query(sql);
      }
      await client.query(
        "INSERT INTO plank_schema_migrations (version) VALUES ($1)",
        [file]
      );
      await client.query("COMMIT");
      console.log(`[postgres-migrate] applied ${file}`);
    } catch (error) {
      await client.query("ROLLBACK");
      if (await canDeferNotificationLock(client, deferrable, error)) {
        deferred.push(file);
        console.warn(`[postgres-migrate] PENDING ${file}: other-role maintenance lock; delivery uses periodic resync until migration succeeds`);
        continue;
      }
      throw error;
    }
  }
} finally {
  client.release();
  await pool.end();
}

console.log(deferred.length ? `[postgres-migrate] required schema ready; optional notifications PENDING: ${deferred.join(", ")}` : "[postgres-migrate] schema is current");
