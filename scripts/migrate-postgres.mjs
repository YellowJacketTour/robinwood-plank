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

const connectionString = [
  "POSTGRES_URL",
  "DATABASE_URL",
  "NEON_DATABASE_URL",
  "POSTGRES_PRISMA_URL",
  "POSTGRES_URL_NON_POOLING",
  "DATABASE_URL_UNPOOLED",
].map((name) => process.env[name]?.trim()).find(Boolean);
const pool = new Pool({
  ...(connectionString ? { connectionString } : {
    host: required("PGHOST"),
    port: integerEnv("PGPORT", 5432, 1, 65_535),
    database: required("PGDATABASE"),
    user: required("PGUSER"),
    password: required("PGPASSWORD"),
  }),
  max: 1,
  connectionTimeoutMillis: 10_000,
  statement_timeout: 30_000,
  application_name: "plank-love-migrations",
  ...(connectionString ? {} : { ssl }),
});

const files = (await fs.readdir(migrationsDir))
  .filter((file) => /^\d+.*\.sql$/.test(file))
  .sort();

const client = await pool.connect();
try {
  await client.query(`
    CREATE TABLE IF NOT EXISTS plank_schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

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
