import { postgresPool } from '@/lib/postgres';
import { exchangeCommand, readExchange } from '@/lib/charmville/exchange';
import { YardError } from '@/lib/charmville/errors';
export const runtime='nodejs';
export const dynamic='force-dynamic';
const headers={'Cache-Control':'private, no-store'};
export async function GET(){try{return Response.json(await readExchange(postgresPool()),{headers});}catch{return Response.json({error:'Exchange unavailable'},{status:503,headers});}}
export async function POST(request:Request){
 try{
  if(request.headers.get('origin') && request.headers.get('origin')!==new URL(request.url).origin)throw new YardError('Invalid origin',403);
  const body=await request.text();if(body.length>2048)throw new YardError('Request too large',413);
  let input;try{input=JSON.parse(body);}catch{throw new YardError('Invalid request',400);}
  return Response.json(await exchangeCommand(postgresPool(),request.headers.get('authorization')?.replace(/^Bearer\s+/i,'')??'',input),{headers});
 }catch(error){return Response.json({error:error instanceof YardError?error.message:'Exchange unavailable'},{status:error instanceof YardError?error.status:503,headers});}
}
