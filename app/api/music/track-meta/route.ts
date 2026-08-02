import { publicError, publicJson, rateLimit } from "@/lib/security";
import { fetchTrackMeta } from "@/lib/track-meta";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Title/artist lookup for a URL an admin has pasted into the Planklist form.
 *
 * Read-only and side-effect free, so it carries no admin signature — but it
 * does make the server fetch on request, so it is rate limited, and
 * fetchTrackMeta only ever contacts a fixed set of provider hosts. A URL that
 * matches none of them returns `meta: null` without a single outbound request.
 *
 * A miss is never an error: the admin just types the fields themselves.
 */
export async function GET(req: Request) {
  const limited = rateLimit(req, {
    key: "music-track-meta",
    limit: 30,
    windowMs: 60_000,
  });
  if (limited) return limited;
  try {
    const src = new URL(req.url).searchParams.get("url") ?? "";
    if (src.length > 600) {
      return publicJson({ meta: null });
    }
    return publicJson({ meta: await fetchTrackMeta(src, req.signal) });
  } catch (err) {
    return publicError(err, "Could not read the track metadata.");
  }
}
