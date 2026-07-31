import assert from "node:assert/strict";
import test from "node:test";

/**
 * Free OpenSea keys expire after 30 days. An expiry nobody notices would make
 * collection volume quietly stop updating — the same shape of bug as the sales
 * catalog expiring with nothing to rebuild it, which is what started this whole
 * investigation. These pin the renewal rules.
 */

type Stored = {
  apiKey: string;
  expiresAt: string;
  issuedAt: number;
  name?: string;
  lastAttemptAt?: number;
};

function load(store: Map<string, unknown>, issueKey?: () => Response | Promise<Response>) {
  process.env.DURABLE_KV_BACKEND = "postgres";
  process.env.PGHOST = "opensea-test.invalid";
  process.env.PGDATABASE = "t";
  process.env.PGUSER = "t";
  process.env.PGPASSWORD = "t";
  delete process.env.OPENSEA_API_KEY;

  return async () => {
    const kvModule = await import("../../lib/market/durable-kv");
    const kv = kvModule.durableKv as unknown as Record<string, unknown>;
    kv.get = async (key: string) => store.get(key) ?? null;
    kv.set = async (key: string, value: unknown) => {
      store.set(key, value);
      return "OK";
    };
    if (issueKey) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      globalThis.fetch = (async () => issueKey()) as any;
    }
    return import("../../lib/market/opensea");
  };
}

const KEY = "plank:market:opensea-api-key-v1";
const okResponse = (expiresAt: string) =>
  ({
    ok: true,
    status: 200,
    json: async () => ({ api_key: "issued-key", expires_at: expiresAt, name: "test" }),
    text: async () => "",
  }) as unknown as Response;

const daysFromNow = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString();

test("a key with plenty of life left is not renewed", async () => {
  const store = new Map<string, unknown>();
  store.set(KEY, {
    apiKey: "existing",
    expiresAt: daysFromNow(25),
    issuedAt: Date.now(),
  } satisfies Stored);
  let requested = false;
  const { ensureOpenSeaKey } = await load(store, () => {
    requested = true;
    return okResponse(daysFromNow(30));
  })();

  const result = await ensureOpenSeaKey();
  assert.equal(result.status, "fresh");
  assert.equal(requested, false, "must not burn the hourly key-issuance quota needlessly");
});

test("a key close to expiry is renewed before it lapses", async () => {
  const store = new Map<string, unknown>();
  store.set(KEY, {
    apiKey: "old",
    expiresAt: daysFromNow(3), // inside the 7-day renewal window
    issuedAt: Date.now() - 27 * 86_400_000,
    lastAttemptAt: Date.now() - 3 * 60 * 60 * 1000,
  } satisfies Stored);
  const { ensureOpenSeaKey, getOpenSeaApiKey } = await load(store, () =>
    okResponse(daysFromNow(30))
  )();

  const result = await ensureOpenSeaKey();
  assert.equal(result.status, "renewed");
  assert.equal(await getOpenSeaApiKey(), "issued-key", "the new key must be the one served");
});

test("a just-attempted renewal waits a cycle rather than retrying immediately", async () => {
  const store = new Map<string, unknown>();
  store.set(KEY, {
    apiKey: "old",
    expiresAt: daysFromNow(1),
    issuedAt: Date.now(),
    lastAttemptAt: Date.now() - 60 * 1000, // one minute ago
  } satisfies Stored);
  let requested = false;
  const { ensureOpenSeaKey } = await load(store, () => {
    requested = true;
    return okResponse(daysFromNow(30));
  })();

  const result = await ensureOpenSeaKey();
  assert.equal(result.status, "cooldown");
  assert.equal(requested, false, "hammering a rate-limited endpoint never recovers");
});

test("a failed key request burns the cooldown so it cannot retry-loop", async () => {
  const store = new Map<string, unknown>();
  const { ensureOpenSeaKey } = await load(
    store,
    () =>
      ({
        ok: false,
        status: 429,
        text: async () => '{"errors":["Key creation rate limit exceeded."]}',
        json: async () => ({}),
      }) as unknown as Response
  )();

  const result = await ensureOpenSeaKey();
  assert.equal(result.status, "failed");
  const stored = store.get(KEY) as Stored | undefined;
  assert.ok(stored?.lastAttemptAt, "a failed attempt must still record its timestamp");
});

test("an explicit OPENSEA_API_KEY wins and is never rotated", async () => {
  const store = new Map<string, unknown>();
  let requested = false;
  const loader = load(store, () => {
    requested = true;
    return okResponse(daysFromNow(30));
  });
  const { ensureOpenSeaKey, getOpenSeaApiKey } = await loader();
  process.env.OPENSEA_API_KEY = "full-key-from-portal";
  try {
    const result = await ensureOpenSeaKey();
    assert.equal(result.status, "env");
    assert.equal(requested, false, "a full key must never be replaced by a 30-day free one");
    assert.equal(await getOpenSeaApiKey(), "full-key-from-portal");
  } finally {
    delete process.env.OPENSEA_API_KEY;
  }
});

test("key status never leaks the key itself", async () => {
  const store = new Map<string, unknown>();
  // 12.5 days, not 12: an exact day boundary makes Math.floor return 11 or 12
  // depending on how many milliseconds elapse before the assertion, which is a
  // flake that only shows up on a fast enough machine.
  store.set(KEY, {
    apiKey: "super-secret-value",
    expiresAt: daysFromNow(12.5),
    issuedAt: Date.now(),
  } satisfies Stored);
  const { openSeaKeyStatus } = await load(store)();

  const status = await openSeaKeyStatus();
  assert.equal(status.source, "managed");
  assert.equal(status.daysRemaining, 12);
  assert.ok(
    !JSON.stringify(status).includes("super-secret-value"),
    "health output must never carry the credential"
  );
});
