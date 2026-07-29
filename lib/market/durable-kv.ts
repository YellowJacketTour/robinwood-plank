import { kv as upstashKv } from "@vercel/kv";
import { createClient } from "redis";

/**
 * Durable key/value adapter used by the marketplace.
 *
 * Existing deployments can keep using Upstash/Vercel KV unchanged. A VPS can
 * instead set REDIS_URL and optionally REDIS_USERNAME / REDIS_PASSWORD /
 * REDIS_DATABASE to use a normal Redis or Valkey server over RESP.
 *
 * Selection:
 *   DURABLE_KV_BACKEND=redis   -> require REDIS_URL
 *   DURABLE_KV_BACKEND=upstash -> require KV_REST_API_URL + KV_REST_API_TOKEN
 *   unset                      -> Redis first, then Upstash
 */

export type DurableKvBackend = "redis" | "upstash" | null;
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
  if (requested && requested !== "redis" && requested !== "upstash") {
    throw new Error(
      `DURABLE_KV_BACKEND must be "redis" or "upstash", received "${requested}".`
    );
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

/**
 * Minimal API shared by every current marketplace consumer. Keeping this
 * surface intentionally small makes storage migrations reviewable.
 */
export const durableKv = {
  async get<T>(key: string): Promise<T | null> {
    if (durableKvBackend() === "redis") return redisGet<T>(key);
    return upstashKv.get<T>(key);
  },

  async set(key: string, value: unknown, options?: SetOptions): Promise<unknown> {
    if (durableKvBackend() === "redis") {
      return redisSet(key, value, options);
    }
    if (options?.ex) {
      return upstashKv.set(key, value, { ex: options.ex });
    }
    return upstashKv.set(key, value);
  },

  async hget<T>(key: string, field: string): Promise<T | null> {
    if (durableKvBackend() === "redis") {
      return redisHashGet<T>(key, field);
    }
    return upstashKv.hget<T>(key, field);
  },

  async hgetall<T extends Record<string, unknown>>(
    key: string
  ): Promise<T | null> {
    if (durableKvBackend() === "redis") {
      return redisHashGetAll<T>(key);
    }
    return upstashKv.hgetall<T>(key);
  },

  async hset(key: string, values: Record<string, unknown>): Promise<number> {
    if (durableKvBackend() === "redis") {
      return redisHashSet(key, values);
    }
    return upstashKv.hset(key, values);
  },

  async hdel(key: string, field: string): Promise<number> {
    if (durableKvBackend() === "redis") {
      return (await getRedisClient()).hDel(key, field);
    }
    return upstashKv.hdel(key, field);
  },

  async sadd(key: string, value: string): Promise<number> {
    if (durableKvBackend() === "redis") {
      return (await getRedisClient()).sAdd(key, value);
    }
    return upstashKv.sadd(key, value);
  },

  async sismember(key: string, value: string): Promise<number> {
    if (durableKvBackend() === "redis") {
      return (await (await getRedisClient()).sIsMember(key, value)) ? 1 : 0;
    }
    return upstashKv.sismember(key, value);
  },
};
