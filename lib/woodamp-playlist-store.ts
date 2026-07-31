import { promises as fs } from "node:fs";
import path from "node:path";
import { durableKv as kv, hasDurableKv } from "@/lib/market/durable-kv";
import {
  sanitizePlaylist,
  WOODAMP_PLAYLIST,
  type WoodAmpTrack,
} from "@/lib/woodamp-playlist";

/**
 * WoodAmp playlist store — server side of Phase 2 (lib/woodamp-playlist.ts).
 *
 * The admin-managed track list lives under one database key (PostgreSQL's
 * plank_kv_values table); the static Phase 1 manifest remains the
 * seed and the fallback, so a fresh deployment (or a database outage) still
 * plays exactly what Phase 1 played. The stored shape is the same
 * `WoodAmpTrack[]` the player components consume.
 *
 * Without a database configured (local dev), the list persists to .data/ plus a
 * globalThis cache, serialized through an in-process write mutex — the same
 * fallback contract as lib/market/orders-store.ts. The whole list is one
 * value (not per-track hash fields) because every mutation is a full-list
 * replace from a single admin, so there is no concurrent partial-write case
 * to protect against.
 */

const KV_KEY = "plank:woodamp:playlist-v1";

export { sanitizePlaylist };

// --- File + memory fallback (dev / no KV configured) -----------------------

type GlobalPlaylist = { __plankWoodampPlaylist?: WoodAmpTrack[] | null };

function g(): GlobalPlaylist {
  return globalThis as GlobalPlaylist;
}

const DATA_PATH = path.join(process.cwd(), ".data", "woodamp-playlist.json");

let fileWriteChain: Promise<void> = Promise.resolve();
function withFileLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = fileWriteChain.then(fn, fn);
  fileWriteChain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

async function loadFromFile(): Promise<WoodAmpTrack[] | null> {
  if (g().__plankWoodampPlaylist !== undefined) {
    return g().__plankWoodampPlaylist ?? null;
  }
  try {
    const raw = await fs.readFile(DATA_PATH, "utf8");
    const parsed = sanitizePlaylist(JSON.parse(raw));
    g().__plankWoodampPlaylist = parsed.ok ? parsed.tracks : null;
  } catch {
    g().__plankWoodampPlaylist = null;
  }
  return g().__plankWoodampPlaylist ?? null;
}

async function persistToFile(tracks: WoodAmpTrack[]): Promise<void> {
  g().__plankWoodampPlaylist = tracks;
  try {
    await fs.mkdir(path.dirname(DATA_PATH), { recursive: true });
    await fs.writeFile(DATA_PATH, JSON.stringify(tracks), "utf8");
  } catch {
    // Best-effort — the globalThis copy still serves this warm instance.
  }
}

// --- Public store API ------------------------------------------------------

/**
 * The playlist to serve. Falls back to the Phase 1 static manifest when
 * nothing has been stored yet or the stored value fails validation — the
 * player must never break because of an empty/corrupt store.
 */
export async function getPlaylist(): Promise<WoodAmpTrack[]> {
  let stored: unknown = null;
  if (hasDurableKv()) {
    try {
      stored = await kv.get<WoodAmpTrack[]>(KV_KEY);
    } catch {
      stored = null;
    }
  } else {
    stored = await withFileLock(loadFromFile);
  }
  if (stored !== null) {
    const parsed = sanitizePlaylist(stored);
    if (parsed.ok) return parsed.tracks;
  }
  return [...WOODAMP_PLAYLIST];
}

/** Replace the stored playlist. Callers must have validated with sanitizePlaylist. */
export async function setPlaylist(tracks: WoodAmpTrack[]): Promise<void> {
  if (hasDurableKv()) {
    await kv.set(KV_KEY, tracks);
    return;
  }
  await withFileLock(() => persistToFile(tracks));
}
