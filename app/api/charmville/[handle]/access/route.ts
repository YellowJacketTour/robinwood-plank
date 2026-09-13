import { postgresPool } from "@/lib/postgres";
import { homeAccess, parseHomeGrant } from "@/lib/charmville/home-access-store";
import { YardError } from "@/lib/charmville/store";
export const runtime="nodejs";
export const dynamic="force-dynamic";
type Context={params:Promise<{handle:string}>};
const headers={"Cache-Control":"private, no-store"};
const token=(request:Request)=>request.headers.get("authorization")?.replace(/^Bearer\s+/i,"")??"";
function failure(error:unknown) { return Response.json({error:error instanceof YardError?error.message:"Home permissions are unavailable"},{status:error instanceof YardError?error.status:503,headers}); }
export async function GET(request:Request,context:Context) {
 try { return Response.json(await homeAccess(postgresPool(),(await context.params).handle.toLowerCase(),token(request)),{headers}); } catch(error) { return failure(error); }
}
export async function POST(request:Request,context:Context) {
 try {
  const origin=request.headers.get("origin");
  if(origin && origin!==new URL(request.url).origin) throw new YardError("Use home permissions on Plank Love",403);
  const text=await request.text();
  if(text.length>4096) throw new YardError("Permission request too large",413);
  let raw:unknown;
  try {raw=JSON.parse(text);} catch {throw new YardError("Invalid permission request",400);}
  return Response.json(await homeAccess(postgresPool(),(await context.params).handle.toLowerCase(),token(request),parseHomeGrant(raw)),{headers});
 } catch(error) {return failure(error);}
}
