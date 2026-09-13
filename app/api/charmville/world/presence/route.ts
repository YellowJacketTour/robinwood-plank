import {postgresPool} from "@/lib/postgres";
import {worldPresence,parseWorldEntry} from "@/lib/charmville/world-presence";
import {YardError} from "@/lib/charmville/errors";
export const runtime="nodejs";
export const dynamic="force-dynamic";
const headers={"Cache-Control":"private, no-store"};
const token=(r:Request)=>r.headers.get("authorization")?.replace(/^Bearer\s+/i,"")??"";
const fail=(e:unknown)=>Response.json({error:e instanceof YardError?e.message:"World access is unavailable"},{status:e instanceof YardError?e.status:503,headers});
export async function GET(r:Request){try{return Response.json(await worldPresence(postgresPool(),token(r)),{headers});}catch(e){return fail(e);}}
export async function POST(r:Request){try{
 const origin=r.headers.get("origin");if(origin && origin!==new URL(r.url).origin)throw new YardError("Enter the world through Plank Love",403);
 const text=await r.text();if(text.length>1024)throw new YardError("Destination request too large",413);
 let raw:unknown;try{raw=JSON.parse(text);}catch{throw new YardError("Invalid destination",400);}
 return Response.json(await worldPresence(postgresPool(),token(r),parseWorldEntry(raw)),{headers});
}catch(e){return fail(e);}}
