import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { Client } from "pg";
import WebSocket from "ws";
import { MarketChangeFeed } from "../../lib/market/multichain/edge/change-feed";
import { createMarketSocketServer } from "../../lib/market/multichain/edge/socket-server";
import { matchesChange, parseChange, parseScopes, type MarketChange } from "../../lib/market/multichain/edge/change-protocol";
import { hasPostgresConfig, postgresPool, postgresQuery, closePostgres } from "../../lib/postgres";
import { demandIntentKey } from "../../lib/market/demand-intent-key";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean) {
  const deadline = Date.now() + 8_000;
  while (!check() && Date.now() < deadline) await wait(20);
  assert.ok(check(), "condition reached within 8s");
}
const changed = (chainSlug: string, collectionKey: string): MarketChange => ({
  type: "invalidate", family: "tokens", scopes: [{ chainSlug, collectionKey }], changedRows: 1, omittedScopes: 0,
});

test("change protocol preserves non-EVM identity and rejects oversized/invalid subscriptions", () => {
  assert.equal(matchesChange(changed("solana-mainnet", "MintAbC"), [{ chainSlug: "solana-mainnet", collectionKey: "Mintabc" }]), false);
  assert.equal(matchesChange(changed("bitcoin-mainnet", "MixedCase"), [{ chainSlug: "bitcoin-mainnet", collectionKey: "mixedcase" }]), false);
  assert.equal(matchesChange(changed("eth-mainnet", "0xAbC"), [{ chainSlug: "eth-mainnet", collectionKey: "0xabc" }]), true);
  assert.equal(parseScopes(Array.from({ length: 65 }, () => ({ chainSlug: "eth-mainnet", collectionKey: "a" }))), null);
  assert.equal(parseChange('{"type":"invalidate"}'), null);
});

test("attention identity includes every subject, token and exact money amount", () => {
  const a = { kind: "facet", chainSlug: "solana-mainnet", subjects: ["a", "b", "c", "d", "e", "f"], tokenIds: ["1"] };
  assert.notEqual(demandIntentKey(a), demandIntentKey({ ...a, subjects: ["a", "b", "c", "d", "e", "g"] }));
  assert.notEqual(demandIntentKey(a), demandIntentKey({ ...a, tokenIds: ["2"] }));
  assert.equal(demandIntentKey(a), demandIntentKey({ ...a, subjects: [...a.subjects].reverse() }));
});

test("real PostgreSQL commit -> shared feed -> WebSocket; rollback, overflow, reconnect and scope fencing", { skip: !hasPostgresConfig(), timeout: 40_000 }, async () => {
  const feed = new MarketChangeFeed();
  const relay = createMarketSocketServer(new Set(["http://localhost:3999"]), feed);
  relay.server.listen(0, "127.0.0.1");
  await once(relay.server, "listening");
  const port = (relay.server.address() as { port: number }).port;
  const received: MarketChange[][] = [[], []];
  const clients = received.map((events) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/market/multichain/socket`, { origin: "http://localhost:3999" });
    ws.on("message", (raw) => events.push(JSON.parse(raw.toString())));
    return ws;
  });
  const transaction = new Client(postgresPool().options);
  const unique = `realtime-${Date.now()}`;
  const key = `${unique}AbC`;
  const insert = `INSERT INTO plank_collection_tokens (chain_slug, collection_slug, token_id, source_observed_at)
    VALUES ('solana-mainnet', $1, $2, NOW())`;
  try {
    await Promise.all(clients.map((ws) => once(ws, "open")));
    clients[0].send(JSON.stringify({ scopes: [{ chainSlug: "solana-mainnet", collectionKey: key }] }));
    clients[1].send(JSON.stringify({ scopes: [{ chainSlug: "solana-mainnet", collectionKey: key.toLowerCase() }] }));
    await until(() => received.every((events) => events.some((e) => e.reason === "listener-ready" || e.reason === "subscribe")));
    await transaction.connect();
    await transaction.query("BEGIN");
    await transaction.query(insert, [key, "rollback"]);
    await transaction.query("ROLLBACK");
    await wait(80);
    assert.equal(received[0].filter((e) => e.type === "invalidate").length, 0);
    // Transaction A starts first; B commits first. Neither completion is lost.
    await transaction.query("BEGIN");
    await transaction.query(insert, [key, "late"]);
    const start = performance.now();
    await postgresQuery(insert, [key, "early"]);
    await until(() => received[0].filter((e) => e.type === "invalidate").length === 1);
    await transaction.query("COMMIT");
    await until(() => received[0].filter((e) => e.type === "invalidate").length === 2);
    assert.equal(received[1].filter((e) => e.type === "invalidate").length, 0, "case-distinct collection cannot receive another mint's changes");
    console.log(JSON.stringify({ probe: "commit-to-websocket", elapsedMs: Math.round(performance.now() - start), subscribers: clients.length }));

    await postgresQuery(`INSERT INTO plank_collection_tokens (chain_slug, collection_slug, token_id, source_observed_at)
      SELECT 'solana-mainnet', $1 || n::text, 'overflow', NOW() FROM generate_series(1, 33) AS n`, [unique]);
    await until(() => received[0].some((e) => e.reason === "statement-scope-overflow"));
    assert.equal(received[0].find((e) => e.reason === "statement-scope-overflow")?.omittedScopes, 33);

    // Rename invalidates both old and new coordinates.
    const oldCount = received[0].filter((e) => e.type === "invalidate").length;
    await postgresQuery("UPDATE plank_collection_tokens SET collection_slug = $2 WHERE collection_slug = $1 AND token_id = 'early'", [key, key.toLowerCase()]);
    await until(() => received[1].some((e) => e.type === "invalidate"));
    assert.equal(received[0].filter((e) => e.type === "invalidate").length, oldCount + 1);

    const before = feed.stats.reconnects;
    await postgresQuery("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = 'plank-market-changes' AND datname = current_database()");
    await until(() => feed.stats.reconnects > before);
    assert.ok(received[0].some((e) => e.reason === "listener-disconnected"));
    const slowServerSocket = [...relay.sockets.clients][0];
    Object.defineProperty(slowServerSocket, "bufferedAmount", { get: () => 300_000 });
    await postgresQuery(insert, [key, "slow-reader"]);
    await until(() => relay.stats.slowReaders === 1);
    clients[1].send(JSON.stringify({ scopes: [] }));
    await once(clients[1], "close");
    assert.equal(relay.stats.invalidSubscriptions, 1);
  } finally {
    await transaction.end();
    for (const ws of clients) ws.terminate();
    await relay.close();
    await postgresQuery("DELETE FROM plank_collection_tokens WHERE collection_slug LIKE $1", [`${unique}%`]);
    await closePostgres();
  }
});
