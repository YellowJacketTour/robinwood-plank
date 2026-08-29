import { eq } from "drizzle-orm";
import { getDb } from "../../../../db";
import { profiles, xAccounts } from "../../../../db/schema";
import { isUsableXAccountRecord, publicXAccount } from "../../../x/account";

export async function GET(request:Request){const params=new URL(request.url).searchParams,handle=(params.get("handle")||"").toLowerCase(),wallet=(params.get("wallet")||"").toLowerCase(),db=getDb(),provider=process.env.PLANKSPACE_X_PROVIDER==="development"?"development":"live";let account;if(handle)[account]=await db.select().from(xAccounts).where(eq(xAccounts.profileHandle,handle)).limit(1);else if(wallet)[account]=await db.select().from(xAccounts).where(eq(xAccounts.wallet,wallet)).limit(1);if(!account)return Response.json({connected:false,provider});const [profile]=await db.select({handle:profiles.handle}).from(profiles).where(eq(profiles.wallet,account.wallet)).limit(1),resolvedHandle=profile?.handle||account.profileHandle;if(!isUsableXAccountRecord(account,provider))return Response.json({connected:false,needsReconnect:true,provider,username:account.xUsername,handle:resolvedHandle});return Response.json({...publicXAccount(account),handle:resolvedHandle})}
