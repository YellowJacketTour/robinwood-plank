import { and, desc, eq, isNull, lte, or, sql } from "drizzle-orm";
import { getDb } from "../../../db";
import { notifications, postLikes, posts, profiles, xAccounts, xPostMappings } from "../../../db/schema";
import { normalizePostMedia } from "../../post-media";
import { hashJson } from "../auth/hash";
import { type Proof, verifyAndConsumeProof } from "../auth/verify";
import { loadXAccount } from "../../x/account";
import { getXProvider } from "../../x/provider";
import { evaluateXPostCooldown, isDegenXCooldownExempt } from "../../x/policy";
import { getXPostCooldownMinutes } from "../../x/settings";

export async function GET() {
  try {
    return Response.json({
      posts: await getDb()
        .select()
        .from(posts)
        .where(eq(posts.moderationStatus, "approved"))
        .orderBy(desc(posts.id))
        .limit(30),
    });
  } catch {
    return Response.json({ posts: [] }, { status: 503 });
  }
}

export async function POST(request: Request) {
  const p = (await request.json()) as Proof & {
      body?: string;
      mediaUrl?: string;
      mediaType?: string;
      mediaAlt?: string;
      alsoPostToX?: boolean;
    },
    body = (p.body || "").trim();
  if (!body || body.length > 500)
    return Response.json(
      { error: "Post must be 1–500 characters" },
      { status: 400 }
    );
  let media;
  try {
    media = normalizePostMedia(p);
  } catch (e) {
    return Response.json(
      { error: e instanceof Error ? e.message : "Invalid media attachment" },
      { status: 400 }
    );
  }
  const data = {
      body,
      mediaUrl: media.mediaUrl,
      mediaType: media.mediaType,
      mediaAlt: media.mediaAlt,
      alsoPostToX: p.alsoPostToX === true,
    },
    hash = await hashJson(data),
    wallet = await verifyAndConsumeProof(p, "post:create", "lumberyard", hash);
  if (!wallet)
    return Response.json(
      { error: "Connect and sign this post" },
      { status: 403 }
    );
  const db = getDb(),
    [a] = await db
      .select({ displayName: profiles.displayName, handle: profiles.handle })
      .from(profiles)
      .where(eq(profiles.wallet, wallet))
      .limit(1),
    [recent] = await db
      .select({ createdAt: posts.createdAt })
      .from(posts)
      .where(eq(posts.authorWallet, wallet))
      .orderBy(desc(posts.id))
      .limit(1);
  if (!a)
    return Response.json(
      { error: "Create a profile before posting" },
      { status: 403 }
    );
  if (recent && Date.now() - Date.parse(recent.createdAt) < 15000)
    return Response.json(
      { error: "Wait a few seconds before posting again" },
      { status: 429 }
    );
  let [post] = await db
    .insert(posts)
    .values({ author: a.displayName, authorWallet: wallet, body, ...media, xPublishStatus:data.alsoPostToX?"pending":"not-requested" })
    .returning();
  let xShare: { status: string; retryAfterSeconds?: number } | undefined;
  if (data.alsoPostToX) {
    const account = await loadXAccount(wallet);
    const [xRow] = await db.select().from(xAccounts).where(eq(xAccounts.wallet, wallet)).limit(1);
    if (!account || !xRow) {
      post = (await db.update(posts).set({ xPublishStatus: "failed" }).where(eq(posts.id, post.id)).returning())[0];
      xShare = { status: "reconnect-required" };
    } else {
      const cooldownMinutes = await getXPostCooldownMinutes();
      const decision = evaluateXPostCooldown({
        lastPublishedAt: xRow.lastPublishedAt,
        cooldownMinutes,
        profileHandle: a.handle,
      });
      let reserved = decision.allowed;
      const reservedAt = new Date().toISOString();
      if (reserved && !isDegenXCooldownExempt(a.handle) && cooldownMinutes > 0) {
        const cutoff = new Date(Date.now() - cooldownMinutes * 60_000).toISOString();
        const rows = await db.update(xAccounts)
          .set({ lastPublishedAt: reservedAt, updatedAt: reservedAt })
          .where(and(eq(xAccounts.wallet, wallet), or(isNull(xAccounts.lastPublishedAt), lte(xAccounts.lastPublishedAt, cutoff))))
          .returning({ wallet: xAccounts.wallet });
        reserved = rows.length === 1;
      }
      if (!reserved) {
        const retry = evaluateXPostCooldown({
          lastPublishedAt: xRow.lastPublishedAt,
          cooldownMinutes,
          profileHandle: a.handle,
        });
        post = (await db.update(posts).set({ xPublishStatus: "failed" }).where(eq(posts.id, post.id)).returning())[0];
        xShare = { status: "cooldown", retryAfterSeconds: Math.max(1, retry.retryAfterSeconds) };
      } else {
        try {
          const published = await getXProvider().createPost(account, body, `post-${post.id}`);
          await db.insert(xPostMappings).values({ wallet, plankspacePostId: post.id, xPostId: published.id, direction: "publish", xPostUrl: published.url, idempotencyKey: `post-${post.id}` });
          if (isDegenXCooldownExempt(a.handle) || cooldownMinutes === 0) {
            await db.update(xAccounts).set({ lastPublishedAt: reservedAt, updatedAt: reservedAt }).where(eq(xAccounts.wallet, wallet));
          }
          post = (await db.update(posts).set({ xPublishStatus: "published", externalPostId: published.id, xPostUrl: published.url }).where(eq(posts.id, post.id)).returning())[0];
          xShare = { status: "published" };
        } catch {
          if (!isDegenXCooldownExempt(a.handle) && cooldownMinutes > 0) {
            await db.update(xAccounts).set({ lastPublishedAt: xRow.lastPublishedAt, updatedAt: new Date().toISOString() }).where(and(eq(xAccounts.wallet, wallet), eq(xAccounts.lastPublishedAt, reservedAt)));
          }
          post = (await db.update(posts).set({ xPublishStatus: "failed" }).where(eq(posts.id, post.id)).returning())[0];
          xShare = { status: "failed" };
        }
      }
    }
  }
  return Response.json({ post, xShare }, { status: 201 });
}

