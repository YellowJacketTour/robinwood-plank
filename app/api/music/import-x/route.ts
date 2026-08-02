import { verifyAdminProof, type AdminProof } from "@/lib/admin-auth";
import { logAdminAction } from "@/lib/admin-log";
import { publicError, publicJson, rateLimit, readJsonBody } from "@/lib/security";
import { saveUpload } from "@/lib/uploads";
import { downloadXAudio, fetchXPostAudio, xPostId } from "@/lib/x-media";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
/** Two outbound fetches plus a download — well past the default budget. */
export const maxDuration = 60;

/**
 * Import the audio from an X post so it can be streamed here.
 *
 * X links used to be stored as "external": unplayable rows that bounced the
 * listener to x.com. This rips the post's audio once, at admin time, and
 * stores it as a normal hosted track — the post stays attached as credit.
 *
 * Admin-only, and the signature covers the post URL, so a captured proof can
 * only ever import the exact post it was signed for. The server re-derives
 * everything else (media URL, bytes, hash) from that URL, so there is nothing
 * else for a caller to substitute.
 *
 * The one abuse shape worth naming: this makes the server fetch a URL on
 * request. That is why the caller supplies only a post URL — never a media
 * URL — and why the media URL is resolved from X's own response rather than
 * accepted as input. An admin cannot point this at an internal address.
 */

type Body = { url?: unknown; auth?: Partial<AdminProof> };

const MESSAGES: Record<string, string> = {
  NOT_X_URL: "That is not an X post URL.",
  NOT_FOUND: "X returned nothing for that post — it may be deleted or private.",
  NO_VIDEO: "That post has no video, so there is no audio to import.",
  TOO_LARGE: "That post's media is larger than 25 MB.",
  FETCH_FAILED: "Could not reach X to fetch the audio.",
};

export async function POST(req: Request) {
  try {
    const limited = rateLimit(req, {
      key: "music-import-x",
      limit: 10,
      windowMs: 60_000,
    });
    if (limited) return limited;

    const body = await readJsonBody<Body>(req);
    const url = typeof body.url === "string" ? body.url.trim() : "";
    const auth = body.auth;
    if (
      !auth ||
      typeof auth.address !== "string" ||
      typeof auth.signature !== "string" ||
      typeof auth.timestamp !== "number"
    ) {
      return publicJson(
        {
          error: "BAD_AUTH",
          message: "auth requires address, timestamp, and signature.",
        },
        400
      );
    }
    if (!xPostId(url)) {
      return publicJson({ error: "NOT_X_URL", message: MESSAGES.NOT_X_URL }, 400);
    }

    // Authorize before spending an outbound fetch on a stranger's behalf.
    const verdict = verifyAdminProof("music-import-x", url, auth as AdminProof);
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

    const resolved = await fetchXPostAudio(url, req.signal);
    if ("error" in resolved) {
      return publicJson(
        { error: resolved.error, message: MESSAGES[resolved.error] },
        resolved.error === "NOT_FOUND" ? 404 : 422
      );
    }

    const bytes = await downloadXAudio(resolved.mediaUrl, req.signal);
    if ("error" in bytes) {
      return publicJson(
        { error: bytes.error, message: MESSAGES[bytes.error] },
        bytes.error === "TOO_LARGE" ? 413 : 502
      );
    }

    // Stored as .m4a: the container is MP4 and the audio is AAC, which is what
    // audio/mp4 means. The unused video track rides along rather than pulling
    // in a transcoder the host does not have.
    const saved = await saveUpload(bytes, `x-${resolved.postId}.m4a`);
    if ("error" in saved) {
      return publicJson({ error: "BAD_FILE", message: saved.error }, 400);
    }

    await logAdminAction(
      verdict.address,
      "music-import-x",
      `Imported ${saved.name} (${Math.round(saved.bytes / 1024)} KB) from ${url}`
    );
    return publicJson({
      ok: true,
      upload: saved,
      post: {
        author: resolved.author,
        text: resolved.text,
        durationMs: resolved.durationMs,
      },
    });
  } catch (err) {
    return publicError(err, "Unexpected error importing from X.");
  }
}

export function GET() {
  return publicJson({ error: "METHOD", message: "Use POST." }, 405);
}
