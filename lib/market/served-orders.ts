import { promises as fs } from "node:fs";
import path from "node:path";
import {
  durableKv as kv,
  durableKvBackend,
  hasDurableKv,
} from "@/lib/market/durable-kv";
import { postgresQuery } from "@/lib/postgres";

/**
 * A durable record of Seaport order hashes WE served — the only honest basis
 * for the Activity feed's "Marketplank" label.
 *
 * Why this exists: the naive approach — "the fulfilling transaction called
 * our Seaport instance, so it must be us" — is wrong. Seaport is a shared,
 * canonical protocol contract; OpenSea, other marketplaces, or a raw script
 * can fulfill an order through the exact same contract address we use, and
 * an order predating this marketplace's launch obviously was never listed
 * here regardless of which contract executed it. The only real signal is
 * whether Seaport's own on-chain `orderHash` for that fill matches an order
 * this relay actually stored — so we record that hash the moment we accept
 * an order, and Activity cross-checks against it, never inferring from the
 * executing contract alone.
 *
 * Backend mirrors lib/market/orders-store.ts: a PostgreSQL primary-key table,
 * Redis/Valkey SET, or Upstash/Vercel KV SET gives indexed membership and
 * idempotent additions. Local dev can still fall back to a file + in-process
 * Set.
 */

const KV_SET_KEY = "plank:market:served-order-hashes";
const DATA_PATH = path.join(process.cwd(), ".data", "served-order-hashes.json");

function hasKv(): boolean {
  return hasDurableKv();
}

function hasPostgres(): boolean {
  return durableKvBackend() === "postgres";
}

type GlobalServed = { __plankServedOrderHashes?: Set<string> };
function g(): GlobalServed {
  return globalThis as GlobalServed;
}

async function loadFileSet(): Promise<Set<string>> {
  if (g().__plankServedOrderHashes) return g().__plankServedOrderHashes!;
  let hashes: string[] = [];
  try {
    const raw = await fs.readFile(DATA_PATH, "utf8");
    hashes = JSON.parse(raw);
  } catch {
    hashes = [];
  }
  const set = new Set(hashes);
  g().__plankServedOrderHashes = set;
  return set;
}

async function persistFileSet(set: Set<string>): Promise<void> {
  try {
    await fs.mkdir(path.dirname(DATA_PATH), { recursive: true });
    await fs.writeFile(DATA_PATH, JSON.stringify([...set]), "utf8");
  } catch {
    // Best-effort — the in-memory copy on globalThis still serves this
    // process; losing the file only matters across restarts in dev.
  }
}

/** Record that we served this order — call once, at successful POST time. */
export async function markOrderServed(orderHash: string): Promise<void> {
  const normalized = orderHash.toLowerCase();
  if (hasPostgres()) {
    await postgresQuery(
      `INSERT INTO served_order_hashes (order_hash)
       VALUES ($1)
       ON CONFLICT DO NOTHING`,
      [normalized]
    );
    return;
  }
  if (hasKv()) {
    await kv.sadd(KV_SET_KEY, normalized);
    return;
  }
  const set = await loadFileSet();
  set.add(normalized);
  await persistFileSet(set);
}

/** True only if THIS relay actually stored an order with this exact hash. */
export async function wasOrderServedByUs(orderHash: string): Promise<boolean> {
  const normalized = orderHash.toLowerCase();
  if (hasPostgres()) {
    const result = await postgresQuery(
      "SELECT 1 FROM served_order_hashes WHERE order_hash = $1",
      [normalized]
    );
    return result.rowCount === 1;
  }
  if (hasKv()) {
    const result = await kv.sismember(KV_SET_KEY, normalized);
    return result === 1;
  }
  const set = await loadFileSet();
  return set.has(normalized);
}