export async function PATCH(request: Request) {
  const p = (await request.json()) as Proof & { id?: number };
  if (!Number.isInteger(p.id))
    return Response.json({ error: "Valid post required" }, { status: 400 });
  const hash = await hashJson({ id: p.id }),
    wallet = await verifyAndConsumeProof(p, "post:like", String(p.id), hash);
  if (!wallet)
    return Response.json(
      { error: "Sign in to like this board" },
      { status: 403 }
    );
  const db = getDb(),
    [target] = await db
      .select()
      .from(posts)
      .where(eq(posts.id, p.id!))
      .limit(1);
  if (!target || target.moderationStatus !== "approved")
    return Response.json({ error: "Post not found" }, { status: 404 });
  try {
    await db.insert(postLikes).values({ postId: p.id!, wallet });
  } catch {
    return Response.json(
      { error: "You already liked this board" },
      { status: 409 }
    );
  }
  const [post] = await db
    .update(posts)
    .set({ likes: sql`${posts.likes} + 1` })
    .where(eq(posts.id, p.id!))
    .returning();
  if (post && target.authorWallet !== wallet) {
    const [actor] = await db
      .select({ handle: profiles.handle })
      .from(profiles)
      .where(eq(profiles.wallet, wallet))
      .limit(1);
    await db
      .insert(notifications)
      .values({
        recipientWallet: target.authorWallet,
        actorWallet: wallet,
        actorHandle: actor?.handle || "",
        kind: "like",
        body: `@${actor?.handle || "a board"} liked your post.`,
        href: "/",
      });
  }
  return Response.json({ post });
}
