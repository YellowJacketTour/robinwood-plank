import { createReadStream, promises as fs } from "node:fs";
import { Readable } from "node:stream";
import { NextResponse } from "next/server";
import { rateLimit } from "@/lib/security";
import { resolveUploadPath, uploadContentType } from "@/lib/uploads";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Serves admin-uploaded media from UPLOADS_DIR (see lib/uploads.ts). Names
 * are content-addressed and validated against a strict pattern (no traversal)
 * — a stored file never changes, so responses are immutable-cacheable.
 * Supports single Range requests: Safari refuses to play <audio> from
 * endpoints that ignore Range.
 */

export async function GET(
  req: Request,
  ctx: { params: Promise<{ name: string }> }
) {
  const limited = rateLimit(req, {
    key: "media-get",
    limit: 600,
    windowMs: 60_000,
  });
  if (limited) return limited;

  const { name } = await ctx.params;
  const filePath = resolveUploadPath(name);
  if (!filePath) {
    return NextResponse.json(
      { error: "NOT_FOUND", message: "No such file." },
      { status: 404 }
    );
  }

  let size: number;
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) throw new Error();
    size = stat.size;
  } catch {
    return NextResponse.json(
      { error: "NOT_FOUND", message: "No such file." },
      { status: 404 }
    );
  }

  const headers: Record<string, string> = {
    "Content-Type": uploadContentType(name),
    "Accept-Ranges": "bytes",
    // Content-addressed names never change content.
    "Cache-Control": "public, max-age=31536000, immutable",
  };

  const range = req.headers.get("range");
  if (range) {
    const match = range.match(/^bytes=(\d*)-(\d*)$/);
    if (!match || (match[1] === "" && match[2] === "")) {
      return new NextResponse(null, {
        status: 416,
        headers: { ...headers, "Content-Range": `bytes */${size}` },
      });
    }
    const start = match[1] === "" ? Math.max(0, size - Number(match[2])) : Number(match[1]);
    const end =
      match[1] !== "" && match[2] !== ""
        ? Math.min(Number(match[2]), size - 1)
        : size - 1;
    if (start > end || start >= size) {
      return new NextResponse(null, {
        status: 416,
        headers: { ...headers, "Content-Range": `bytes */${size}` },
      });
    }
    const stream = Readable.toWeb(
      createReadStream(filePath, { start, end })
    ) as ReadableStream;
    return new NextResponse(stream, {
      status: 206,
      headers: {
        ...headers,
        "Content-Range": `bytes ${start}-${end}/${size}`,
        "Content-Length": String(end - start + 1),
      },
    });
  }

  const stream = Readable.toWeb(createReadStream(filePath)) as ReadableStream;
  return new NextResponse(stream, {
    status: 200,
    headers: { ...headers, "Content-Length": String(size) },
  });
}
