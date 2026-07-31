import { adminMessage, adminPayloadHash } from "@/lib/admin-auth";
import { signMessage } from "@/lib/wallet";
import type { ContentSlug } from "@/lib/content-docs";

/**
 * Client half of the admin auth contract (lib/admin-auth.ts): sign the exact
 * sanitized JSON the server will verify and store, then send it with the
 * proof. Callers sanitize BEFORE calling so the bytes match.
 */

export type SaveOutcome = { ok: true } | { ok: false; message: string };

async function signedRequest(
  url: string,
  method: string,
  action: string,
  payloadJson: string,
  bodyBuilder: (auth: {
    address: string;
    timestamp: number;
    signature: string;
  }) => BodyInit,
  address: string,
  contentType?: string
): Promise<SaveOutcome> {
  try {
    const timestamp = Date.now();
    const signature = await signMessage(
      address,
      adminMessage(action, timestamp, adminPayloadHash(payloadJson))
    );
    const res = await fetch(url, {
      method,
      ...(contentType ? { headers: { "Content-Type": contentType } } : {}),
      body: bodyBuilder({ address, timestamp, signature }),
    });
    const data = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      message?: string;
    };
    if (!res.ok || !data.ok) {
      return { ok: false, message: data.message || "The server rejected the save." };
    }
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : "Save failed.",
    };
  }
}

/** Sign-and-save a CMS document (must already be sanitized). */
export function saveContentDoc(
  slug: ContentSlug,
  doc: unknown,
  address: string
): Promise<SaveOutcome> {
  const payloadJson = JSON.stringify(doc);
  return signedRequest(
    `/api/content/${slug}`,
    "PUT",
    `content-${slug}`,
    payloadJson,
    (auth) => JSON.stringify({ doc, auth }),
    address,
    "application/json"
  );
}

/** Sign-and-upload a media file. The signed payload is the file's sha256. */
export async function uploadMediaFile(
  file: File,
  address: string
): Promise<
  | { ok: true; upload: { name: string; url: string; bytes: number } }
  | { ok: false; message: string }
> {
  try {
    const bytes = await file.arrayBuffer();
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    const fileHash = `0x${Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")}`;
    const timestamp = Date.now();
    const signature = await signMessage(
      address,
      adminMessage("music-upload", timestamp, adminPayloadHash(fileHash))
    );
    const form = new FormData();
    form.set("file", file);
    form.set("address", address);
    form.set("timestamp", String(timestamp));
    form.set("signature", signature);
    const res = await fetch("/api/music/upload", { method: "POST", body: form });
    const data = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      message?: string;
      upload?: { name: string; url: string; bytes: number };
    };
    if (!res.ok || !data.ok || !data.upload) {
      return { ok: false, message: data.message || "Upload rejected." };
    }
    return { ok: true, upload: data.upload };
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : "Upload failed.",
    };
  }
}
