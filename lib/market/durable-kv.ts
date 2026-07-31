import {
  hasPostgresConfig,
  postgresQuery,
  withPostgresTransaction,
} from "@/lib/postgres";

/**
 * Durable storage adapter — PostgreSQL only.
 *
 * The Redis and Upstash/Vercel-KV backends this adapter once multiplexed
 * were legacy from a prior deployment target and were REMOVED on owner
 * direction (2026-07-31): the stack is PostgreSQL, full stop. The
 * key/hash/set API surface predates that decision (the table names
 * plank_kv_values / plank_kv_hash_fields / plank_kv_set_members are part of
 * the released schema, which is append-only), so the shape stays — but there
 * is exactly one implementation behind it.
 *
 * Selection:
 *   DURABLE_KV_BACKEND=postgres (or unset) -> PostgreSQL when
 *     PGHOST/PGDATABASE/PGUSER/PGPASSWORD are configured
 *   no PostgreSQL config                   -> null (consumers fall back to
 *     their .data/ file + in-memory dev stores)
 *   any other DURABLE_KV_BACKEND value     -> hard error, fail closed
 */

export type DurableKvBackend = "postgres" | null;
type SetOptions = { ex?: number };

export function durableKvBackend(): DurableKvBackend {
  const requested = process.env.DURABLE_KV_BACKEND?.trim().toLowerCase();
  if (requested && requested !== "postgres") {
    throw new Error(
      `DURABLE_KV_BACKEND must be "postgres" (Redis/Upstash support was removed), received "${requested}".`
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

export function serializeStoredValue(value: unknown): string {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) {
    throw new TypeError("Cannot store undefined in durable storage.");
  }
  return encoded;
}

export function deserializeStoredValue<T>(value: string | null): T | null {
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
  const encoded = serializeStoredValue(value);
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

/**
 * Minimal API shared by every current marketplace consumer. Keeping this
 * surface intentionally small makes storage changes reviewable.
 */
export const durableKv = {
  async get<T>(key: string): Promise<T | null> {
    return postgresGet<T>(key);
  },

  async set(key: string, value: unknown, options?: SetOptions): Promise<unknown> {
    return postgresSet(key, value, options);
  },

  async hget<T>(key: string, field: string): Promise<T | null> {
    const result = await postgresQuery<{ value: T }>(
      `SELECT value
         FROM plank_kv_hash_fields
        WHERE key_name = $1 AND field_name = $2`,
      [key, field]
    );
    return result.rows[0]?.value ?? null;
  },

  async hgetall<T extends Record<string, unknown>>(
    key: string
  ): Promise<T | null> {
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
  },

  async hset(key: string, values: Record<string, unknown>): Promise<number> {
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
          [key, field, serializeStoredValue(value)]
        );
      }
    });
    return entries.length;
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
