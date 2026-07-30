import { kv as upstashKv } from "@vercel/kv";
import { createClient } from "redis";
import {
  hasPostgresConfig,
  postgresQuery,
  withPostgresTransaction,
} from "@/lib/postgres";

/**
 * Durable key/value adapter used by the marketplace.
 *
 * Existing deployments can keep using Upstash/Vercel KV unchanged. A VPS can
 * instead set REDIS_URL and optionally REDIS_USERNAME / REDIS_PASSWORD /
 * REDIS_DATABASE to use a normal Redis or Valkey server over RESP. A cPanel
 * Passenger deployment can use its local PostgreSQL service.
 *
 * Selection:
 *   DURABLE_KV_BACKEND=postgres -> require PGHOST/PGDATABASE/PGUSER/PGPASSWORD
 *   DURABLE_KV_BACKEND=redis   -> require REDIS_URL
 *   DURABLE_KV_BACKEND=upstash -> require KV_REST_API_URL + KV_REST_API_TOKEN
 *   unset                      -> PostgreSQL, Redis, then Upstash
 */

export type DurableKvBackend = "postgres" | "redis" | "upstash" | null;
type SetOptions = { ex?: number };
type RedisClient = ReturnType<typeof createClient>;
type RedisGlobal = typeof globalThis & {
  __plankRedisClient?: RedisClient;
  __plankRedisConnect?: Promise<RedisClient>;
};

function hasRedis(): boolean {
  return Boolean(process.env.REDIS_URL?.trim());
}

function hasUpstash(): boolean {
  return Boolean(
    process.env.KV_REST_API_URL?.trim() &&
      process.env.KV_REST_API_TOKEN?.trim()
  );
}

export function durableKvBackend(): DurableKvBackend {
  const requested = process.env.DURABLE_KV_BACKEND?.trim().toLowerCase();
  if (
    requested &&
    requested !== "postgres" &&
    requested !== "redis" &&
    requested !== "upstash"
  ) {
    throw new Error(
      `DURABLE_KV_BACKEND must be "postgres", "redis", or "upstash", received "${requested}".`
    );
  }
  if (requested === "postgres") {
    if (!hasPostgresConfig()) {
      throw new Error(
        "DURABLE_KV_BACKEND=postgres requires PGHOST, PGDATABASE, PGUSER, and PGPASSWORD."
      );
    }
    return "postgres";
  }
  if (requested === "redis") {
    if (!hasRedis()) {
      throw new Error("DURABLE_KV_BACKEND=redis requires REDIS_URL.");
    }
    return "redis";
  }
  if (requested === "upstash") {
    if (!hasUpstash()) {
      throw new Error(
        "DURABLE_KV_BACKEND=upstash requires KV_REST_API_URL and KV_REST_API_TOKEN."
      );
    }
    return "upstash";
  }
  if (hasPostgresConfig()) return "postgres";
  if (hasRedis()) return "redis";
  if (hasUpstash()) return "upstash";
  return null;
}

export function hasDurableKv(): boolean {
  return durableKvBackend() !== null;
}

export function serializeRedisValue(value: unknown): string {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) {
    throw new TypeError("Cannot store undefined in durable KV.");
  }
  return encoded;
}

export function deserializeRedisValue<T>(value: string | null): T | null {
  if (value === null) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    // Tolerate values written manually or by an older non-JSON Redis client.
    return value as T;
  }
}

function redisGlobal(): RedisGlobal {
  return globalThis as RedisGlobal;
}

function parseRedisDatabase(): number | undefined {
  const raw = process.env.REDIS_DATABASE?.trim();
  if (!raw) return undefined;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error("REDIS_DATABASE must be a non-negative integer.");
  }
  return parsed;
}

