import {postgresPool} from "@/lib/postgres";
import {redeemCharmvilleInvite} from "@/lib/charmville/invites";
import {YardError} from "@/lib/charmville/errors";
export const runtime="nodejs";
export const dynamic="force-dynamic";
const headers={"Cache-Control":"private, no-store","Referrer-Policy":"no-referrer"};
export async function POST(request:Request) {
  try {
    if(request.headers.get("origin")&&request.headers.get("origin")!==new URL(request.url).origin)throw new YardError("Use the private Charmville access page",403);
    const body=await request.text();if(body.length>256)throw new YardError("Invitation too large",413);
    let raw:unknown;try {raw=JSON.parse(body);} catch {throw new YardError("Invalid invitation",400);}
    return Response.json(await redeemCharmvilleInvite(postgresPool(),request.headers.get("authorization")?.replace(/^Bearer\s+/i,"")??"",raw),{headers});
  } catch(error) {return Response.json({error:error instanceof YardError?error.message:"Invitation could not be redeemed"},{status:error instanceof YardError?error.status:503,headers});}
}
