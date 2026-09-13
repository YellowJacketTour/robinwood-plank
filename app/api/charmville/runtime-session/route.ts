import {postgresPool} from "@/lib/postgres";
import {issueRuntimeSession,runtimeSessionCookie} from "@/lib/charmville/runtime-session";
import {YardError} from "@/lib/charmville/errors";
export const runtime="nodejs";
export const dynamic="force-dynamic";
const headers={"Cache-Control":"private, no-store","Referrer-Policy":"no-referrer"};
export async function POST(request:Request) {
  try {
    const origin=request.headers.get("origin");
    if(origin&&origin!==new URL(request.url).origin)throw new YardError("Open the game through PlankSpace",403);
    const token=request.headers.get("authorization")?.replace(/^Bearer\s+/i,"")??"";
    const result=await issueRuntimeSession(postgresPool(),token);
    return Response.json({expiresAt:result.expiresAt},{headers:{...headers,"Set-Cookie":runtimeSessionCookie(result.ticket)}});
  } catch(error){return Response.json({error:error instanceof YardError?error.message:"The game could not open. Please try again"},{status:error instanceof YardError?error.status:503,headers});}
}
