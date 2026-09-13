import {postgresPool} from '@/lib/postgres';
import {journeyProgress} from '@/lib/charmville/journey-progress';
import {YardError} from '@/lib/charmville/errors';
export const runtime='nodejs';
export const dynamic='force-dynamic';
const headers={'Cache-Control':'private, no-store','Vary':'Authorization'};
export async function GET(request:Request){
 try{
  const token=request.headers.get('authorization')?.match(/^Bearer\s+([a-f0-9]{64})$/i)?.[1]??'';
  return Response.json(await journeyProgress(postgresPool(),token),{headers});
 }catch(error){
  return Response.json({error:error instanceof YardError?error.message:'Journey unavailable'},
   {status:error instanceof YardError?error.status:503,headers});
 }
}
