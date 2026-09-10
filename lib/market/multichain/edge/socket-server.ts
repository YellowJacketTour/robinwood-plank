import { createServer } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { MarketChangeFeed } from "./change-feed";
import { parseScopes } from "./change-protocol";

/** Loopback sidecar. Next's external rewrite handles the public upgrade.
 * Never accepts transactions, provider keys, or ingestion work. */
export function createMarketSocketServer(origins: Set<string>, feed = new MarketChangeFeed()) {
  const stats = { accepted: 0, rejected: 0, slowReaders: 0, invalidSubscriptions: 0, timedOut: 0 };
  const server = createServer((_req, res) => { res.writeHead(426); res.end("WebSocket required"); });
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 16_384, perMessageDeflate: false });
  server.on("upgrade", (req, socket, head) => {
    if (req.url?.split("?")[0] !== "/api/market/multichain/socket" ||
        !origins.has(req.headers.origin ?? "") || sockets.clients.size >= 2_000) {
      stats.rejected++; socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"); return;
    }
    sockets.handleUpgrade(req, socket, head, (ws) => sockets.emit("connection", ws));
  });
  sockets.on("connection", (ws) => {
    stats.accepted++;
    let detach = () => {};
    let subscribed = false;
    let alive = true;
    ws.on("error", () => ws.terminate());
    ws.on("pong", () => { alive = true; });
    const timer = setInterval(() => {
      if (!alive || !subscribed) { stats.timedOut++; ws.terminate(); return; }
      alive = false;
      ws.ping();
    }, 20_000);
    timer.unref();
    ws.on("message", (raw) => {
      let scopes;
      try { scopes = parseScopes(JSON.parse(raw.toString()).scopes); } catch { scopes = null; }
      // A connection subscribes once; scope changes open a new connection.
      if (!scopes || subscribed) { stats.invalidSubscriptions++; ws.close(1008, "Invalid subscription"); return; }
      subscribed = true;
      detach = feed.subscribe(scopes, (change) => {
        if (ws.readyState !== WebSocket.OPEN) return;
        if (ws.bufferedAmount > 262_144) { stats.slowReaders++; ws.terminate(); return; }
        ws.send(JSON.stringify(change));
      });
    });
    ws.on("close", () => { clearInterval(timer); detach(); });
  });
  return { server, sockets, stats, feed, async close() {
    for (const ws of sockets.clients) ws.terminate();
    feed.stop();
    await new Promise<void>((resolve) => sockets.close(() => resolve()));
    await new Promise<void>((resolve) => server.close(() => resolve()));
  } };
}
