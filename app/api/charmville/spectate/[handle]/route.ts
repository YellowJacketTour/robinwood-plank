import {postgresPool} from '@/lib/postgres';
import {spectatorView} from '@/lib/charmville/spectator-store';
import {YardError} from '@/lib/charmville/errors';
export const runtime='nodejs';
export const dynamic='force-dynamic';
const headers={'Cache-Control':'private, no-store','Vary':'Authorization'};
const token=(r:Request)=>r.headers.get('authorization')?.replace(/^Bearer\s+/i,'')??'';
const fail=(e:unknown)=>Response.json({error:e instanceof YardError?e.message:'Game view unavailable'},{status:e instanceof YardError?e.status:503,headers});
type Context={params:Promise<{handle:string}>};
export async function GET(r:Request,c:Context){try{return Response.json(await spectatorView(postgresPool(),(await c.params).handle,token(r)),{headers});}catch(e){return fail(e);}}
export async function PUT(r:Request,c:Context){try{
 if(r.headers.get('origin')!==new URL(r.url).origin)throw new YardError('Use your profile to change settings',403);
 const body=await r.text();if(body.length>6000)throw new YardError('Too many allowed profiles',413);
 let raw:unknown;try{raw=JSON.parse(body);}catch{throw new YardError('Invalid settings',400);}
 return Response.json(await spectatorView(postgresPool(),(await c.params).handle,token(r),raw),{headers});
}catch(e){return fail(e);}}
