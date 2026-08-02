import { Pool } from "pg";

function required(name) {
  const raw = process.env[name];
  const value = name === "PGPASSWORD" ? raw : raw?.trim();
  if (!value) throw new Error(`Missing ${name}.`);
  return value;
}

const pool = new Pool({
  host: required("PGHOST"),
  port: Number(process.env.PGPORT?.trim() || "5432"),
  database: required("PGDATABASE"),
  user: required("PGUSER"),
  password: required("PGPASSWORD"),
  max: 1,
  connectionTimeoutMillis: 10_000,
  statement_timeout: 30_000,
  application_name: "plank-love-maintenance",
  ssl:
    process.env.PGSSLMODE?.trim().toLowerCase() === "require"
      ? { rejectUnauthorized: false }
      : false,
});

try {
  const expiredKv = await pool.query(
    "DELETE FROM plank_kv_values WHERE expires_at <= NOW()"
  );
  const expiredOrders = await pool.query(
    "DELETE FROM market_orders WHERE expires_at <= NOW()"
  );
  console.log(
    `[postgres-maintenance] expired kv=${expiredKv.rowCount ?? 0} orders=${expiredOrders.rowCount ?? 0}`
  );
} finally {
  await pool.end();
}
