import { eq } from "drizzle-orm";
import { getDb } from "../../db";
import { xAccounts } from "../../db/schema";
import { decryptXCredential } from "./crypto";
import type { XAccount } from "./provider";

export function publicXAccount(row:typeof xAccounts.$inferSelect){return{connected:true,username:row.xUsername,userId:row.xUserId,connectedAt:row.connectedAt,provider:process.env.PLANKSPACE_X_PROVIDER==="development"?"development":"live"}}
export async function loadXAccount(wallet:string):Promise<XAccount|null>{const [row]=await getDb().select().from(xAccounts).where(eq(xAccounts.wallet,wallet)).limit(1);if(!row)return null;if(process.env.PLANKSPACE_X_PROVIDER==="development")return{id:row.xUserId,username:row.xUsername,accessToken:`development-${row.xUsername}`};return{id:row.xUserId,username:row.xUsername,accessToken:decryptXCredential(row.accessTokenEncrypted),refreshToken:row.refreshTokenEncrypted?decryptXCredential(row.refreshTokenEncrypted):undefined,expiresAt:row.tokenExpiresAt||undefined}}
