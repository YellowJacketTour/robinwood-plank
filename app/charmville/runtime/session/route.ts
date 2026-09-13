import {postgresPool} from "@/lib/postgres";
import {renewRuntimeSession,runtimeSessionCookie} from "@/lib/charmville/runtime-session";
import {YardError} from "@/lib/charmville/errors";
import {requireRuntimeRequestOrigin} from "@/lib/charmville/runtime-request-origin";
export const runtime="nodejs";
export const dynamic="force-dynamic";
const headers={"Cache-Control":"private, no-store","Referrer-Policy":"no-referrer"};
export async function POST(request:Request) {
  try {
    // This cookie-bearing renewal is browser same-origin only. Missing Origin
    // is denied; clients cannot renew by posting a token embedded in a URL.
    requireRuntimeRequestOrigin(request);
    const bearer=request.headers.get("authorization")?.replace(/^Bearer\s+/i,"")??"";
    const result=await renewRuntimeSession(postgresPool(),bearer,request);
    return Response.json({expiresAt:result.expiresAt},{headers:{...headers,"Set-Cookie":runtimeSessionCookie(result.ticket)}});
  } catch(error){return Response.json({error:error instanceof YardError?error.message:"The game session could not renew"},{status:error instanceof YardError?error.status:503,headers});}
}
