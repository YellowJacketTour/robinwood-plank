import { promises as fs } from "node:fs";
import path from "node:path";
import { durableKv as kv, hasDurableKv } from "@/lib/market/durable-kv";
import {
  contentFallback,
  sanitizeContent,
  type ContentSlug,
} from "@/lib/content-docs";

/**
 * Server-side CMS document store — same contract as
 * lib/woodamp-playlist-store.ts: one database value per doc (PostgreSQL's
 * plank_kv_values table), a .data/ + globalThis fallback for local
 * dev, and the hardcoded fallback from lib/content-docs.ts when nothing valid
 * is stored, so public pages never depend on the store being reachable.
 */

function kvKey(slug: ContentSlug): string {
  return `plank:content:${slug}-v1`;
}

// --- File + memory fallback (dev / no KV configured) -----------------------

type GlobalContent = {
  __plankContentDocs?: Partial<Record<ContentSlug, unknown>>;
};

function g(): GlobalContent {
  return globalThis as GlobalContent;
}

function dataPath(slug: ContentSlug): string {
  return path.join(process.cwd(), ".data", `content-${slug}.json`);
}

let fileWriteChain: Promise<void> = Promise.resolve();
function withFileLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = fileWriteChain.then(fn, fn);
  fileWriteChain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

async function loadFromFile(slug: ContentSlug): Promise<unknown> {
  const cache = (g().__plankContentDocs ??= {});
  if (slug in cache) return cache[slug];
  try {
    cache[slug] = JSON.parse(await fs.readFile(dataPath(slug), "utf8"));
  } catch {
    cache[slug] = null;
  }
  return cache[slug];
}

async function persistToFile(slug: ContentSlug, value: unknown): Promise<void> {
  (g().__plankContentDocs ??= {})[slug] = value;
  try {
    await fs.mkdir(path.dirname(dataPath(slug)), { recursive: true });
    await fs.writeFile(dataPath(slug), JSON.stringify(value), "utf8");
  } catch {
    // Best-effort — the globalThis copy still serves this warm instance.
  }
}

// --- Public store API ------------------------------------------------------

/** Stored doc if valid, else the hardcoded fallback. */
export async function getContent(slug: ContentSlug): Promise<unknown> {
  let stored: unknown = null;
  if (hasDurableKv()) {
    try {
      stored = await kv.get(kvKey(slug));
    } catch {
      stored = null;
    }
  } else {
    stored = await withFileLock(() => loadFromFile(slug));
  }
  if (stored !== null) {
    const parsed = sanitizeContent(slug, stored);
    if (parsed.ok) return parsed.value;
  }
  return contentFallback(slug);
}

/** Replace a doc. Callers must have validated with sanitizeContent. */
export async function setContent(slug: ContentSlug, value: unknown): Promise<void> {
  if (hasDurableKv()) {
    await kv.set(kvKey(slug), value);
    return;
  }
  await withFileLock(() => persistToFile(slug, value));
}
