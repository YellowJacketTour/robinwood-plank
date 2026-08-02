import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * Admin media uploads — audio for WoodAmp, images for CMS assets.
 *
 * Files land in UPLOADS_DIR (production: a directory under the deployment's
 * persistent `shared/` folder, e.g. /home/USER/site/shared/uploads — survives
 * immutable releases with no deploy needed) and are served back through
 * /api/media/[name]. Local dev falls back to .data/uploads. Never public/ —
 * that directory is baked per-release and an upload there would vanish on the
 * next activation.
 *
 * Names are content-addressed (`<sha256-12>-<safe-original>.<ext>`): no
 * collisions, no overwrites, and the stored name is safe to echo into URLs.
 */

export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024; // audio-sized; images far under

export const UPLOAD_TYPES: Record<string, string> = {
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  ogg: "audio/ogg",
  wav: "audio/wav",
  webp: "image/webp",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
};

export function uploadsDir(): string {
  const configured = process.env.UPLOADS_DIR?.trim();
  return configured || path.join(process.cwd(), ".data", "uploads");
}

const STORED_NAME = /^[a-f0-9]{12}-[a-z0-9][a-z0-9-]{0,80}\.[a-z0-9]{2,5}$/;

/** Resolve a stored name to its absolute path, or null (bad/traversal name). */
export function resolveUploadPath(name: string): string | null {
  if (!STORED_NAME.test(name)) return null;
  const ext = name.slice(name.lastIndexOf(".") + 1);
  if (!(ext in UPLOAD_TYPES)) return null;
  return path.join(uploadsDir(), name);
}

export function uploadContentType(name: string): string {
  const ext = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
  return UPLOAD_TYPES[ext] ?? "application/octet-stream";
}

export type SavedUpload = {
  name: string;
  url: string;
  bytes: number;
  sha256: string;
};

/**
 * Persist an uploaded file. `originalName` supplies the extension and a
 * human-readable stem; content decides the hash prefix.
 */
export async function saveUpload(
  bytes: Buffer,
  originalName: string
): Promise<SavedUpload | { error: string }> {
  if (bytes.byteLength === 0) return { error: "Empty file." };
  if (bytes.byteLength > MAX_UPLOAD_BYTES) {
    return {
      error: `File is too large (max ${Math.floor(MAX_UPLOAD_BYTES / (1024 * 1024))} MB).`,
    };
  }
  const dot = originalName.lastIndexOf(".");
  const ext = dot >= 0 ? originalName.slice(dot + 1).toLowerCase() : "";
  if (!(ext in UPLOAD_TYPES)) {
    return {
      error: `Unsupported file type .${ext} — allowed: ${Object.keys(UPLOAD_TYPES).join(", ")}.`,
    };
  }
  const stem =
    originalName
      .slice(0, dot >= 0 ? dot : undefined)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "file";
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const name = `${sha256.slice(0, 12)}-${stem}.${ext}`;
  const dir = uploadsDir();
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, name), bytes);
  return { name, url: `/api/media/${name}`, bytes: bytes.byteLength, sha256 };
}

export type UploadListing = { name: string; url: string; bytes: number };

export async function listUploads(): Promise<UploadListing[]> {
  try {
    const dir = uploadsDir();
    const names = await fs.readdir(dir);
    const out: UploadListing[] = [];
    for (const name of names) {
      if (!STORED_NAME.test(name)) continue;
      try {
        const stat = await fs.stat(path.join(dir, name));
        out.push({ name, url: `/api/media/${name}`, bytes: stat.size });
      } catch {
        // Skip unreadable entries.
      }
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}
