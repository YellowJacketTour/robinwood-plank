import {postgresPool} from "@/lib/postgres";
import {nativeResources} from "@/lib/charmville/native-resources";
import {YardError} from "@/lib/charmville/errors";
import {nativeResourceRequestPolicy} from "@/lib/charmville/native-resource-negotiation";
import {requireRuntimeRequestOrigin} from "@/lib/charmville/runtime-request-origin";
import {acceptedHeartCapability} from "@/lib/charmville/accepted-heart-capability";
export const runtime="nodejs";export const dynamic="force-dynamic";
const headers={"Cache-Control":"private, no-store"};
const token=(r:Request)=>r.headers.get("authorization")?.replace(/^Bearer\s+/i,"")??"";
const fail=(e:unknown)=>Response.json({error:e instanceof YardError?e.message:"World actions unavailable"},{status:e instanceof YardError?e.status:503,headers});
export async function GET(r:Request){try{const policy=nativeResourceRequestPolicy(r,process.env,await acceptedHeartCapability());return Response.json(await nativeResources(postgresPool(),token(r),undefined,policy),{headers});}catch(e){return fail(e);}}
export async function POST(r:Request){try{requireRuntimeRequestOrigin(r,{allowMissing:true});const policy=nativeResourceRequestPolicy(r,process.env,await acceptedHeartCapability());const text=await r.text();if(text.length>1024)throw new YardError("Action too large",413);let raw:unknown;try{raw=JSON.parse(text);}catch{throw new YardError("Invalid action",400);}return Response.json(await nativeResources(postgresPool(),token(r),raw,policy),{headers});}catch(e){return fail(e);}}
