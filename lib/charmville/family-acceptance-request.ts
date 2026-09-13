import {YardError} from "./errors";
import {FAMILY_ENTITLEMENT_VERSION} from "./family-entitlement";
import {requireRuntimeRequestOrigin} from "./runtime-request-origin";

type Environment = Record<string,string|undefined>;
/** Production deliberately cannot opt in yet: native crop identity/art and
 * supported-client negotiation have not passed acceptance. Local developers
 * must explicitly enable this version; migration alone never issues supply. */
export function familyAcceptanceEnabled(env:Environment):boolean {
  return env.NODE_ENV === "development" &&
    env.CHARMVILLE_FAMILY_OPENING_VERSION === FAMILY_ENTITLEMENT_VERSION;
}

export async function readFamilyAcceptance(request:Request, env:Environment=process.env):Promise<string> {
  if (!familyAcceptanceEnabled(env)) throw new YardError("Family opening is not available yet",409);
  requireRuntimeRequestOrigin(request,{env});
  if (request.method !== "POST") throw new YardError("Accept the family gift explicitly",405);
  const authorization=request.headers.get("authorization")??"";
  const match=/^Bearer ([a-f0-9]{64})$/i.exec(authorization);
  if (!match) throw new YardError("Sign in to accept your family gift",401);
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json")
    throw new YardError("Send a family acceptance",415);
  const reader=request.body?.getReader();
  if (!reader) throw new YardError("Accept the family gift explicitly",400);
  const chunks:Uint8Array[]=[];let length=0;
  try {
    while (true) {
      const {done,value}=await reader.read();if(done)break;
      length+=value.byteLength;
      if(length>512){await reader.cancel();throw new YardError("Acceptance too large",413);}
      chunks.push(value);
    }
  } finally {reader.releaseLock();}
  const bytes=new Uint8Array(length);let offset=0;
  for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
  let raw:unknown;
  try {raw=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(bytes));}
  catch {throw new YardError("Invalid family acceptance",400);}
  if (!raw || typeof raw!=="object" || Array.isArray(raw) || Object.keys(raw).length!==1 ||
      (raw as Record<string,unknown>).accept!==FAMILY_ENTITLEMENT_VERSION)
    throw new YardError("Accept the current family gift",400);
  // This is only a bearer syntax check. The transaction resolves the active
  // approved profile and current admission before creating a receipt.
  return match[1];
}
