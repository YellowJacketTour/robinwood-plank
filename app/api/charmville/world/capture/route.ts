import {postgresPool} from '@/lib/postgres';
import {captureCreature} from '@/lib/charmville/capture';
import {localPlaytestRequestAllowed,localPlaytestEnabled} from '@/lib/charmville/local-playtest-policy';
import {YardError} from '@/lib/charmville/errors';
export const runtime='nodejs';export const dynamic='force-dynamic';
const headers={'Cache-Control':'private, no-store'};
async function handle(r:Request,post:boolean){try{let q:unknown;if(post){if(r.headers.get('origin')&&r.headers.get('origin')!==new URL(r.url).origin)throw new YardError('Use the same game origin',403);const text=await r.text();if(text.length>1024)throw new YardError('Request too large',413);try{q=JSON.parse(text);}catch{throw new YardError('Invalid capture request',400);}}
const result=await captureCreature(postgresPool(),r.headers.get('authorization')?.replace(/^Bearer\s+/i,'')??'',q,localPlaytestRequestAllowed(r,process.env));if(result.canProvision&&!localPlaytestEnabled(process.env))result.canProvision=false;return Response.json(result,{headers});}catch(e){return Response.json({error:e instanceof YardError?e.message:'Capture unavailable'},{status:e instanceof YardError?e.status:503,headers});}}
export async function GET(r:Request){return handle(r,false);}export async function POST(r:Request){return handle(r,true);}
