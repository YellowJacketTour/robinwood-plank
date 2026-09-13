import {postgresPool} from "@/lib/postgres";
import {creatureRoster,parseRoster} from "@/lib/charmville/creature-roster";
import {YardError} from "@/lib/charmville/errors";
export const runtime="nodejs";export const dynamic="force-dynamic";
const headers={"Cache-Control":"private, no-store"};
const token=(r:Request)=>r.headers.get("authorization")?.replace(/^Bearer\s+/i,"")??"";
const fail=(e:unknown)=>Response.json({error:e instanceof YardError?e.message:"Party unavailable"},{status:e instanceof YardError?e.status:503,headers});
export async function GET(r:Request){try{return Response.json(await creatureRoster(postgresPool(),token(r)),{headers});}catch(e){return fail(e);}}
export async function POST(r:Request){try{const origin=r.headers.get("origin");if(origin&&origin!==new URL(r.url).origin)throw new YardError("Use your party on Plank Love",403);const text=await r.text();if(text.length>2048)throw new YardError("Request too large",413);let raw:unknown;try{raw=JSON.parse(text);}catch{throw new YardError("Invalid party",400);}return Response.json(await creatureRoster(postgresPool(),token(r),parseRoster(raw)),{headers});}catch(e){return fail(e);}}
