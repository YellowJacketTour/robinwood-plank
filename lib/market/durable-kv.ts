import {
  hasPostgresConfig,
  postgresQuery,
  withPostgresTransaction,
} from "@/lib/postgres";

/**
 * Durable key/value adapter used by the marketplace.
 *
 * PostgreSQL is the only datastore. The Upstash/Vercel KV and Redis backends
 * this module used to carry were inherited from the pre-PostgreSQL design and
 * were dead — every environment sets DURABLE_KV_BACKEND=postgres. They were not
 * merely unused: their top-level `import { createClient } from "redis"` and
 * `import { kv } from "@vercel/kv"` were unresolvable in the standalone
 * Passenger release, whose node_modules is traced from what the app actually
 * uses. That broke the market-refresh cron with ERR_MODULE_NOT_FOUND the first
 * time it ran. Do not reintroduce them.
 *
 * The KV-shaped surface (get/set/hget/hset/sadd) is kept because callers depend
 * on it and the schema preserved those semantics during the migration — see
 * INMOTION_DEPLOYMENT.md section 11.
 */

export type DurableKvBackend = "postgres" | null;
type SetOptions = { ex?: number };

export function durableKvBackend(): DurableKvBackend {
  const requested = process.env.DURABLE_KV_BACKEND?.trim().toLowerCase();
  if (requested && requested !== "postgres") {
    throw new Error(
      `DURABLE_KV_BACKEND must be "postgres", received "${requested}". PostgreSQL is the only supported datastore.`
    );
  }
  if (requested === "postgres" && !hasPostgresConfig()) {
    throw new Error(
      "DURABLE_KV_BACKEND=postgres requires PGHOST, PGDATABASE, PGUSER, and PGPASSWORD."
    );
  }
  return hasPostgresConfig() ? "postgres" : null;
}

export function hasDurableKv(): boolean {
  return durableKvBackend() !== null;
}

/**
 * JSON codec for stored values. Named for the Redis-compatible semantics the
 * schema preserves, not for a Redis dependency — there is none.
 */
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
    // Tolerate values written manually or by an older non-JSON client.
    return value as T;
  }
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
    return postgresGet<T>(key);
  },

  async set(key: string, value: unknown, options?: SetOptions): Promise<unknown> {
    return postgresSet(key, value, options);
  },

  async hget<T>(key: string, field: string): Promise<T | null> {
    return postgresHashGet<T>(key, field);
  },

  async hgetall<T extends Record<string, unknown>>(
    key: string
  ): Promise<T | null> {
    return postgresHashGetAll<T>(key);
  },

  async hset(key: string, values: Record<string, unknown>): Promise<number> {
    return postgresHashSet(key, values);
  },

  async hdel(key: string, field: string): Promise<number> {
    const result = await postgresQuery(
      `DELETE FROM plank_kv_hash_fields
        WHERE key_name = $1 AND field_name = $2`,
      [key, field]
    );
    return result.rowCount ?? 0;
  },

  async sadd(key: string, value: string): Promise<number> {
    const result = await postgresQuery(
      `INSERT INTO plank_kv_set_members (key_name, member_value)
       VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [key, value]
    );
    return result.rowCount ?? 0;
  },

  async sismember(key: string, value: string): Promise<number> {
    const result = await postgresQuery(
      `SELECT 1
         FROM plank_kv_set_members
        WHERE key_name = $1 AND member_value = $2`,
      [key, value]
    );
    return result.rowCount === 1 ? 1 : 0;
  },
};
