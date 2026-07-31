import assert from "node:assert/strict";
import test from "node:test";
import {
  deserializeStoredValue,
  durableKvBackend,
  serializeStoredValue,
} from "../../lib/market/durable-kv";

/**
 * Locks in the PostgreSQL-only storage contract (owner direction
 * 2026-07-31: Redis/Upstash were dead legacy from a prior deployment target
 * and were deleted, not shimmed):
 * - backend selection is postgres-or-nothing, and asking for a removed
 *   backend is a hard, descriptive error — never a silent fallback;
 * - the JSON codec round-trips every shape consumers store.
 */

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

const PG = {
  PGHOST: "localhost",
  PGDATABASE: "plank",
  PGUSER: "plank",
  PGPASSWORD: "secret",
};

test("JSON codec preserves objects, arrays, numbers, booleans, and strings", () => {
  const values: unknown[] = [
    { a: 1, b: [true, "x"], c: { nested: null } },
    ["a", 2, false],
    42,
    true,
    "plain",
  ];
  for (const value of values) {
    assert.deepEqual(deserializeStoredValue(serializeStoredValue(value)), value);
  }
  assert.equal(deserializeStoredValue<string>("legacy"), "legacy");
  assert.equal(deserializeStoredValue(null), null);
  assert.throws(() => serializeStoredValue(undefined), /undefined/);
});

test("postgres config selects postgres, explicitly or by default", () => {
  withEnv({ ...PG, DURABLE_KV_BACKEND: "postgres" }, () =>
    assert.equal(durableKvBackend(), "postgres")
  );
  withEnv(PG, () => assert.equal(durableKvBackend(), "postgres"));
});

test("no postgres config means no durable backend (dev file fallback)", () => {
  withEnv({}, () => assert.equal(durableKvBackend(), null));
});

test("explicit postgres without credentials fails closed", () => {
  withEnv({ DURABLE_KV_BACKEND: "postgres" }, () =>
    assert.throws(() => durableKvBackend(), /requires PGHOST/)
  );
});

test("removed backends are a hard error, never a silent fallback", () => {
  withEnv({ ...PG, DURABLE_KV_BACKEND: "redis", REDIS_URL: "redis://x" }, () =>
    assert.throws(() => durableKvBackend(), /removed/)
  );
  withEnv(
    {
      ...PG,
      DURABLE_KV_BACKEND: "upstash",
      KV_REST_API_URL: "https://x",
      KV_REST_API_TOKEN: "t",
    },
    () => assert.throws(() => durableKvBackend(), /removed/)
  );
  withEnv({ ...PG, DURABLE_KV_BACKEND: "bogus" }, () =>
    assert.throws(() => durableKvBackend(), /must be "postgres"/)
  );
});

test("legacy Redis/Upstash env vars alone no longer select anything", () => {
  withEnv({ REDIS_URL: "redis://x" }, () =>
    assert.equal(durableKvBackend(), null)
  );
  withEnv(
    { KV_REST_API_URL: "https://x", KV_REST_API_TOKEN: "t" },
    () => assert.equal(durableKvBackend(), null)
  );
});
