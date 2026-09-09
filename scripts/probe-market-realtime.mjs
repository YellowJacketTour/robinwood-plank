import assert from "node:assert/strict";
import { once } from "node:events";
import WebSocket from "ws";
import { Pool } from "pg";

const target = new URL(process.argv[2] ?? "http://127.0.0.1:3809");
if (target.hostname !== "127.0.0.1" || !/test/i.test(process.env.PGDATABASE ?? "")) {
  throw new Error("Probe requires loopback Next server and disposable test database.");
}
const pool = new Pool();
const key = `realtime-probe-${Date.now()}AbC`;
const scope = { chainSlug: "solana-mainnet", collectionKey: key };
const sockets = [];
const latencies = [];
let start = 0;
const timeout = setTimeout(() => { console.error("probe deadline exceeded"); process.exit(1); }, 20_000);
try {
  const inserted = await pool.query(`INSERT INTO plank_multichain_collections (chain_slug, contract_address, adapter, name)
    VALUES ($1, $2, 'probe', 'Local realtime fixture') RETURNING id`, [scope.chainSlug, key]);
  const id = inserted.rows[0].id;
  await pool.query(`INSERT INTO plank_multichain_snapshots (collection_id, floor_price_wei, floor_price_currency, listed_count)
    VALUES ($1, 42, 'SOL', 1)`, [id]);
  const ready = [];
  const delivered = [];
  for (let n = 0; n < 100; n++) {
    const ws = new WebSocket(`${target.origin.replace("http:", "ws:")}/api/market/multichain/socket`, { origin: target.origin });
    sockets.push(ws);
    ready.push(new Promise((resolve, reject) => {
      ws.once("error", reject);
      ws.on("message", (raw) => { if (JSON.parse(raw.toString()).type === "resync") resolve(); });
    }));
    delivered.push(new Promise((resolve) => ws.on("message", (raw) => {
      const change = JSON.parse(raw.toString());
      if (change.type === "invalidate" && change.family === "tokens") {
        latencies.push(performance.now() - start); resolve();
      }
    })));
    await once(ws, "open");
    ws.send(JSON.stringify({ scopes: [scope] }));
  }
  await Promise.all(ready);
  const listeners = await pool.query("SELECT COUNT(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND application_name = 'plank-market-changes'");
  assert.equal(listeners.rows[0].n, 1, "100 sockets share one database listener");
  start = performance.now();
  await pool.query(`INSERT INTO plank_collection_tokens (chain_slug, collection_slug, token_id, source_observed_at)
    VALUES ($1, $2, '1', NOW())`, [scope.chainSlug, key]);
  await Promise.all(delivered);
  latencies.sort((a, b) => a - b);
  await pool.query("UPDATE plank_multichain_snapshots SET floor_price_wei = 84 WHERE collection_id = $1", [id]);
  const response = await fetch(`${target.origin}/api/market/multichain/changes/snapshot?scopes=${encodeURIComponent(JSON.stringify([scope]))}`);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).collections[0].floorPriceWei, "84");
  assert.match(response.headers.get("cache-control"), /no-store/);
  const controller = new AbortController();
  const sse = await fetch(`${target.origin}/api/market/multichain/changes?scopes=${encodeURIComponent(JSON.stringify([scope]))}`, { signal: controller.signal });
  assert.match(sse.headers.get("content-type"), /text\/event-stream/);
  const reader = sse.body.getReader();
  const first = await reader.read();
  assert.match(new TextDecoder().decode(first.value), /resync/);
  controller.abort();
  await reader.cancel().catch(() => {});
  console.log(JSON.stringify({ via: "Next production external rewrite", sockets: 100, postgresListeners: listeners.rows[0].n,
    received: latencies.length, insertToDeliveryMs: { p50: Math.round(latencies[49]), p95: Math.round(latencies[94]), max: Math.round(latencies[99]) },
    snapshotRead: "passed", sseFallback: "passed", syntheticLocalProbe: true }));
} finally {
  clearTimeout(timeout);
  for (const ws of sockets) ws.terminate();
  await pool.query("DELETE FROM plank_collection_tokens WHERE collection_slug = $1", [key]);
  await pool.query("DELETE FROM plank_multichain_collections WHERE chain_slug = $1 AND contract_address = $2", [scope.chainSlug, key]);
  await pool.end();
}
