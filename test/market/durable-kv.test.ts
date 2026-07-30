import assert from "node:assert/strict";
import test from "node:test";
import {
  deserializeRedisValue,
  durableKvBackend,
  serializeRedisValue,
} from "../../lib/market/durable-kv";

const KEYS = [
  "DURABLE_KV_BACKEND",
  "PGHOST",
  "PGDATABASE",
  "PGUSER",
  "PGPASSWORD",
  "REDIS_URL",
  "KV_REST_API_URL",
  "KV_REST_API_TOKEN",
] as const;

function withEnv(
  values: Partial<Record<(typeof KEYS)[number], string>>,
  run: () => void
) {
  const previous = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
  try {
    for (const key of KEYS) delete process.env[key];
    for (const [key, value] of Object.entries(values)) {
      if (value !== undefined) process.env[key] = value;
    }
    run();
  } finally {
    for (const key of KEYS) {
      const value = previous[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("Redis JSON codec preserves objects, arrays, numbers, booleans, and strings", () => {
  const value = {
    order: { id: "listing-1", priceWei: "4206900000000000" },
    live: true,
    attempts: 3,
    tags: ["plank", "market"],
  };
  assert.deepEqual(
    deserializeRedisValue(serializeRedisValue(value)),
    value
  );
  assert.equal(
    deserializeRedisValue<string>(serializeRedisValue("plain-string")),
    "plain-string"
  );
});

test("Redis JSON codec tolerates legacy raw string values", () => {
  assert.equal(deserializeRedisValue<string>("legacy"), "legacy");
  assert.equal(deserializeRedisValue(null), null);
  assert.throws(() => serializeRedisValue(undefined), /undefined/);
});

test("backend selection prefers the VPS Redis URL when both stores exist", () => {
  withEnv(
    {
      REDIS_URL: "redis://valkey:6379",
      KV_REST_API_URL: "https://example.upstash.io",
      KV_REST_API_TOKEN: "token",
    },
    () => assert.equal(durableKvBackend(), "redis")
  );
});

test("backend selection prefers local PostgreSQL when it is configured", () => {
  withEnv(
    {
      PGHOST: "localhost",
      PGDATABASE: "plank",
      PGUSER: "plankapp",
      PGPASSWORD: "secret",
      REDIS_URL: "redis://valkey:6379",
    },
    () => assert.equal(durableKvBackend(), "postgres")
  );
});

test("backend selection retains Upstash compatibility", () => {
  withEnv(
    {
      KV_REST_API_URL: "https://example.upstash.io",
      KV_REST_API_TOKEN: "token",
    },
    () => assert.equal(durableKvBackend(), "upstash")
  );
});

test("explicit backend selection fails closed when its credentials are absent", () => {
  withEnv({ DURABLE_KV_BACKEND: "postgres" }, () => {
    assert.throws(() => durableKvBackend(), /requires PGHOST/);
  });
  withEnv({ DURABLE_KV_BACKEND: "redis" }, () => {
    assert.throws(() => durableKvBackend(), /requires REDIS_URL/);
  });
  withEnv({ DURABLE_KV_BACKEND: "upstash" }, () => {
    assert.throws(() => durableKvBackend(), /requires KV_REST_API_URL/);
  });
});