async function getRedisClient(): Promise<RedisClient> {
  const state = redisGlobal();
  if (!state.__plankRedisClient) {
    state.__plankRedisClient = createClient({
      url: process.env.REDIS_URL,
      username: process.env.REDIS_USERNAME?.trim() || undefined,
      password: process.env.REDIS_PASSWORD || undefined,
      database: parseRedisDatabase(),
      socket: {
        connectTimeout: 10_000,
        reconnectStrategy(retries) {
          return Math.min(100 * 2 ** Math.min(retries, 6), 5_000);
        },
      },
    });
    state.__plankRedisClient.on("error", (error) => {
      console.error("[durable-kv] Redis connection error:", error);
    });
  }

  const client = state.__plankRedisClient;
  if (client.isReady) return client;
  if (!state.__plankRedisConnect) {
    state.__plankRedisConnect = client
      .connect()
      .then(() => client)
      .finally(() => {
        state.__plankRedisConnect = undefined;
      });
  }
  return state.__plankRedisConnect;
}

async function redisGet<T>(key: string): Promise<T | null> {
  const client = await getRedisClient();
  return deserializeRedisValue<T>(await client.get(key));
}

async function redisSet(
  key: string,
  value: unknown,
  options?: SetOptions
): Promise<unknown> {
  const client = await getRedisClient();
  const encoded = serializeRedisValue(value);
  if (options?.ex) {
    return client.set(key, encoded, { expiration: { type: "EX", value: options.ex } });
  }
  return client.set(key, encoded);
}

async function redisHashGet<T>(key: string, field: string): Promise<T | null> {
  const client = await getRedisClient();
  return deserializeRedisValue<T>(await client.hGet(key, field));
}

async function redisHashGetAll<T>(key: string): Promise<T | null> {
  const client = await getRedisClient();
  const values = await client.hGetAll(key);
  if (Object.keys(values).length === 0) return null;
  const decoded: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(values)) {
    decoded[field] = deserializeRedisValue(value);
  }
  return decoded as T;
}

async function redisHashSet(
  key: string,
  values: Record<string, unknown>
): Promise<number> {
  const client = await getRedisClient();
  const encoded: Record<string, string> = {};
  for (const [field, value] of Object.entries(values)) {
    encoded[field] = serializeRedisValue(value);
  }
  return client.hSet(key, encoded);
}

async function postgresGet<T>(key: string): Promise<T | null> {
  const result = await postgresQuery<{ value: T }>(
    `SELECT value
       FROM plank_kv_values
      WHERE key_name = $1
        AND (expires_at IS NULL OR expires_at > NOW())`,
    [key]
  );
  return result.rows[0]?.value ?? null;
}

async function postgresSet(
  key: string,
  value: unknown,
  options?: SetOptions
): Promise<string> {
  const encoded = serializeRedisValue(value);
  const expiresAt = options?.ex
    ? new Date(Date.now() + options.ex * 1_000)
    : null;
  await postgresQuery(
    `INSERT INTO plank_kv_values (key_name, value, expires_at, updated_at)
     VALUES ($1, $2::jsonb, $3, NOW())
     ON CONFLICT (key_name) DO UPDATE
       SET value = EXCLUDED.value,
           expires_at = EXCLUDED.expires_at,
           updated_at = NOW()`,
    [key, encoded, expiresAt]
  );
  return "OK";
}

async function postgresHashGet<T>(
  key: string,
  field: string
): Promise<T | null> {
  const result = await postgresQuery<{ value: T }>(
    `SELECT value
       FROM plank_kv_hash_fields
      WHERE key_name = $1 AND field_name = $2`,
    [key, field]
  );
  return result.rows[0]?.value ?? null;
}

async function postgresHashGetAll<T>(key: string): Promise<T | null> {
  const result = await postgresQuery<{ field_name: string; value: unknown }>(
    `SELECT field_name, value
       FROM plank_kv_hash_fields
      WHERE key_name = $1`,
    [key]
  );
  if (result.rows.length === 0) return null;
  return Object.fromEntries(
    result.rows.map((row) => [row.field_name, row.value])
  ) as T;
}

