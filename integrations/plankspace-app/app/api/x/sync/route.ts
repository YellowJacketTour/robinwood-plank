import { and, eq, isNull, lte, or } from "drizzle-orm";
import { getDb } from "../../../../db";
import { posts, profiles, xAccounts, xPostMappings } from "../../../../db/schema";
import { loadXAccount } from "../../../x/account";
import { evaluateXImportWindow, newestTwentyXPosts, X_IMPORT_WINDOW_MS } from "../../../x/policy";
import { getXProvider } from "../../../x/provider";
import { hashJson } from "../../auth/hash";
import { type Proof, verifyAndConsumeProof } from "../../auth/verify";

export async function POST(request: Request) {
  try {
    const payload = await request.json() as Proof & { handle?: string };
    const handle = String(payload.handle || "").toLowerCase();
    const wallet = await verifyAndConsumeProof(payload, "x:sync", handle, await hashJson({ handle }));
    if (!wallet) return Response.json({ error: "Signed owner proof required" }, { status: 403 });

    const db = getDb();
    const account = await loadXAccount(wallet);
    if (!account) return Response.json({ error: "Reconnect X before importing posts", needsReconnect: true }, { status: 409 });
    const [row] = await db.select().from(xAccounts).where(eq(xAccounts.wallet, wallet)).limit(1);
    if (!row) return Response.json({ error: "Reconnect X before importing posts", needsReconnect: true }, { status: 409 });

    const decision = evaluateXImportWindow({ lastImportedAt: row.lastImportedAt });
    if (!decision.allowed) {
      return Response.json({ error: "X posts can be imported once every 24 hours.", retryAfterSeconds: decision.retryAfterSeconds }, { status: 429 });
    }

    const reservedAt = new Date().toISOString();
    const cutoff = new Date(Date.now() - X_IMPORT_WINDOW_MS).toISOString();
    const reserved = await db.update(xAccounts)
      .set({ lastImportedAt: reservedAt, updatedAt: reservedAt })
      .where(and(eq(xAccounts.wallet, wallet), or(isNull(xAccounts.lastImportedAt), lte(xAccounts.lastImportedAt, cutoff))))
      .returning({ wallet: xAccounts.wallet });
    if (reserved.length !== 1) return Response.json({ error: "X posts can be imported once every 24 hours." }, { status: 429 });

    try {
      const [profile] = await db.select({ displayName: profiles.displayName }).from(profiles).where(eq(profiles.wallet, wallet)).limit(1);
      const result = await getXProvider().listRecentPosts(account, row.syncCursor || "");
      let imported = 0;
      for (const item of newestTwentyXPosts(result.posts)) {
        try {
          const [post] = await db.insert(posts).values({ author: profile?.displayName || account.username, authorWallet: wallet, body: item.text.slice(0, 500), source: "x", externalPostId: item.id, xPostUrl: item.url }).returning();
          await db.insert(xPostMappings).values({ wallet, plankspacePostId: post.id, xPostId: item.id, direction: "import", xPostUrl: item.url, idempotencyKey: `import:${item.id}` });
          imported++;
        } catch { /* duplicate post */ }
      }
      const nextImportAt = new Date(Date.parse(reservedAt) + X_IMPORT_WINDOW_MS).toISOString();
      await db.update(xAccounts).set({ syncCursor: result.cursor, updatedAt: new Date().toISOString() }).where(eq(xAccounts.wallet, wallet));
      return Response.json({ imported, cursor: result.cursor, nextImportAt });
    } catch (error) {
      await db.update(xAccounts)
        .set({ lastImportedAt: row.lastImportedAt, updatedAt: new Date().toISOString() })
        .where(and(eq(xAccounts.wallet, wallet), eq(xAccounts.lastImportedAt, reservedAt)));
      throw error;
    }
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "X import failed" }, { status: 502 });
  }
}
