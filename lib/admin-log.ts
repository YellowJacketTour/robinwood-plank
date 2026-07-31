import { promises as fs } from "node:fs";
import path from "node:path";
import { durableKv as kv, hasDurableKv } from "@/lib/market/durable-kv";

/**
 * Admin action log — every verified admin mutation appends one entry (who,
 * what, when), shown in /admin's System section. Once there is more than one
 * admin wallet this is the audit trail of record.
 *
 * Stored as one bounded database value (newest first). A single-key read-modify-
 * write is acceptable here: writes only happen on signed admin saves, which
 * are rare and effectively serialized through one person's wallet; worst case
 * a concurrent save loses a log line, never application data.
 */

export type AdminLogEntry = {
  /** ISO timestamp (server clock). */
  at: string;
  /** Lowercased signer address. */
  address: string;
  /** The signed action, e.g. "woodamp-playlist", "content-banner". */
  action: string;
  /** One human line, e.g. "Saved 4 tracks". */
  summary: string;
};

const KV_KEY = "plank:admin:action-log-v1";
export const MAX_LOG_ENTRIES = 200;

type GlobalLog = { __plankAdminLog?: AdminLogEntry[] | null };

function g(): GlobalLog {
  return globalThis as GlobalLog;
}

const DATA_PATH = path.join(process.cwd(), ".data", "admin-log.json");

let chain: Promise<void> = Promise.resolve();
function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn);
  chain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

function sanitizeEntries(value: unknown): AdminLogEntry[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(
      (e): e is AdminLogEntry =>
        typeof e === "object" &&
        e !== null &&
        typeof (e as AdminLogEntry).at === "string" &&
        typeof (e as AdminLogEntry).address === "string" &&
        typeof (e as AdminLogEntry).action === "string" &&
        typeof (e as AdminLogEntry).summary === "string"
    )
    .slice(0, MAX_LOG_ENTRIES);
}

async function readAll(): Promise<AdminLogEntry[]> {
  if (hasDurableKv()) {
    try {
      return sanitizeEntries(await kv.get<AdminLogEntry[]>(KV_KEY));
    } catch {
      return [];
    }
  }
  if (g().__plankAdminLog !== undefined) return g().__plankAdminLog ?? [];
  try {
    g().__plankAdminLog = sanitizeEntries(
      JSON.parse(await fs.readFile(DATA_PATH, "utf8"))
    );
  } catch {
    g().__plankAdminLog = [];
  }
  return g().__plankAdminLog ?? [];
}

async function writeAll(entries: AdminLogEntry[]): Promise<void> {
  if (hasDurableKv()) {
    await kv.set(KV_KEY, entries);
    return;
  }
  g().__plankAdminLog = entries;
  try {
    await fs.mkdir(path.dirname(DATA_PATH), { recursive: true });
    await fs.writeFile(DATA_PATH, JSON.stringify(entries), "utf8");
  } catch {
    // Best-effort.
  }
}

/** Append an entry (never throws — logging must not fail a save). */
export async function logAdminAction(
  address: string,
  action: string,
  summary: string
): Promise<void> {
  try {
    await withLock(async () => {
      const entries = await readAll();
      entries.unshift({
        at: new Date().toISOString(),
        address: address.toLowerCase(),
        action,
        summary: summary.slice(0, 300),
      });
      await writeAll(entries.slice(0, MAX_LOG_ENTRIES));
    });
  } catch {
    // Swallowed on purpose.
  }
}

/** Newest-first entries. */
export async function getAdminLog(limit = 50): Promise<AdminLogEntry[]> {
  const entries = await withLock(readAll);
  return entries.slice(0, Math.max(1, Math.min(limit, MAX_LOG_ENTRIES)));
}
