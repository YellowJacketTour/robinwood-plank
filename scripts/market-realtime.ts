import { createMarketSocketServer } from "../lib/market/multichain/edge/socket-server";
import { closePostgres } from "../lib/postgres";

const port = Number(process.env.MARKET_REALTIME_PORT ?? 3917);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Invalid MARKET_REALTIME_PORT");
const origins = new Set((process.env.MARKET_REALTIME_ORIGINS ?? "https://plank.love,https://www.plank.love").split(",").map((s) => s.trim()));
const relay = createMarketSocketServer(origins);
relay.server.listen(port, "127.0.0.1", () => console.log(`[market-realtime] loopback port ${port}`));
const telemetry = setInterval(() => console.log(JSON.stringify({ service: "market-realtime", connections: relay.sockets.clients.size, ...relay.stats, feed: relay.feed.stats })), 60_000);
telemetry.unref();
let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  clearInterval(telemetry);
  clearTimeout(lifetime);
  // Fenced shutdown even if a broken socket/DB driver never closes.
  setTimeout(() => process.exit(1), 10_000).unref();
  void relay.close().then(closePostgres).then(() => process.exit(0));
};
const lifetime = setTimeout(stop, 55 * 60_000);
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, stop);
