import {postgresPool} from "@/lib/postgres";
import {acceptFamilySeeds,familyGiftStatus} from "@/lib/charmville/family-entitlement";
import {readFamilyAcceptance,familyAcceptanceEnabled} from "@/lib/charmville/family-acceptance-request";
import {YardError} from "@/lib/charmville/errors";

export const runtime="nodejs";
export const dynamic="force-dynamic";
const headers={"Cache-Control":"private, no-store","Referrer-Policy":"no-referrer"};

export async function GET(request:Request) {
  if(!familyAcceptanceEnabled(process.env))return Response.json({available:false},{headers});
  try {
    const token=request.headers.get("authorization")?.replace(/^Bearer\s+/i,"")??"";
    return Response.json(await familyGiftStatus(postgresPool(),token),{headers});
  }catch(error){return Response.json({error:error instanceof YardError?error.message:"Family gift unavailable"},{status:error instanceof YardError?error.status:503,headers});}
}

export async function POST(request:Request) {
  try {
    // All request/activation checks precede opening the database pool. No GET,
    // retry count or request-provided identity/quantity can create a grant.
    const token=await readFamilyAcceptance(request);
    const receipt=await acceptFamilySeeds(postgresPool(),token,{enabled:true});
    return Response.json({receipt},{headers});
  } catch(error) {
    return Response.json({error:error instanceof YardError?error.message:"Your family gift could not be accepted. Please try again"},
      {status:error instanceof YardError?error.status:503,headers});
  }
}
