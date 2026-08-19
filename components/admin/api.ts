import { adminMessage, adminPayloadHash } from "@/lib/admin-auth";
import { signMessage } from "@/lib/wallet";
import type { ContentSlug } from "@/lib/content-docs";
import type { VaultDeployInput } from "@/lib/market/vault-deploy-v3";

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

/**
 * Manual marketplace-points grant -- the one legitimate manual write path
 * into the Plank Checks ledger (see lib/plank-checks.ts's "admin_grant"
 * category doc comment). The signed payload names the exact wallet,
 * points, and reason, so a captured signature can't be replayed to grant
 * a different amount or to a different wallet.
 */
export function grantPoints(
  wallet: string,
  points: number,
  reason: string,
  address: string
): Promise<SaveOutcome> {
  const payloadJson = JSON.stringify({ wallet: wallet.toLowerCase(), points, reason });
  return signedRequest(
    "/api/admin/points",
    "POST",
    "points-grant",
    payloadJson,
    (auth) => JSON.stringify({ wallet, points, reason, auth }),
    address,
    "application/json"
  );
}

export type XImportOutcome =
  | {
      ok: true;
      upload: { name: string; url: string; bytes: number };
      post: { author: string; text: string; durationMs: number | null };
    }
  | { ok: false; message: string };

/**
 * Rip an X post's audio and host it here. The signed payload is the post URL,
 * so the proof authorizes exactly one post — the server resolves the media
 * URL itself and never accepts one from the client.
 */
export async function importXTrack(
  postUrl: string,
  address: string
): Promise<XImportOutcome> {
  try {
    const timestamp = Date.now();
    const signature = await signMessage(
      address,
      adminMessage("music-import-x", timestamp, adminPayloadHash(postUrl))
    );
    const res = await fetch("/api/music/import-x", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: postUrl,
        auth: { address, timestamp, signature },
      }),
    });
    const data = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      message?: string;
      upload?: { name: string; url: string; bytes: number };
      post?: { author: string; text: string; durationMs: number | null };
    };
    if (!res.ok || !data.ok || !data.upload) {
      return { ok: false, message: data.message || "Import rejected." };
    }
    return {
      ok: true,
      upload: data.upload,
      post: data.post ?? { author: "", text: "", durationMs: null },
    };
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : "Import failed.",
    };
  }
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

/** Whether the server has GITHUB_DISPATCH_TOKEN configured — read before
 * rendering the vault-deploy form so it can disable itself with a clear
 * reason instead of failing silently on submit. */
export async function vaultDeployConfigured(): Promise<boolean> {
  try {
    const res = await fetch("/api/admin/vault-deploy", { cache: "no-store" });
    if (!res.ok) return false;
    const data = (await res.json()) as { configured?: boolean };
    return data.configured === true;
  } catch {
    return false;
  }
}

export type VaultDeployOutcome =
  | { ok: true; runUrl: string | null; actionsUrl: string }
  | { ok: false; message: string };

/**
 * Sign and dispatch .github/workflows/deploy-vault-v3.yml. The signed payload
 * is the exact validated input object (see lib/market/vault-deploy-v3.ts) —
 * every field the workflow reads, so a captured signature authorizes exactly
 * this dispatch and nothing else.
 */
export async function dispatchVaultDeploy(
  input: VaultDeployInput,
  address: string
): Promise<VaultDeployOutcome> {
  try {
    const payloadJson = JSON.stringify(input);
    const timestamp = Date.now();
    const signature = await signMessage(
      address,
      adminMessage("vault-deploy-dispatch", timestamp, adminPayloadHash(payloadJson))
    );
    const res = await fetch("/api/admin/vault-deploy", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        input,
        auth: { address, timestamp, signature },
      }),
    });
    const data = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      message?: string;
      runUrl?: string | null;
      actionsUrl?: string;
    };
    if (!res.ok || !data.ok) {
      return { ok: false, message: data.message || "Dispatch rejected." };
    }
    return {
      ok: true,
      runUrl: data.runUrl ?? null,
      actionsUrl: data.actionsUrl ?? "",
    };
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : "Dispatch failed.",
    };
  }
}