async function postgresHashSet(
  key: string,
  values: Record<string, unknown>
): Promise<number> {
  const entries = Object.entries(values);
  if (entries.length === 0) return 0;
  await withPostgresTransaction(async (client) => {
    for (const [field, value] of entries) {
      await client.query(
        `INSERT INTO plank_kv_hash_fields
           (key_name, field_name, value, updated_at)
         VALUES ($1, $2, $3::jsonb, NOW())
         ON CONFLICT (key_name, field_name) DO UPDATE
           SET value = EXCLUDED.value, updated_at = NOW()`,
        [key, field, serializeRedisValue(value)]
      );
    }
  });
  return entries.length;
}

/**
 * Minimal API shared by every current marketplace consumer. Keeping this
 * surface intentionally small makes storage migrations reviewable.
 */
export const durableKv = {
  async get<T>(key: string): Promise<T | null> {
    if (durableKvBackend() === "postgres") return postgresGet<T>(key);
    if (durableKvBackend() === "redis") return redisGet<T>(key);
    return upstashKv.get<T>(key);
  },

  async set(key: string, value: unknown, options?: SetOptions): Promise<unknown> {
    if (durableKvBackend() === "postgres") {
      return postgresSet(key, value, options);
    }
    if (durableKvBackend() === "redis") {
      return redisSet(key, value, options);
    }
    if (options?.ex) {
      return upstashKv.set(key, value, { ex: options.ex });
    }
    return upstashKv.set(key, value);
  },

  async hget<T>(key: string, field: string): Promise<T | null> {
    if (durableKvBackend() === "postgres") {
      return postgresHashGet<T>(key, field);
    }
    if (durableKvBackend() === "redis") {
      return redisHashGet<T>(key, field);
    }
    return upstashKv.hget<T>(key, field);
  },

  async hgetall<T extends Record<string, unknown>>(
    key: string
  ): Promise<T | null> {
    if (durableKvBackend() === "postgres") {
      return postgresHashGetAll<T>(key);
    }
    if (durableKvBackend() === "redis") {
      return redisHashGetAll<T>(key);
    }
    return upstashKv.hgetall<T>(key);
  },

  async hset(key: string, values: Record<string, unknown>): Promise<number> {
    if (durableKvBackend() === "postgres") {
      return postgresHashSet(key, values);
    }
    if (durableKvBackend() === "redis") {
      return redisHashSet(key, values);
    }
    return upstashKv.hset(key, values);
  },

  async hdel(key: string, field: string): Promise<number> {
    if (durableKvBackend() === "postgres") {
      const result = await postgresQuery(
        `DELETE FROM plank_kv_hash_fields
          WHERE key_name = $1 AND field_name = $2`,
        [key, field]
      );
      return result.rowCount ?? 0;
    }
    if (durableKvBackend() === "redis") {
      return (await getRedisClient()).hDel(key, field);
    }
    return upstashKv.hdel(key, field);
  },

  async sadd(key: string, value: string): Promise<number> {
    if (durableKvBackend() === "postgres") {
      const result = await postgresQuery(
        `INSERT INTO plank_kv_set_members (key_name, member_value)
         VALUES ($1, $2)
         ON CONFLICT DO NOTHING`,
        [key, value]
      );
      return result.rowCount ?? 0;
    }
    if (durableKvBackend() === "redis") {
      return (await getRedisClient()).sAdd(key, value);
    }
    return upstashKv.sadd(key, value);
  },

  async sismember(key: string, value: string): Promise<number> {
    if (durableKvBackend() === "postgres") {
      const result = await postgresQuery(
        `SELECT 1
           FROM plank_kv_set_members
          WHERE key_name = $1 AND member_value = $2`,
        [key, value]
      );
      return result.rowCount === 1 ? 1 : 0;
    }
    if (durableKvBackend() === "redis") {
      return (await (await getRedisClient()).sIsMember(key, value)) ? 1 : 0;
    }
    return upstashKv.sismember(key, value);
  },
};
