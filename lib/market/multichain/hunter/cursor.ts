import { durableKv } from "@/lib/market/durable-kv";
import type { HunterCursor, HunterFamily } from "./types";
import type { ChunkState } from "./chunk";

/** Cursor and chunk memory live in plank_kv_values -- no migration needed. */
const cursorKey = (family: HunterFamily, chainSlug: string, scope: string) => `plank:hunter:cursor:${family}:${chainSlug}:${scope}`;
const chunkKey = (family: HunterFamily, chainSlug: string, scope: string) => `plank:hunter:chunk:${family}:${chainSlug}:${scope}`;

export async function readHunterCursor(family: HunterFamily, chainSlug: string, scope = "default"): Promise<HunterCursor | null> {
  return (await durableKv.get<HunterCursor>(cursorKey(family, chainSlug, scope))) ?? null;
}

export async function writeHunterCursor(family: HunterFamily, chainSlug: string, cursor: HunterCursor, scope = "default"): Promise<void> {
  await durableKv.set(cursorKey(family, chainSlug, scope), cursor);
}

export async function readChunkMemory(family: HunterFamily, chainSlug: string, scope = "default"): Promise<ChunkState | null> {
  return (await durableKv.get<ChunkState>(chunkKey(family, chainSlug, scope))) ?? null;
}

export async function writeChunkMemory(family: HunterFamily, chainSlug: string, state: ChunkState, scope = "default"): Promise<void> {
  await durableKv.set(chunkKey(family, chainSlug, scope), state);
}
