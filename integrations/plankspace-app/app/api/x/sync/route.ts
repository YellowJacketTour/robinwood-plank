import { eq } from "drizzle-orm";
import { getDb } from "../../../../db";
import { posts, profiles, xAccounts, xPostMappings } from "../../../../db/schema";
import { hashJson } from "../../auth/hash";
import { type Proof, verifyAndConsumeProof } from "../../auth/verify";
import { loadXAccount } from "../../../x/account";
import { getXProvider } from "../../../x/provider";

export async function POST(request:Request){const payload=await request.json() as Proof&{handle?:string},handle=String(payload.handle||"").toLowerCase(),wallet=await verifyAndConsumeProof(payload,"x:sync",handle,await hashJson({handle}));if(!wallet)return Response.json({error:"Signed owner proof required"},{status:403});const db=getDb(),account=await loadXAccount(wallet);if(!account)return Response.json({error:"Connect X first"},{status:409});const [row]=await db.select().from(xAccounts).where(eq(xAccounts.wallet,wallet)).limit(1),[profile]=await db.select({displayName:profiles.displayName}).from(profiles).where(eq(profiles.wallet,wallet)).limit(1),result=await getXProvider().listRecentPosts(account,row?.syncCursor||"");let imported=0;for(const item of result.posts){try{const [post]=await db.insert(posts).values({author:profile?.displayName||account.username,authorWallet:wallet,body:item.text.slice(0,500),source:"x",externalPostId:item.id,xPostUrl:item.url}).returning();await db.insert(xPostMappings).values({wallet,plankspacePostId:post.id,xPostId:item.id,direction:"import",xPostUrl:item.url,idempotencyKey:`import:${item.id}`});imported++}catch{}}await db.update(xAccounts).set({syncCursor:result.cursor,updatedAt:new Date().toISOString()}).where(eq(xAccounts.wallet,wallet));return Response.json({imported,cursor:result.cursor})}
