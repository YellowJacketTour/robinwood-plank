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
  // Legacy vars, kept in the reset list so a stray value in the environment
  // cannot influence these assertions. Nothing reads them any more.
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

test("PostgreSQL is selected when it is configured", () => {
  withEnv(
    {
      PGHOST: "localhost",
      PGDATABASE: "plank",
      PGUSER: "plankapp",
      PGPASSWORD: "secret",
    },
    () => assert.equal(durableKvBackend(), "postgres")
  );
});

test("legacy KV credentials no longer select a backend", () => {
  // Redis and Upstash are gone. Leftover credentials in an environment must not
  // resurrect them — their top-level imports were unresolvable in the
  // standalone release and broke the market-refresh cron.
  withEnv(
    {
      REDIS_URL: "redis://valkey:6379",
      KV_REST_API_URL: "https://example.upstash.io",
      KV_REST_API_TOKEN: "token",
    },
    () => assert.equal(durableKvBackend(), null)
  );
});

test("an unsupported backend is rejected rather than silently ignored", () => {
  for (const backend of ["redis", "upstash", "sqlite"]) {
    withEnv({ DURABLE_KV_BACKEND: backend }, () => {
      assert.throws(() => durableKvBackend(), /only supported datastore/);
    });
  }
});

test("explicit postgres selection fails closed when its credentials are absent", () => {
  withEnv({ DURABLE_KV_BACKEND: "postgres" }, () => {
    assert.throws(() => durableKvBackend(), /requires PGHOST/);
  });
});
