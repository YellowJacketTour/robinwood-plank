import { postgresPool } from "@/lib/postgres";
import { charmSocial } from "@/lib/charmville/social";
import { YardError } from "@/lib/charmville/errors";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control":"private, no-store" };
async function handle(request: Request, write: boolean) {
  try {
    if (write && request.headers.get("origin") && request.headers.get("origin") !== new URL(request.url).origin)
      throw new YardError("Use Charmdex on PlankSpace",403);
    let raw: unknown;
    if (write) {
      const body = await request.text();
      if (body.length>2048) throw new YardError("Action too large",413);
      try { raw=JSON.parse(body); } catch { throw new YardError("Invalid pin",400); }
    }
    return Response.json(await charmSocial(postgresPool(),request.headers.get("authorization")?.replace(/^Bearer\s+/i,"") ?? "",raw),{headers});
  } catch (error) {
    return Response.json({error:error instanceof YardError ? error.message : "Charmdex is temporarily unavailable"},{status:error instanceof YardError ? error.status : 503,headers});
  }
}
export const GET = (request: Request) => handle(request,false);
export const POST = (request: Request) => handle(request,true);
