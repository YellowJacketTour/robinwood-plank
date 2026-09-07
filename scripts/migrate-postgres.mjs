import { promises as fs } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";

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

const client = await pool.connect();
try {
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
    await client.query("BEGIN");
    try {
      await client.query(sql);
      await client.query(
        "INSERT INTO plank_schema_migrations (version) VALUES ($1)",
        [file]
      );
      await client.query("COMMIT");
      console.log(`[postgres-migrate] applied ${file}`);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  }
} finally {
  client.release();
  await pool.end();
}

console.log("[postgres-migrate] schema is current");
