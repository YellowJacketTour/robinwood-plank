import { NextResponse } from "next/server";
import { verifyAdminProof, type AdminProof } from "@/lib/admin-auth";
import { logAdminAction } from "@/lib/admin-log";
import { publicError, publicJson, rateLimit, readJsonBody } from "@/lib/security";
import {
  getPlaylist,
  sanitizePlaylist,
  setPlaylist,
} from "@/lib/woodamp-playlist-store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * The WoodAmp community playlist (Phase 2 of lib/woodamp-playlist.ts).
 *
 * GET  — public. The player fetches this on mount; the shape is exactly
 *        WoodAmpTrack[] so components don't change. Briefly cacheable: the
 *        list changes only when an admin saves.
 * PUT  — admin only. Replaces the whole list (add/remove/reorder/edit are all
 *        one full-list save from /admin). Authorized by a wallet signature
 *        bound to this action, a fresh timestamp, and the payload hash — see
 *        lib/admin-auth.ts.
 */

export async function GET(req: Request) {
  const limited = rateLimit(req, {
    key: "music-playlist-get",
    limit: 120,
    windowMs: 60_000,
  });
  if (limited) return limited;
  try {
    const tracks = await getPlaylist();
    return NextResponse.json(
      { tracks },
      {
        headers: {
          "Cache-Control": "public, s-maxage=60, stale-while-revalidate=300",
        },
      }
    );
  } catch (err) {
    return publicError(err, "Could not load the playlist.");
  }
}

type PutBody = {
  tracks?: unknown;
  auth?: Partial<AdminProof>;
};

export async function PUT(req: Request) {
  try {
    const limited = rateLimit(req, {
      key: "music-playlist-put",
      limit: 30,
      windowMs: 60_000,
    });
    if (limited) return limited;

    const body = await readJsonBody<PutBody>(req);
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

    const parsed = sanitizePlaylist(body.tracks);
    if (!parsed.ok) {
      return publicJson(
        {
          error: "BAD_TRACKS",
          message:
            parsed.error.index >= 0
              ? `Track ${parsed.error.index + 1}: ${parsed.error.message}`
              : parsed.error.message,
        },
        400
      );
    }

    // The signature covers the sanitized track list the server will actually
    // store — the client signs JSON.stringify of the same cleaned array.
    const verdict = verifyAdminProof(
      "woodamp-playlist",
      JSON.stringify(parsed.tracks),
      auth as AdminProof
    );
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

    await setPlaylist(parsed.tracks);
    await logAdminAction(
      verdict.address,
      "woodamp-playlist",
      `Saved ${parsed.tracks.length} track${parsed.tracks.length === 1 ? "" : "s"}`
    );
    return publicJson({ ok: true, count: parsed.tracks.length });
  } catch (err) {
    return publicError(err, "Unexpected error saving the playlist.");
  }
}

export function POST() {
  return publicJson({ error: "METHOD", message: "Use GET or PUT." }, 405);
}

export function DELETE() {
  return publicJson({ error: "METHOD", message: "Use GET or PUT." }, 405);
}
