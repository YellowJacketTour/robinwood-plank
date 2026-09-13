import { test } from "node:test";
import assert from "node:assert/strict";
import { localRuntimeFixtureEnabled, localRuntimeFixtureRequestAllowed } from "../../app/api/charmville/local-runtime-fixture/policy";
const env = { NODE_ENV: "development", CHARMVILLE_LOCAL_RUNTIME_FIXTURE: "1", CHARMVILLE_ACCESS_MODE: "private", PGHOST: "127.0.0.1", PGPORT: "55419", PGUSER: "charmtest", PGDATABASE: "charmville_acceptance_20260913", CHARMVILLE_RUNTIME_FIXTURE_FILE: "operator-private-file" };
test("synthetic login requires exact optin development cluster", () => {
  assert.equal(localRuntimeFixtureEnabled(env), true);
  for (const key of Object.keys(env)) assert.equal(localRuntimeFixtureEnabled({ ...env, [key]: undefined }), false, key);
  for (const changed of [{ NODE_ENV: "production" }, { PGPORT: "5432" }, { PGHOST: "localhost" }, { PGDATABASE: "plankspace" }, { PGUSER: "postgres" }]) assert.equal(localRuntimeFixtureEnabled({ ...env, ...changed }), false);
});
test("synthetic login refuses foreign origin GET forwardedhost and other localports", () => {
  const headers = { origin: "http://localhost:3018", host: "localhost:3018", "sec-fetch-site": "same-origin" };
  assert.equal(localRuntimeFixtureRequestAllowed(new Request("http://localhost:3018/api/charmville/local-runtime-fixture", { method: "POST", headers }), env), true);
  for (const changed of [{ origin: "https://evil.test" }, { host: "127.0.0.1:3018" }, { "x-forwarded-host": "evil.test" }, { "sec-fetch-site": "cross-site" }]) assert.equal(localRuntimeFixtureRequestAllowed(new Request("http://localhost:3018/api/charmville/local-runtime-fixture", { method: "POST", headers: { ...headers, ...changed } }), env), false);
  assert.equal(localRuntimeFixtureRequestAllowed(new Request("http://localhost:3017/api/charmville/local-runtime-fixture", { method: "POST", headers }), env), false);
  assert.equal(localRuntimeFixtureRequestAllowed(new Request("http://localhost:3018/api/charmville/local-runtime-fixture", { headers }), env), false);
});
