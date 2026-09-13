import {postgresPool} from "@/lib/postgres";
import {manageCharmvilleInvites} from "@/lib/charmville/invites";
import {YardError} from "@/lib/charmville/errors";
export const runtime="nodejs";
export const dynamic="force-dynamic";
const headers={"Cache-Control":"private, no-store","Referrer-Policy":"no-referrer"};
async function handle(request:Request,write:boolean) {
  try {
    if(write&&request.headers.get("origin")&&request.headers.get("origin")!==new URL(request.url).origin) throw new YardError("Use the private Charmville access page",403);
    let raw:unknown;
    if(write) {
      const body=await request.text();if(body.length>2048)throw new YardError("Action too large",413);
      try {raw=JSON.parse(body);} catch {throw new YardError("Invalid invitation action",400);}
    }
    return Response.json(await manageCharmvilleInvites(postgresPool(),request.headers.get("authorization")?.replace(/^Bearer\s+/i,"")??"",raw),{headers});
  } catch(error) {return Response.json({error:error instanceof YardError?error.message:"Invitations are temporarily unavailable"},{status:error instanceof YardError?error.status:503,headers});}
}
export const GET=(request:Request)=>handle(request,false);
export const POST=(request:Request)=>handle(request,true);
