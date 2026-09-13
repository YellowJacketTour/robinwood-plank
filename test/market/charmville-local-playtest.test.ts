import { test } from "node:test";
import assert from "node:assert/strict";
import { localPlaytestEnabled, localPlaytestRequestAllowed } from "../../lib/charmville/local-playtest-policy";

const env = {NODE_ENV:"development",CHARMVILLE_LOCAL_PLAYTEST:"1",CHARMVILLE_TEST_DATABASE_URL:"postgres://charmville:local@127.0.0.1:55417/postgres",PGHOST:"127.0.0.1",PGPORT:"55417",PGUSER:"charmville",PGPASSWORD:"local",PGDATABASE:"postgres"};
const request = (headers: Record<string,string> = {}) => new Request("http://localhost:3017/api/charmville/local-playtest", {method:"POST",headers:{host:"localhost:3017",origin:"http://localhost:3017",...headers}});
test("local entry requires explicit development opt in and designated isolated cluster", () => {
  assert.equal(localPlaytestEnabled(env), true);
  for (const change of [{NODE_ENV:"production"},{NODE_ENV:"test"},{CHARMVILLE_LOCAL_PLAYTEST:"0"},{PGHOST:"example.com"},{PGUSER:"postgres"},{PGDATABASE:"real"},{PGPORT:"5432"},{PGPASSWORD:"wrong"},{CHARMVILLE_TEST_DATABASE_URL:"postgres://charmville:local@127.0.0.1:5432/postgres",PGPORT:"5432"}]) assert.equal(localPlaytestEnabled({...env,...change}), false);
});
test("local entry refuses remote, cross-origin, and forwarded requests", () => {
  assert.equal(localPlaytestRequestAllowed(request(),env),true);
  for (const headers of [{origin:"https://evil.test"},{host:"evil.test"},{"x-forwarded-host":"evil.test"},{"sec-fetch-site":"cross-site"},{origin:""}]) assert.equal(localPlaytestRequestAllowed(request(headers),env),false);
  assert.equal(localPlaytestRequestAllowed(new Request("https://plank.love/api/charmville/local-playtest",{method:"POST",headers:{origin:"https://plank.love"}}),env),false);
});
