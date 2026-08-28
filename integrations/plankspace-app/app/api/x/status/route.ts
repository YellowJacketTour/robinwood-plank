import { eq } from "drizzle-orm";
import { getDb } from "../../../../db";
import { profiles, xAccounts } from "../../../../db/schema";
import { publicXAccount } from "../../../x/account";

export async function GET(request:Request){const params=new URL(request.url).searchParams,handle=(params.get("handle")||"").toLowerCase(),wallet=(params.get("wallet")||"").toLowerCase(),db=getDb();let account;if(handle)[account]=await db.select().from(xAccounts).where(eq(xAccounts.profileHandle,handle)).limit(1);else if(wallet)[account]=await db.select().from(xAccounts).where(eq(xAccounts.wallet,wallet)).limit(1);if(!account)return Response.json({connected:false,provider:process.env.PLANKSPACE_X_PROVIDER==="development"?"development":"live"});const [profile]=await db.select({handle:profiles.handle}).from(profiles).where(eq(profiles.wallet,account.wallet)).limit(1);return Response.json({...publicXAccount(account),handle:profile?.handle||account.profileHandle})}
