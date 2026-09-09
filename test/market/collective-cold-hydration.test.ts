import assert from "node:assert/strict";
import test from "node:test";
import {spawn} from "node:child_process";
import {createServer, type ServerResponse} from "node:http";
import {once} from "node:events";
import {hasPostgresConfig, postgresQuery, closePostgres} from "../../lib/postgres";
import {durableKv} from "../../lib/market/durable-kv";
import {getOrRefreshWithMeta} from "../../lib/market/multichain/singleflight-cache";

function worker(key: string, url: string) {
  const child = spawn(process.execPath, ["--import", "tsx", "test/market/fixtures/shared-refresh-worker.ts", key, url], {windowsHide: true, stdio: ["ignore", "pipe", "pipe"]});
  let stdout = ""; let stderr = "";
  child.stdout.on("data", chunk => {stdout += chunk;});
  child.stderr.on("data", chunk => {stderr += chunk;});
  return {child, result: new Promise<{ok: boolean; value?: string; freshness?: string; error?: string}>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", () => {try {resolve(JSON.parse(stdout.trim()));} catch {reject(new Error(stderr || stdout));}});
  })};
}
const waitFor = async (ready: () => boolean) => {
  const end = Date.now() + 15000;
  while (!ready() && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(ready(), "worker reached provider");
};

test("six independent cold server processes share one provider request", {skip: !hasPostgresConfig(), timeout: 30000}, async () => {
  const key = `shared-cold-${process.pid}-${Date.now()}`;
  let calls = 0;
  const server = createServer((_req, res) => {calls++; setTimeout(() => res.end("shared-canonical-value"), 1000);});
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const url = `http://127.0.0.1:${(server.address() as {port: number}).port}`;
  const children = Array.from({length: 6}, () => worker(key, url));
  try {
    const values = await Promise.all(children.map(child => child.result));
    assert.ok(values.every(result => result.ok && result.value === "shared-canonical-value"));
    assert.equal(calls, 1, "cold lease losers must join, never bypass the lease");
    const started = performance.now();
    const warm = await getOrRefreshWithMeta(key, {softTtlMs: 5000, hardTtlMs: 10000}, async () => {throw new Error("warm request must not fetch");});
    assert.equal(warm.value, "shared-canonical-value");
    assert.equal(warm.freshness, "cached");
    console.log(JSON.stringify({probe: "collective-cold-hydration", processes: 6, providerCalls: calls, warmReadMs: Math.round(performance.now()-started)}));
  } finally {
    children.forEach(child => child.child.kill()); server.closeAllConnections(); server.close();
    await postgresQuery("DELETE FROM plank_kv_values WHERE key_name=ANY($1::text[])", [[`plank:singleflight:${key}`, `plank:singleflight:${key}:lease`]]);
  }
});

test("a displaced refresh cannot publish old data or release the newer owner's lease", {skip: !hasPostgresConfig(), timeout: 30000}, async () => {
  const key = `shared-fence-${process.pid}-${Date.now()}`;
  const full = `plank:singleflight:${key}`;
  const responses = new Map<string, ServerResponse>();
  const server = createServer((req, res) => responses.set(req.url!, res));
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as {port: number}).port}`;
  const old = worker(key, `${base}/old`);
  let newer: ReturnType<typeof worker> | undefined;
  try {
    await waitFor(() => responses.has("/old"));
    // Simulate the lease expiring while the original provider request is delayed.
    await durableKv.set(`${full}:lease`, 0);
    newer = worker(key, `${base}/new`);
    await waitFor(() => responses.has("/new"));
    const owner = await durableKv.get<number>(`${full}:lease`);
    responses.get("/old")!.end("obsolete-value");
    const oldResult = await old.result;
    assert.equal(oldResult.ok, false, "displaced owner cannot pretend it published");
    assert.match(oldResult.error ?? "", /lease_lost/);
    assert.equal(await durableKv.get(`${full}:lease`), owner, "old finally cannot release a newer lease");
    assert.equal(await durableKv.get(full), null, "obsolete data was never published");
    responses.get("/new")!.end("newest-value");
    assert.equal((await newer.result).value, "newest-value");
    assert.equal((await durableKv.get<{value: string}>(full))?.value, "newest-value");
  } finally {
    old.child.kill(); newer?.child.kill(); responses.forEach(res => res.end()); server.closeAllConnections(); server.close();
    await postgresQuery("DELETE FROM plank_kv_values WHERE key_name=ANY($1::text[])", [[full, `${full}:lease`]]);
  }
});

test("a slow shared refresh renews ownership and still makes one provider call", {skip: !hasPostgresConfig(), timeout: 35000}, async () => {
  const key = `shared-renewal-${process.pid}-${Date.now()}`;
  const full = `plank:singleflight:${key}`;
  let calls = 0;
  const responses: ServerResponse[] = [];
  const server = createServer((_req, res) => {calls++; responses.push(res);});
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const url = `http://127.0.0.1:${(server.address() as {port: number}).port}`;
  const first = worker(key, url);
  let second: ReturnType<typeof worker> | undefined;
  try {
    await waitFor(() => responses.length === 1);
    const originalLease = await durableKv.get<number>(`${full}:lease`);
    await new Promise(resolve => setTimeout(resolve, 15500));
    assert.ok((await durableKv.get<number>(`${full}:lease`))! > originalLease!, "ownership renewed beyond original expiry");
    second = worker(key, url);
    await new Promise(resolve => setTimeout(resolve, 700));
    assert.equal(calls, 1, "follower cannot treat the original lease expiry as unowned work");
    responses.forEach(res => res.end("slow-shared-value"));
    assert.equal((await first.result).value, "slow-shared-value");
    assert.equal((await second.result).value, "slow-shared-value");
  } finally {
    first.child.kill(); second?.child.kill(); responses.forEach(res => res.end()); server.closeAllConnections(); server.close();
    await postgresQuery("DELETE FROM plank_kv_values WHERE key_name=ANY($1::text[])", [[full, `${full}:lease`]]);
  }
});

test("failed refresh serves last-good data with truthful cached metadata", {skip: !hasPostgresConfig()}, async () => {
  const key = `shared-failure-${process.pid}-${Date.now()}`;
  const full = `plank:singleflight:${key}`;
  try {
    await durableKv.set(full, {value: "last-good", cachedAt: Date.now()-60000});
    const result = await getOrRefreshWithMeta(key, {softTtlMs: 1, hardTtlMs: 2}, async () => {throw new Error("provider unavailable");});
    assert.equal(result.value, "last-good");
    assert.equal(result.freshness, "cached");
    assert.ok(result.ageMs && result.ageMs >= 60000);
  } finally {
    await postgresQuery("DELETE FROM plank_kv_values WHERE key_name=ANY($1::text[])", [[full, `${full}:lease`]]);
    await closePostgres();
  }
});
