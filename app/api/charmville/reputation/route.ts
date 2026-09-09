import { postgresPool } from "@/lib/postgres";
import { parsePineSearch, ReputationSearchError, searchPineReputation } from "@/lib/charmville/reputation-search";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store" };
export async function GET(request: Request) {
  try {
    const search = parsePineSearch(new URL(request.url).searchParams);
    const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
    return Response.json(await searchPineReputation(postgresPool(), search, token), { headers });
  } catch (error) {
    return Response.json({ error: error instanceof ReputationSearchError ? error.message : "Pine search is temporarily unavailable. Please try again." }, { status: error instanceof ReputationSearchError ? error.status : 503, headers });
  }
}
