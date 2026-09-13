import {postgresPool} from "@/lib/postgres";
import {localPlaytestRequestAllowed} from "@/lib/charmville/local-playtest-policy";
import {testParty} from "@/lib/charmville/test-party";
import {YardError} from "@/lib/charmville/errors";
export const runtime="nodejs";export const dynamic="force-dynamic";
const headers={"Cache-Control":"private, no-store"};
async function handle(r:Request,provision:boolean){if(!localPlaytestRequestAllowed(r,process.env))return Response.json({eligible:false,granted:false},{status:provision?404:200,headers});try{return Response.json(await testParty(postgresPool(),r.headers.get("authorization")?.replace(/^Bearer\s+/i,"")??"",provision),{headers});}catch(e){return Response.json({error:e instanceof YardError?e.message:"Sandbox party unavailable"},{status:e instanceof YardError?e.status:503,headers});}}
export async function GET(r:Request){return handle(r,false);}
export async function POST(r:Request){const body=await r.text();if(body.length>128)return Response.json({error:"Request too large"},{status:413,headers});if(body){try{const q=JSON.parse(body);if(q.action==="capabilities")return handle(r,false);if(q.action!=="provision")return Response.json({error:"Invalid action"},{status:400,headers});}catch{return Response.json({error:"Invalid action"},{status:400,headers});}}return handle(r,true);}

