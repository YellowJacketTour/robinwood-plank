import { eq } from "drizzle-orm";
import { getDb } from "../../../../db";
import { profiles, xAccounts } from "../../../../db/schema";
import { isUsableXAccountRecord, publicXAccount } from "../../../x/account";
import { evaluateXImportWindow, evaluateXPostCooldown } from "../../../x/policy";
import { getXPostCooldownMinutes } from "../../../x/settings";

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const handle = (params.get("handle") || "").toLowerCase();
  const wallet = (params.get("wallet") || "").toLowerCase();
  const db = getDb();
  const provider = process.env.PLANKSPACE_X_PROVIDER === "development" ? "development" : "live";
  let account;
  if (handle) [account] = await db.select().from(xAccounts).where(eq(xAccounts.profileHandle, handle)).limit(1);
  else if (wallet) [account] = await db.select().from(xAccounts).where(eq(xAccounts.wallet, wallet)).limit(1);
  if (!account) return Response.json({ connected: false, provider });

  const [profile] = await db.select({ handle: profiles.handle }).from(profiles).where(eq(profiles.wallet, account.wallet)).limit(1);
  const resolvedHandle = profile?.handle || account.profileHandle;
  if (!isUsableXAccountRecord(account, provider)) {
    return Response.json({ connected: false, needsReconnect: true, provider, username: account.xUsername, handle: resolvedHandle });
  }

  const cooldownMinutes = await getXPostCooldownMinutes();
  return Response.json({
    ...publicXAccount(account),
    handle: resolvedHandle,
    cooldownMinutes,
    postCooldown: evaluateXPostCooldown({ lastPublishedAt: account.lastPublishedAt, cooldownMinutes, profileHandle: resolvedHandle }),
    importWindow: evaluateXImportWindow({ lastImportedAt: account.lastImportedAt }),
  });
}
