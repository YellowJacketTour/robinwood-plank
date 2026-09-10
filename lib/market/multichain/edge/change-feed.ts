import { Client } from "pg";
import { postgresPool } from "@/lib/postgres";
import { matchesChange, parseChange, type MarketChange, type MarketScope } from "./change-protocol";

/** One dedicated LISTEN connection, independent of the web query pool.
 * Notifications are invalidations, never a durable event cursor. Every new
 * connection requests a snapshot, including recovery from a dropped listener. */
export class MarketChangeFeed {
  private subscribers = new Set<{ scopes: MarketScope[]; send: (change: MarketChange) => void }>();
  private client: Client | null = null;
  private retry: NodeJS.Timeout | null = null;
  private schemaTimer: NodeJS.Timeout | null = null;
  constructor(private schemaCheckMs = 15_000) {}
  private generation = 0;
  private ready = false;
  readonly stats = { deliveryMode: "checking" as "checking" | "notifications" | "periodic-resync", notifications: 0, delivered: 0, failures: 0, malformed: 0, reconnects: 0, omittedScopes: 0, subscriberFailures: 0 };

  subscribe(scopes: MarketScope[], send: (change: MarketChange) => void) {
    const sub = { scopes, send };
    this.subscribers.add(sub);
    if (this.ready) this.deliver(sub, this.resync("subscribe"));
    if (!this.client && !this.retry) void this.connect();
    return () => {
      this.subscribers.delete(sub);
      if (!this.subscribers.size) this.stop();
    };
  }

  private resync(reason: string): MarketChange {
    return { type: "resync", family: "all", scopes: [], changedRows: 0, omittedScopes: 0, reason };
  }
  private deliver(sub: { send: (change: MarketChange) => void }, change: MarketChange) {
    try { sub.send(change); this.stats.delivered++; }
    catch { this.stats.subscriberFailures++; }
  }
  private broadcast(change: MarketChange) {
    for (const sub of this.subscribers) if (matchesChange(change, sub.scopes)) this.deliver(sub, change);
  }
  protected async notificationSchemaReady(client: Client) {
    const result = await client.query("SELECT EXISTS (SELECT 1 FROM plank_schema_migrations WHERE version='110_market_change_notifications.sql') AS ready");
    return result.rows[0]?.ready === true;
  }
  private async checkSchema(client: Client, generation: number) {
    if (generation !== this.generation) return;
    try {
      const ready = await this.notificationSchemaReady(client);
      if (generation !== this.generation) return;
      const before = this.stats.deliveryMode;
      this.stats.deliveryMode = ready ? "notifications" : "periodic-resync";
      if (!ready) this.broadcast(this.resync("notifications-pending-periodic-resync"));
      else if (before === "periodic-resync") this.broadcast(this.resync("notifications-activated"));
    } catch {
      if (generation !== this.generation) return;
      this.stats.deliveryMode = "periodic-resync";
      this.broadcast(this.resync("notification-readiness-unavailable"));
    }
    if (generation === this.generation) {
      this.schemaTimer = setTimeout(() => { void this.checkSchema(client, generation); }, this.schemaCheckMs);
      this.schemaTimer.unref();
    }
  }
  private async connect() {
    const generation = ++this.generation;
    let client: Client;
    try {
      client = new Client({ ...postgresPool().options, application_name: "plank-market-changes", keepAlive: true, keepAliveInitialDelayMillis: 10_000 });
      this.client = client;
      const failed = () => {
        if (generation !== this.generation) return;
        this.generation++;
        if (this.schemaTimer) clearTimeout(this.schemaTimer);
        this.schemaTimer = null;
        this.ready = false;
        this.client = null;
        this.stats.failures++;
        void client.end().catch(() => {});
        this.broadcast(this.resync("listener-disconnected"));
        this.schedule();
      };
      client.on("error", failed);
      client.on("end", failed);
      client.on("notification", (message) => {
        if (generation !== this.generation || message.channel !== "plank_market_changes") return;
        const change = parseChange(message.payload ?? "");
        if (!change) { this.stats.malformed++; this.broadcast(this.resync("invalid-notification")); return; }
        this.stats.notifications++;
        this.stats.omittedScopes += change.omittedScopes;
        this.broadcast(change);
      });
      await client.connect();
      if (generation !== this.generation) return;
      await client.query("LISTEN plank_market_changes");
      if (generation !== this.generation) return;
      this.ready = true;
      this.stats.reconnects++;
      this.broadcast(this.resync("listener-ready"));
      void this.checkSchema(client, generation);
    } catch {
      if (generation !== this.generation) return;
      this.stats.failures++;
      this.stopConnection();
      this.schedule();
    }
  }
  private schedule() {
    if (!this.subscribers.size || this.retry) return;
    this.retry = setTimeout(() => { this.retry = null; void this.connect(); }, 2_000 + Math.random() * 1_000);
    this.retry.unref();
  }
  private stopConnection() {
    if (this.schemaTimer) clearTimeout(this.schemaTimer);
    this.schemaTimer = null;
    this.generation++;
    this.ready = false;
    const client = this.client;
    this.client = null;
    if (client) void client.end().catch(() => {});
  }
  stop() {
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
    this.stopConnection();
  }
}

const shared = globalThis as typeof globalThis & { __plankChangeFeed?: MarketChangeFeed };
export function marketChangeFeed(): MarketChangeFeed {
  return shared.__plankChangeFeed ??= new MarketChangeFeed();
}
