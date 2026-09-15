import { postgresPool } from "@/lib/postgres";
import { charmSocial } from "@/lib/charmville/social";
import { YardError } from "@/lib/charmville/errors";
import {heartSocialPolicy} from "@/lib/charmville/social-policy";
import {acceptedHeartCapability} from "@/lib/charmville/accepted-heart-capability";
import {requireRuntimeRequestOrigin} from "@/lib/charmville/runtime-request-origin";
import {socialCustodyItems} from "@/lib/charmville/social-items";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control":"private, no-store" };
async function handle(request: Request, write: boolean) {
  try {
    if(write)requireRuntimeRequestOrigin(request,{allowMissing:true});
    let raw: unknown;
    if (write) {
      const body = await request.text();
      if (body.length>2048) throw new YardError("Action too large",413);
      try { raw=JSON.parse(body); } catch { throw new YardError("Invalid pin",400); }
    }
    const policy=heartSocialPolicy(request,process.env,await acceptedHeartCapability());
    const result=await charmSocial(postgresPool(),request.headers.get("authorization")?.replace(/^Bearer\s+/i,"") ?? "",raw,policy);
    return Response.json(write?result:{...result,enabledItems:socialCustodyItems(policy).map(item=>item.id)},{headers});
  } catch (error) {
    return Response.json({error:error instanceof YardError ? error.message : "Charmdex is temporarily unavailable"},{status:error instanceof YardError ? error.status : 503,headers});
  }
}
export const GET = (request: Request) => handle(request,false);
export const POST = (request: Request) => handle(request,true);
