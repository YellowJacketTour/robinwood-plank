import {postgresPool} from "@/lib/postgres";
import {parseTutorialPreference, tutorialPreference} from "@/lib/charmville/tutorial";
import {YardError} from "@/lib/charmville/errors";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = {"Cache-Control": "private, no-store"};
const token = (request: Request) => request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
const fail = (error: unknown) => Response.json({error: error instanceof YardError ? error.message : "Introduction preferences are unavailable"}, {status: error instanceof YardError ? error.status : 503, headers});
export async function GET(request: Request) {
 try {return Response.json(await tutorialPreference(postgresPool(), token(request)), {headers});}
 catch (error) {return fail(error);}
}
export async function POST(request: Request) {
 try {
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) throw new YardError("Change your introduction on Plank Love", 403);
  const text = await request.text();
  if (text.length > 128) throw new YardError("Request too large", 413);
  let raw: unknown;
  try {raw = JSON.parse(text);} catch {throw new YardError("Invalid introduction preference", 400);}
  return Response.json(await tutorialPreference(postgresPool(), token(request), parseTutorialPreference(raw)), {headers});
 } catch (error) {return fail(error);}
}
