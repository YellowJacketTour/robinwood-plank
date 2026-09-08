import { postgresPool } from "@/lib/postgres";
import { mutateYard, parseYardAction, readYard, YardError } from "@/lib/charmville/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ handle: string }> };
const headers = { "Cache-Control": "private, no-store" };
function token(request: Request) { return request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? ""; }
function failure(error: unknown) {
  if (error instanceof YardError) return Response.json({ error: error.message }, { status: error.status, headers });
  // Do not leak SQL, session material, or inventory through errors/logging.
  return Response.json({ error: "Your porch is unavailable. Please try again shortly." }, { status: 503, headers });
}
export async function GET(request: Request, context: Context) {
  try {
    const { handle } = await context.params;
    return Response.json(await readYard(postgresPool(), handle.toLowerCase(), token(request)), { headers });
  } catch (error) { return failure(error); }
}
export async function POST(request: Request, context: Context) {
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin)
    return Response.json({ error: "Use the porch on Plank Love" }, { status: 403, headers });
  try {
    const text = await request.text();
    if (text.length > 2048) return Response.json({ error: "Action too large" }, { status: 413, headers });
    let raw: unknown;
    try { raw = JSON.parse(text); } catch { throw new YardError("Invalid yard action", 400); }
    const { handle } = await context.params;
    return Response.json(await mutateYard(postgresPool(), handle.toLowerCase(), token(request), parseYardAction(raw)), { headers });
  } catch (error) { return failure(error); }
}
