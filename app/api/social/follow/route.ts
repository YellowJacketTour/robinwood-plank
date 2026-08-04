import {
  followEntity,
  getFollowedEntities,
  unfollowEntity,
  type FollowTarget,
} from "@/lib/social-follows";
import { TradeApiError } from "@/lib/uniswap-server";
import { publicError, publicJson, rateLimit, readJsonBody } from "@/lib/security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const HEX_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

type FollowBody = {
  followerWallet?: unknown;
  targetType?: unknown;
  targetId?: unknown;
  action?: unknown;
};

function parseTarget(targetType: unknown, targetId: unknown): FollowTarget {
  const id = typeof targetId === "string" ? targetId.trim() : "";
  if (!id) throw new TradeApiError(400, "BAD_TARGET", "targetId required.");
  if (targetType === "wallet") return { kind: "wallet", wallet: id };
  if (targetType === "collection") return { kind: "collection", collection: id };
  throw new TradeApiError(400, "BAD_TARGET_TYPE", "targetType must be 'wallet' or 'collection'.");
}

/**
 * Follow / unfollow a wallet or collection — wired to lib/social-follows.ts
 * (migration 006_social_curation.sql). No wallet-proof signature here:
 * following is not a claim about anyone else's data and carries no weight
 * in any scoring formula (unlike an endorsement), so it takes the same
 * lower-friction posture as lib/boards/ping — the wallet address is
 * self-asserted, matching how the client's own connected-wallet state feeds
 * every other read-only personalization in this app.
 */
export async function POST(req: Request) {
  try {
    const limited = rateLimit(req, { key: "social-follow", limit: 60, windowMs: 60_000 });
    if (limited) return limited;

    const body = await readJsonBody<FollowBody>(req);
    const followerWallet =
      typeof body.followerWallet === "string" ? body.followerWallet.trim() : "";
    if (!HEX_ADDRESS.test(followerWallet)) {
      throw new TradeApiError(400, "BAD_FOLLOWER", "Valid follower wallet address required.");
    }
    const target = parseTarget(body.targetType, body.targetId);
    const action = body.action === "unfollow" ? "unfollow" : "follow";

    const result =
      action === "unfollow"
        ? await unfollowEntity(followerWallet, target)
        : await followEntity(followerWallet, target);

    if (!result.ok) {
      throw new TradeApiError(400, result.error, "Follow request rejected.");
    }

    return publicJson({ ok: true, action });
  } catch (err) {
    return publicError(err, "Failed to update follow state.");
  }
}

/** `?wallet=0x...` — what a wallet currently follows, for the watchlist UI. */
export async function GET(req: Request) {
  try {
    const limited = rateLimit(req, { key: "social-follow-get", limit: 60, windowMs: 60_000 });
    if (limited) return limited;

    const url = new URL(req.url);
    const wallet = (url.searchParams.get("wallet") || "").trim();
    if (!HEX_ADDRESS.test(wallet)) {
      throw new TradeApiError(400, "BAD_FOLLOWER", "Valid wallet address required.");
    }
    const followed = await getFollowedEntities(wallet);
    return publicJson({ ok: true, followed });
  } catch (err) {
    return publicError(err, "Failed to load follow state.");
  }
}
