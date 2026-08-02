import { publicJson, rateLimit } from "@/lib/security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Meme submission proxy — POST /api/v1/submissions upstream.
 *
 * The browser never talks to the vault directly. The key is submit-capable,
 * so putting it client-side would let anyone lift it and post as us; and the
 * upstream budget is 20 submissions/hour for the WHOLE SITE, which is small
 * enough that one bored visitor could exhaust it in a minute. Both problems
 * are only solvable server-side.
 *
 * Everything here lands in a moderation queue upstream and is not public
 * until a human approves it — so this is a queue, not a publish button. That
 * is what makes an open form defensible at all.
 */

const UPSTREAM = "https://memes.smoothbrain.app/api/v1/submissions";
const PROJECT = "plank";

/** Their documented accept list. Validated by us too so a rejection costs a
 *  clear message here rather than an opaque one from a third party. */
const ACCEPTED = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "video/mp4",
  "video/webm",
]);
const MAX_BYTES = 25 * 1024 * 1024;

export async function POST(req: Request) {
  // Deliberately tighter than the upstream hourly budget. 20/hour is the
  // ceiling for every visitor combined, so one person must not be able to
  // spend it: 3 per 10 minutes per IP leaves room for everyone else and is
  // still generous for someone genuinely posting their own work.
  const limited = rateLimit(req, { key: "memes-submit", limit: 3, windowMs: 10 * 60_000 });
  if (limited) return limited;

  const key = process.env.MEMES_VAULT_API?.trim();
  if (!key) {
    return publicJson(
      {
        error: "NOT_CONFIGURED",
        message: "Submissions are not enabled right now.",
      },
      503
    );
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return publicJson({ error: "BAD_REQUEST", message: "Could not read the upload." }, 400);
  }

  const media = form.get("media");
  const title = String(form.get("title") ?? "").trim();
  const creatorName = String(form.get("creatorName") ?? "").trim();
  const description = String(form.get("description") ?? "").trim();
  const tags = String(form.get("tags") ?? "").trim();
  const sourceUrl = String(form.get("sourceUrl") ?? "").trim();

  if (!(media instanceof File) || media.size === 0) {
    return publicJson({ error: "NO_FILE", message: "Pick an image or video first." }, 400);
  }
  if (!title) {
    return publicJson({ error: "NO_TITLE", message: "Give it a title." }, 400);
  }
  if (media.size > MAX_BYTES) {
    return publicJson(
      { error: "TOO_LARGE", message: "That file is over the 25 MB limit." },
      400
    );
  }
  if (!ACCEPTED.has(media.type)) {
    return publicJson(
      {
        error: "BAD_TYPE",
        message: "Use a JPEG, PNG, WebP, GIF, MP4 or WebM.",
      },
      400
    );
  }
  // They validate by actual bytes, not extension, so a mismatch here is only
  // an early filter — never a guarantee. The upstream answer is authoritative.

  const upstreamForm = new FormData();
  upstreamForm.set("media", media, media.name || "upload");
  upstreamForm.set("title", title.slice(0, 120));
  // Pinned, never taken from the client: this endpoint exists to submit to
  // OUR project, and accepting a slug would turn it into an open relay for
  // posting into someone else's collection on our key.
  upstreamForm.set("project", PROJECT);
  if (creatorName) upstreamForm.set("creatorName", creatorName.slice(0, 60));
  if (description) upstreamForm.set("description", description.slice(0, 500));
  if (tags) upstreamForm.set("tags", tags.slice(0, 200));
  if (/^https?:\/\//i.test(sourceUrl)) upstreamForm.set("sourceUrl", sourceUrl.slice(0, 300));

  try {
    const res = await fetch(UPSTREAM, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}` },
      body: upstreamForm,
    });
    const data = (await res.json().catch(() => null)) as {
      status?: string;
      message?: string;
      duplicateOf?: unknown[];
      error?: { code?: string; message?: string };
    } | null;

    if (res.status === 429) {
      return publicJson(
        {
          error: "RATE_LIMITED",
          message: "The vault is taking a lot of submissions right now — try again later.",
        },
        429
      );
    }
    if (!res.ok) {
      return publicJson(
        {
          error: data?.error?.code ?? "UPSTREAM",
          message: data?.error?.message ?? "The meme vault rejected that.",
        },
        res.status === 400 ? 400 : 502
      );
    }

    // duplicateOf is informational, not a rejection — surfaced so the user
    // hears it now rather than waiting on review for a copy of something
    // already in the queue.
    return publicJson({
      status: data?.status ?? "pending",
      message:
        data?.message ??
        "Submitted. A moderator has to approve it before it shows up here.",
      duplicate: Array.isArray(data?.duplicateOf) && data.duplicateOf.length > 0,
    });
  } catch {
    return publicJson(
      { error: "UNREACHABLE", message: "Could not reach the meme vault. Try again." },
      502
    );
  }
}
