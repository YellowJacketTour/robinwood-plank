/**
 * Copy Marketplank's existing Upstash/Vercel KV keys into a normal Redis or
 * Valkey server. Dry-run is the default. Use --apply only after reviewing the
 * key inventory; use --overwrite only when intentionally replacing a
 * destination key.
 *
 * Required:
 *   KV_REST_API_URL, KV_REST_API_TOKEN  source
 *   REDIS_URL                           destination
 * Optional:
 *   REDIS_USERNAME, REDIS_PASSWORD, REDIS_DATABASE
 */

import { kv as source } from "@vercel/kv";
import { createClient } from "redis";

const apply = process.argv.includes("--apply");
const overwrite = process.argv.includes("--overwrite");
const pattern = "plank:market:*";

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing ${name}.`);
  return value;
}

required("KV_REST_API_URL");
required("KV_REST_API_TOKEN");
const redisUrl = required("REDIS_URL");

function encode(value) {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) {
    throw new TypeError("Cannot encode undefined from source KV.");
  }
  return encoded;
}

function redisOptions() {
  const rawDb = process.env.REDIS_DATABASE?.trim();
  const database = rawDb ? Number(rawDb) : undefined;
  if (database !== undefined && (!Number.isInteger(database) || database < 0)) {
    throw new Error("REDIS_DATABASE must be a non-negative integer.");
  }
  return {
    url: redisUrl,
    username: process.env.REDIS_USERNAME?.trim() || undefined,
    password: process.env.REDIS_PASSWORD || undefined,
    database,
  };
}

const keys = [];
for await (const key of source.scanIterator({ match: pattern, count: 100 })) {
  keys.push(String(key));
}
keys.sort();

console.log(
  `[kv-migrate] found ${keys.length} source keys matching ${pattern}; mode=${apply ? "APPLY" : "DRY RUN"}`
);

if (!apply) {
  for (const key of keys) {
    console.log(`[dry-run] ${await source.type(key)} ${key}`);
  }
  console.log("[kv-migrate] no destination writes performed; re-run with --apply.");
  process.exit(0);
}

const destination = createClient(redisOptions());
destination.on("error", (error) => {
  console.error("[kv-migrate] destination Redis error:", error);
});
await destination.connect();

let copied = 0;
let skipped = 0;
try {
  for (const key of keys) {
    const type = await source.type(key);
    const exists = await destination.exists(key);
    if (exists && !overwrite) {
      console.log(`[skip] destination already has ${key}`);
      skipped += 1;
      continue;
    }
    if (exists) await destination.del(key);

    if (type === "string") {
      const value = await source.get(key);
      await destination.set(key, encode(value));
    } else if (type === "hash") {
      const values = (await source.hgetall(key)) || {};
      const encoded = Object.fromEntries(
        Object.entries(values).map(([field, value]) => [field, encode(value)])
      );
      if (Object.keys(encoded).length > 0) {
        await destination.hSet(key, encoded);
      }
    } else if (type === "set") {
      const values = await source.smembers(key);
      if (values.length > 0) await destination.sAdd(key, values.map(String));
    } else {
      console.log(`[skip] unsupported source type ${type} for ${key}`);
      skipped += 1;
      continue;
    }

    const ttl = await source.ttl(key);
    if (ttl > 0) await destination.expire(key, ttl);
    copied += 1;
    console.log(`[copy] ${type} ${key}${ttl > 0 ? ` ttl=${ttl}s` : ""}`);
  }
} finally {
  await destination.quit();
}

console.log(`[kv-migrate] complete: copied=${copied} skipped=${skipped}`);
