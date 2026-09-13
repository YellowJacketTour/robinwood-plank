import {postgresPool} from "@/lib/postgres";
import {inviteBattleAssist} from "@/lib/charmville/battle-assist";
import {YardError} from "@/lib/charmville/errors";
export const runtime="nodejs";export const dynamic="force-dynamic";
export async function POST(r:Request){const headers={"Cache-Control":"private, no-store"};try{const origin=r.headers.get("origin");if(origin&&origin!==new URL(r.url).origin)throw new YardError("Use Plank Love",403);const body=await r.text();if(body.length>1024)throw new YardError("Request too large",413);let raw:unknown;try{raw=JSON.parse(body);}catch{throw new YardError("Invalid invitation",400);}return Response.json(await inviteBattleAssist(postgresPool(),r.headers.get("authorization")?.replace(/^Bearer\s+/i,"")??"",raw),{headers});}catch(e){return Response.json({error:e instanceof YardError?e.message:"Assist unavailable"},{status:e instanceof YardError?e.status:503,headers});}}
