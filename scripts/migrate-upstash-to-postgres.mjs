/**
 * One-time, read-only Upstash REST -> InMotion PostgreSQL migration.
 *
 * Inventory is the default. The only write mode is an explicit, atomic
 * replacement after an external pg_dump backup:
 *
 *   node scripts/migrate-upstash-to-postgres.mjs
 *   node scripts/migrate-upstash-to-postgres.mjs \
 *     --apply --replace --confirm=REPLACE_INMOTION_MARKET_DATA
 */

import { Pool } from "pg";
import {
  buildPostgresPlan,
  expectedCounts,
  readMarketSnapshot,
} from "./lib/upstash-postgres-snapshot.mjs";
import { ReadonlyUpstashRest } from "./lib/upstash-rest.mjs";

const apply = process.argv.includes("--apply");
const replace = process.argv.includes("--replace");
const confirmation = process.argv
  .find((arg) => arg.startsWith("--confirm="))
  ?.slice("--confirm=".length);

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

function poolConfig() {
  const sslMode = process.env.PGSSLMODE?.trim().toLowerCase();
  return {
    host: required("PGHOST"),
    port: integerEnv("PGPORT", 5432, 1, 65_535),
    database: required("PGDATABASE"),
    user: required("PGUSER"),
    password: required("PGPASSWORD"),
    max: 1,
    connectionTimeoutMillis: 10_000,
    statement_timeout: 60_000,
    application_name: "plank-love-upstash-migration",
    ssl:
      !sslMode || sslMode === "disable"
        ? false
        : {
            rejectUnauthorized:
              sslMode === "verify-ca" || sslMode === "verify-full",
          },
  };
}

function encode(value) {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) {
    throw new TypeError("Cannot encode undefined from source KV.");
  }
  return encoded;
}

async function destinationCounts(queryable) {
  const result = await queryable.query(`
    SELECT
      (SELECT COUNT(*)::int FROM market_orders) AS orders,
      (SELECT COUNT(*)::int FROM market_orders WHERE order_kind = 'listing') AS listings,
      (SELECT COUNT(*)::int FROM market_orders WHERE order_kind = 'offer') AS offers,
      (SELECT COUNT(*)::int FROM served_order_hashes) AS "servedHashes",
      (SELECT COUNT(*)::int FROM plank_kv_values
        WHERE key_name LIKE 'plank:market:%') AS values,
      (SELECT COUNT(*)::int FROM plank_kv_hash_fields
        WHERE key_name LIKE 'plank:market:%') AS "hashFields",
      (SELECT COUNT(*)::int FROM plank_kv_set_members
        WHERE key_name LIKE 'plank:market:%') AS "setMembers"
  `);
  return result.rows[0];
}

async function clearDestination(client) {
  await client.query("DELETE FROM market_orders");
  await client.query("DELETE FROM served_order_hashes");
  await client.query(
    "DELETE FROM plank_kv_values WHERE key_name LIKE 'plank:market:%'"
  );
  await client.query(
    "DELETE FROM plank_kv_hash_fields WHERE key_name LIKE 'plank:market:%'"
  );
  await client.query(
    "DELETE FROM plank_kv_set_members WHERE key_name LIKE 'plank:market:%'"
  );
}

async function insertPlan(client, plan) {
  for (const order of plan.orders) {
    await client.query(
      `INSERT INTO market_orders
         (id, order_kind, collection_slug, maker, token_id, price_wei,
          payload, expires_at, updated_at)
       VALUES ($1, $2, $3, $4, $5::numeric, $6::numeric, $7::jsonb, $8, NOW())`,
      [
        order.value.id,
        order.kind,
        order.value.collectionSlug,
        String(order.value.maker).toLowerCase(),
        order.value.tokenId ?? null,
        order.value.priceWei,
        encode(order.value),
        order.expiresAt,
      ]
    );
  }

  for (const hash of plan.servedHashes) {
    await client.query(
      "INSERT INTO served_order_hashes (order_hash) VALUES ($1)",
      [hash]
    );
  }

  for (const item of plan.values) {
    await client.query(
      `INSERT INTO plank_kv_values (key_name, value, expires_at, updated_at)
       VALUES ($1, $2::jsonb, $3, NOW())`,
      [item.key, encode(item.value), item.expiresAt]
    );
  }

  for (const item of plan.hashFields) {
    await client.query(
      `INSERT INTO plank_kv_hash_fields
         (key_name, field_name, value, updated_at)
       VALUES ($1, $2, $3::jsonb, NOW())`,
      [item.key, item.field, encode(item.value)]
    );
  }

  for (const item of plan.setMembers) {
    await client.query(
      `INSERT INTO plank_kv_set_members (key_name, member_value)
       VALUES ($1, $2)`,
      [item.key, item.member]
    );
  }
}

function assertReconciled(expected, actual) {
  for (const [name, count] of Object.entries(expected)) {
    if (Number(actual[name]) !== count) {
      throw new Error(
        `PostgreSQL reconciliation failed for ${name}: expected ${count}, got ${actual[name]}.`
      );
    }
  }
}

async function main() {
  if (apply) {
    if (!replace) {
      throw new Error("--apply requires --replace; merge-mode writes are disabled.");
    }
    if (confirmation !== "REPLACE_INMOTION_MARKET_DATA") {
      throw new Error(
        "--apply requires --confirm=REPLACE_INMOTION_MARKET_DATA."
      );
    }
  } else if (replace || confirmation) {
    throw new Error("--replace/--confirm are valid only with --apply.");
  }

  const source = new ReadonlyUpstashRest();
  const pool = new Pool(poolConfig());
  try {
    const snapshot = await readMarketSnapshot(source);
    const plan = buildPostgresPlan(snapshot);
    const expected = expectedCounts(plan);
    const current = await destinationCounts(pool);

    for (const entry of snapshot.entries) {
      console.log(
        `[inventory] ${entry.type} ${entry.key} entries=${entry.count} ttl=${entry.ttl}`
      );
    }
    for (const key of snapshot.expiredDuringRead) {
      console.log(`[inventory] expired-during-read ${key}`);
    }
    console.log(
      `MIGRATION_INVENTORY=${JSON.stringify({
        sourceKeys: snapshot.entries.length,
        expiredDuringRead: snapshot.expiredDuringRead.length,
        expected,
        currentDestination: current,
        mode: apply ? "CUTOVER" : "INVENTORY",
      })}`
    );

    if (!apply) {
      console.log("[upstash-postgres] inventory complete; no writes performed");
      return;
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await clearDestination(client);
      await insertPlan(client, plan);
      const actual = await destinationCounts(client);
      assertReconciled(expected, actual);
      await client.query("COMMIT");
      console.log(
        `MIGRATION_RESULT=${JSON.stringify({
          status: "committed",
          expected,
          actual,
        })}`
      );
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(`[upstash-postgres] ${error.message}`);
  process.exitCode = 1;
});
