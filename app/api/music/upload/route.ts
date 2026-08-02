import { createHash } from "node:crypto";
import { verifyAdminProof } from "@/lib/admin-auth";
import { logAdminAction } from "@/lib/admin-log";
import { publicError, publicJson, rateLimit } from "@/lib/security";
import { listUploads, MAX_UPLOAD_BYTES, saveUpload } from "@/lib/uploads";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Admin media upload. Multipart form (the one route in the app that reads
 * FormData — the shared readJsonBody 64 KB cap doesn't apply, so the size cap
 * is enforced here explicitly):
 *   file      — the audio/image file
 *   address   — signer
 *   timestamp — ms epoch
 *   signature — personal_sign over adminMessage("music-upload", timestamp,
 *               adminPayloadHash("0x" + sha256(file bytes))) — i.e. the
 *               standard admin proof where the "payload JSON" is the file's
 *               sha256 hex string
 *
 * Binding the signature to the file's own hash means a captured proof cannot
 * upload different content. The server recomputes the hash from the bytes it
 * actually received before verifying.
 *
 * GET lists stored uploads (names + sizes only — public anyway once
 * referenced by the playlist).
 */

export async function GET(req: Request) {
  const limited = rateLimit(req, {
    key: "music-upload-list",
    limit: 60,
    windowMs: 60_000,
  });
  if (limited) return limited;
  try {
    return publicJson({ uploads: await listUploads() });
  } catch (err) {
    return publicError(err, "Could not list uploads.");
  }
}

export async function POST(req: Request) {
  try {
    const limited = rateLimit(req, {
      key: "music-upload-post",
      limit: 20,
      windowMs: 60_000,
    });
    if (limited) return limited;

    // Cheap pre-check on the declared size before buffering anything.
    const declared = Number(req.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > MAX_UPLOAD_BYTES + 64 * 1024) {
      return publicJson(
        { error: "TOO_LARGE", message: "File is too large (max 25 MB)." },
        413
      );
    }

    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      return publicJson(
        { error: "BAD_FORM", message: "Send multipart/form-data." },
        400
      );
    }

    const file = form.get("file");
    const address = form.get("address");
    const timestampRaw = form.get("timestamp");
    const signature = form.get("signature");
    if (
      !(file instanceof File) ||
      typeof address !== "string" ||
      typeof timestampRaw !== "string" ||
      typeof signature !== "string"
    ) {
      return publicJson(
        {
          error: "BAD_FORM",
          message: "file, address, timestamp, and signature are required.",
        },
        400
      );
    }
    const timestamp = Number(timestampRaw);

    const bytes = Buffer.from(await file.arrayBuffer());
    if (bytes.byteLength > MAX_UPLOAD_BYTES) {
      return publicJson(
        { error: "TOO_LARGE", message: "File is too large (max 25 MB)." },
        413
      );
    }

    // The "payload" the admin signed is the file's own sha256 — recomputed
    // here from the received bytes, so content and signature can't diverge.
    const fileHash = `0x${createHash("sha256").update(bytes).digest("hex")}`;
    const verdict = verifyAdminProof("music-upload", fileHash, {
      address,
      timestamp,
      signature,
    });
    if (!verdict.ok) {
      const status = verdict.error === "UNAUTHORIZED" ? 403 : 401;
      return publicJson(
        {
          error: verdict.error,
          message:
            verdict.error === "STALE"
              ? "Signature expired — sign again."
              : verdict.error === "UNAUTHORIZED"
                ? "This wallet is not an admin."
                : "Signature verification failed.",
        },
        status
      );
    }

    const saved = await saveUpload(bytes, file.name);
    if ("error" in saved) {
      return publicJson({ error: "BAD_FILE", message: saved.error }, 400);
    }
    await logAdminAction(
      verdict.address,
      "music-upload",
      `Uploaded ${saved.name} (${Math.round(saved.bytes / 1024)} KB)`
    );
    return publicJson({ ok: true, upload: saved });
  } catch (err) {
    return publicError(err, "Unexpected error storing the upload.");
  }
}
