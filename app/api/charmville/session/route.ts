import { postgresPool } from "@/lib/postgres";
import { GameSessionError, readGameSession } from "@/lib/charmville/account-session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store", "Vary": "Authorization" };

export async function GET(request: Request) {
  try {
    const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
    return Response.json(await readGameSession(postgresPool(), token), { headers });
  } catch (error) {
    const denied = error instanceof GameSessionError;
    return Response.json({ error: denied ? error.message : "Account service unavailable." },
      { status: denied ? 401 : 503, headers });
  }
}
