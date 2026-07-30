/**
 * Read JSON from public/ in a way that works on Node (local/Vercel)
 * and Cloudflare Workers (no durable FS under process.cwd()).
 *
 * Order: bundled static import map → filesystem → ASSETS binding → absolute fetch.
 */

import { promises as fs } from "node:fs";
import path from "node:path";

// Small config files — safe to bundle. proofs.json is ~2MB; load via assets/FS.
import airdropConfig from "@/public/airdrop.json";

const BUNDLED: Record<string, unknown> = {
  "public/airdrop.json": airdropConfig,
  "airdrop.json": airdropConfig,
};

function publicUrlPath(rel: string): string {
  return "/" + rel.replace(/^public[/\\]/, "").replace(/\\/g, "/");
}

async function readFromFs(rel: string): Promise<string | null> {
  try {
    const full = path.join(/* turbopackIgnore: true */ process.cwd(), rel);
    return await fs.readFile(full, "utf8");
  } catch {
    return null;
  }
}

async function readFromAssets(urlPath: string): Promise<string | null> {
  try {
    // Dynamic import so local next build without wrangler still works
    const { getCloudflareContext } = await import("@opennextjs/cloudflare");
    const { env } = getCloudflareContext();
    const assets = (env as { ASSETS?: { fetch: typeof fetch } }).ASSETS;
    if (!assets) return null;
    const res = await assets.fetch(new Request(`https://assets${urlPath}`));
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

async function readFromOrigin(urlPath: string): Promise<string | null> {
  try {
    // Last resort: same-origin public URL (works once the asset is deployed)
    const base =
      process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/$/, "") ||
      process.env.CF_PAGES_URL?.replace(/\/$/, "") ||
      "https://plank.love";
    const res = await fetch(`${base}${urlPath}`, { cache: "no-store" });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

export async function readPublicJson<T>(rel: string): Promise<T | null> {
  const key = rel.replace(/\\/g, "/");
  if (key in BUNDLED) {
    return BUNDLED[key] as T;
  }

  const fromFs = await readFromFs(key.startsWith("public/") ? key : `public/${key}`);
  if (fromFs) {
    try {
      return JSON.parse(fromFs) as T;
    } catch {
      /* continue */
    }
  }

  const urlPath = publicUrlPath(key.startsWith("public/") ? key : `public/${key}`);
  const fromAssets = await readFromAssets(urlPath);
  if (fromAssets) {
    try {
      return JSON.parse(fromAssets) as T;
    } catch {
      /* continue */
    }
  }

  const fromOrigin = await readFromOrigin(urlPath);
  if (fromOrigin) {
    try {
      return JSON.parse(fromOrigin) as T;
    } catch {
      return null;
    }
  }

  return null;
}

export async function readPublicText(rel: string): Promise<string | null> {
  const key = rel.replace(/\\/g, "/");
  const pathRel = key.startsWith("public/") ? key : `public/${key}`;
  const fromFs = await readFromFs(pathRel);
  if (fromFs) return fromFs;

  const urlPath = publicUrlPath(pathRel);
  const fromAssets = await readFromAssets(urlPath);
  if (fromAssets) return fromAssets;

  return readFromOrigin(urlPath);
}

/** True when running on Cloudflare Workers / Pages. */
export function isCloudflareRuntime(): boolean {
  return Boolean(
    process.env.CF_PAGES ||
      process.env.CF_WORKER ||
      typeof (globalThis as { caches?: unknown }).caches !== "undefined" &&
        process.env.NEXTJS_ENV !== "development"
  );
}
