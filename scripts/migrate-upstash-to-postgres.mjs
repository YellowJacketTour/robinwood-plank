/**
 * Copy Marketplank's existing Upstash/Vercel KV data into the PostgreSQL
 * schema used by cPanel Passenger. Dry-run is the default. Apply schema
 * migrations first, then re-run with --apply.
 */

import { kv as source } from "@vercel/kv";
import { Pool } from "pg";

const apply = process.argv.includes("--apply");
const overwrite = process.argv.includes("--overwrite");
const pattern = "plank:market:*";

function required(name) {
  const raw = process.env[name];
  const value = name === "PGPASSWORD" ? raw : raw?.trim();
  if (!value) throw new Error(`Missing ${name}.`);
  return value;
}

required("KV_REST_API_URL");
required("KV_REST_API_TOKEN");

const destination = new Pool({
  host: required("PGHOST"),
  port: Number(process.env.PGPORT?.trim() || "5432"),
  database: required("PGDATABASE"),
  user: required("PGUSER"),
  password: required("PGPASSWORD"),
  max: 1,
  connectionTimeoutMillis: 10_000,
  statement_timeout: 30_000,
  application_name: "plank-love-upstash-migration",
  ssl:
    process.env.PGSSLMODE?.trim().toLowerCase() === "require"
      ? { rejectUnauthorized: false }
      : false,
});

function encode(value) {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) {
    throw new TypeError("Cannot encode undefined from source KV.");
  }
  return encoded;
}

async function writeOrder(kind, value) {
  const conflict = overwrite
    ? `DO UPDATE SET
         payload = EXCLUDED.payload,
         expires_at = EXCLUDED.expires_at,
         updated_at = NOW()`
    : "DO NOTHING";
  const result = await destination.query(
    `INSERT INTO market_orders
       (id, order_kind, collection_slug, maker, token_id, price_wei,
        payload, expires_at, updated_at)
     VALUES ($1, $2, $3, $4, $5::numeric, $6::numeric, $7::jsonb, $8, NOW())
     ON CONFLICT (id) ${conflict}`,
    [
      value.id,
      kind,
      value.collectionSlug,
      String(value.maker).toLowerCase(),
      value.tokenId ?? null,
      value.priceWei,
      encode(value),
      value.expiresAt,
    ]
  );
  return result.rowCount ?? 0;
}

async function writeOrders(kind, values) {
  let written = 0;
  for (const value of Object.values(values || {})) {
    if (!value || typeof value !== "object") continue;
    written += await writeOrder(kind, value);
  }
  return written;
}

const keys = [];
for await (const key of source.scanIterator({ match: pattern, count: 100 })) {
  keys.push(String(key));
}
keys.sort();

console.log(
  `[upstash-postgres] found ${keys.length} keys; mode=${apply ? "APPLY" : "DRY RUN"}`
);

if (!apply) {
  for (const key of keys) {
    console.log(`[dry-run] ${await source.type(key)} ${key}`);
  }
  console.log("[upstash-postgres] no destination writes performed");
  await destination.end();
  process.exit(0);
}

let copied = 0;
let skipped = 0;
try {
  for (const key of keys) {
    const type = await source.type(key);
    const ttl = await source.ttl(key);
    const expiresAt = ttl > 0 ? new Date(Date.now() + ttl * 1_000) : null;

    if (key === "plank:market:listings" && type === "hash") {
      copied += await writeOrders("listing", await source.hgetall(key));
    } else if (key === "plank:market:offers" && type === "hash") {
      copied += await writeOrders("offer", await source.hgetall(key));
    } else if (key === "plank:market:orders" && type === "string") {
      const legacy = (await source.get(key)) || {};
      copied += await writeOrders("listing", legacy.listings);
      copied += await writeOrders("offer", legacy.offers);
    } else if (
      key === "plank:market:served-order-hashes" &&
      type === "set"
    ) {
      for (const hash of await source.smembers(key)) {
        const result = await destination.query(
          `INSERT INTO served_order_hashes (order_hash)
           VALUES ($1)
           ON CONFLICT DO NOTHING`,
          [String(hash).toLowerCase()]
        );
        copied += result.rowCount ?? 0;
      }
    } else if (type === "string") {
      const value = await source.get(key);
      const conflict = overwrite
        ? `DO UPDATE SET
             value = EXCLUDED.value,
             expires_at = EXCLUDED.expires_at,
             updated_at = NOW()`
        : "DO NOTHING";
      const result = await destination.query(
        `INSERT INTO plank_kv_values (key_name, value, expires_at)
         VALUES ($1, $2::jsonb, $3)
         ON CONFLICT (key_name) ${conflict}`,
        [key, encode(value), expiresAt]
      );
      copied += result.rowCount ?? 0;
      if (!result.rowCount) skipped += 1;
    } else if (type === "hash") {
      const values = (await source.hgetall(key)) || {};
      for (const [field, value] of Object.entries(values)) {
        const conflict = overwrite
          ? "DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()"
          : "DO NOTHING";
        const result = await destination.query(
          `INSERT INTO plank_kv_hash_fields (key_name, field_name, value)
           VALUES ($1, $2, $3::jsonb)
           ON CONFLICT (key_name, field_name) ${conflict}`,
          [key, field, encode(value)]
        );
        copied += result.rowCount ?? 0;
        if (!result.rowCount) skipped += 1;
      }
    } else if (type === "set") {
      for (const member of await source.smembers(key)) {
        const result = await destination.query(
          `INSERT INTO plank_kv_set_members (key_name, member_value)
           VALUES ($1, $2)
           ON CONFLICT DO NOTHING`,
          [key, String(member)]
        );
        copied += result.rowCount ?? 0;
        if (!result.rowCount) skipped += 1;
      }
    } else {
      console.log(`[skip] unsupported source type ${type} for ${key}`);
      skipped += 1;
      continue;
    }

    console.log(`[copy] ${type} ${key}${ttl > 0 ? ` ttl=${ttl}s` : ""}`);
  }
} finally {
  await destination.end();
}

console.log(`[upstash-postgres] complete: copied=${copied} skipped=${skipped}`);
