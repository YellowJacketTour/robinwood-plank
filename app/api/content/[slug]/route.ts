import { NextResponse } from "next/server";
import { verifyAdminProof, type AdminProof } from "@/lib/admin-auth";
import { logAdminAction } from "@/lib/admin-log";
import { isContentSlug, sanitizeContent } from "@/lib/content-docs";
import { getContent, setContent } from "@/lib/content-store";
import { publicError, publicJson, rateLimit, readJsonBody } from "@/lib/security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * CMS documents (lib/content-docs.ts): learn, intro, banner, flags,
 * collections. Same contract as /api/music/playlist — public GET with a
 * short cache, admin-signed PUT over the sanitized JSON, action-logged.
 */

export async function GET(
  req: Request,
  ctx: { params: Promise<{ slug: string }> }
) {
  const limited = rateLimit(req, {
    key: "content-get",
    limit: 240,
    windowMs: 60_000,
  });
  if (limited) return limited;
  const { slug } = await ctx.params;
  if (!isContentSlug(slug)) {
    return publicJson({ error: "NOT_FOUND", message: "Unknown document." }, 404);
  }
  try {
    const doc = await getContent(slug);
    return NextResponse.json(
      { slug, doc },
      {
        headers: {
          "Cache-Control": "public, s-maxage=30, stale-while-revalidate=300",
        },
      }
    );
  } catch (err) {
    return publicError(err, "Could not load the document.");
  }
}

type PutBody = { doc?: unknown; auth?: Partial<AdminProof> };

export async function PUT(
  req: Request,
  ctx: { params: Promise<{ slug: string }> }
) {
  try {
    const limited = rateLimit(req, {
      key: "content-put",
      limit: 30,
      windowMs: 60_000,
    });
    if (limited) return limited;
    const { slug } = await ctx.params;
    if (!isContentSlug(slug)) {
      return publicJson({ error: "NOT_FOUND", message: "Unknown document." }, 404);
    }

    const body = await readJsonBody<PutBody>(req);
    const auth = body.auth;
    if (
      !auth ||
      typeof auth.address !== "string" ||
      typeof auth.signature !== "string" ||
      typeof auth.timestamp !== "number"
    ) {
      return publicJson(
        { error: "BAD_AUTH", message: "auth requires address, timestamp, and signature." },
        400
      );
    }

    const parsed = sanitizeContent(slug, body.doc);
    if (!parsed.ok) {
      return publicJson({ error: "BAD_DOC", message: parsed.message }, 400);
    }

    const verdict = verifyAdminProof(
      `content-${slug}`,
      JSON.stringify(parsed.value),
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

    await setContent(slug, parsed.value);
    await logAdminAction(
      verdict.address,
      `content-${slug}`,
      `Updated ${slug} document`
    );
    return publicJson({ ok: true });
  } catch (err) {
    return publicError(err, "Unexpected error saving the document.");
  }
}

export function POST() {
  return publicJson({ error: "METHOD", message: "Use GET or PUT." }, 405);
}
