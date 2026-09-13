import {postgresPool} from "@/lib/postgres";
import {worldEncounter} from "@/lib/charmville/encounters";
import {YardError} from "@/lib/charmville/errors";
export const runtime="nodejs";export const dynamic="force-dynamic";
const headers={"Cache-Control":"private, no-store"};
const token=(r:Request)=>r.headers.get("authorization")?.replace(/^Bearer\s+/i,"")??"";
const fail=(e:unknown)=>Response.json({error:e instanceof YardError?e.message:"Encounter unavailable"},{status:e instanceof YardError?e.status:503,headers});
export async function GET(r:Request){try{return Response.json(await worldEncounter(postgresPool(),token(r)),{headers});}catch(e){return fail(e);}}
export async function POST(r:Request){try{const origin=r.headers.get("origin");if(origin&&origin!==new URL(r.url).origin)throw new YardError("Use Plank Love to inspect",403);const text=await r.text();if(text.length>1024)throw new YardError("Request too large",413);let raw:unknown;try{raw=JSON.parse(text);}catch{throw new YardError("Invalid encounter",400);}return Response.json(await worldEncounter(postgresPool(),token(r),raw),{headers});}catch(e){return fail(e);}}
