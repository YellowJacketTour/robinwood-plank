import { postgresQuery } from "@/lib/postgres";
import type { PointCategory } from "@/lib/plank-checks";

/**
 * Follow / watchlist layer — a wallet follows another wallet OR a
 * collection (never both in the same row, see migration 006). The feed is a
 * pure read over the existing plank_checks_events ledger (migration 005),
 * filtered to whatever the caller currently follows — never a forked or
 * separately maintained copy of that history, so it can never drift from
 * it. See lib/plank-checks.ts for the ledger this reads.
 */

const HEX_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

function normalizeAddress(addr: string): string {
  return addr.trim().toLowerCase();
}

/**
 * Collection identifiers are free text (a contract address today, possibly
 * a slug later) — validated only for shape (non-empty, bounded length), the
 * same posture lib/plank-checks.ts's metadata field already takes.
 */
function isValidCollectionId(collection: string): boolean {
  const trimmed = collection.trim();
  return trimmed.length > 0 && trimmed.length <= 128;
}

export type FollowTarget =
  | { kind: "wallet"; wallet: string }
  | { kind: "collection"; collection: string };

export type FollowResult = { ok: true } | { ok: false; error: "BAD_FOLLOWER" | "BAD_TARGET" };

export async function followEntity(
  followerWallet: string,
  target: FollowTarget
): Promise<FollowResult> {
  const follower = normalizeAddress(followerWallet);
  if (!HEX_ADDRESS.test(follower)) return { ok: false, error: "BAD_FOLLOWER" };

  if (target.kind === "wallet") {
    const followed = normalizeAddress(target.wallet);
    if (!HEX_ADDRESS.test(followed) || followed === follower) {
      return { ok: false, error: "BAD_TARGET" };
    }
    await postgresQuery(
      `INSERT INTO social_follows (follower_wallet, followed_wallet)
       VALUES ($1, $2)
       ON CONFLICT (follower_wallet, followed_wallet) WHERE followed_wallet IS NOT NULL
       DO NOTHING`,
      [follower, followed]
    );
    return { ok: true };
  }

  const collection = target.collection.trim();
  if (!isValidCollectionId(collection)) return { ok: false, error: "BAD_TARGET" };
  await postgresQuery(
    `INSERT INTO social_follows (follower_wallet, followed_collection)
     VALUES ($1, $2)
     ON CONFLICT (follower_wallet, followed_collection) WHERE followed_collection IS NOT NULL
     DO NOTHING`,
    [follower, collection]
  );
  return { ok: true };
}

export async function unfollowEntity(
  followerWallet: string,
  target: FollowTarget
): Promise<FollowResult> {
  const follower = normalizeAddress(followerWallet);
  if (!HEX_ADDRESS.test(follower)) return { ok: false, error: "BAD_FOLLOWER" };

  if (target.kind === "wallet") {
    const followed = normalizeAddress(target.wallet);
    if (!HEX_ADDRESS.test(followed)) return { ok: false, error: "BAD_TARGET" };
    await postgresQuery(
      `DELETE FROM social_follows WHERE follower_wallet = $1 AND followed_wallet = $2`,
      [follower, followed]
    );
    return { ok: true };
  }

  const collection = target.collection.trim();
  if (!isValidCollectionId(collection)) return { ok: false, error: "BAD_TARGET" };
  await postgresQuery(
    `DELETE FROM social_follows WHERE follower_wallet = $1 AND followed_collection = $2`,
    [follower, collection]
  );
  return { ok: true };
}

export type FollowedEntities = {
  wallets: string[];
  collections: string[];
};

export async function getFollowedEntities(followerWallet: string): Promise<FollowedEntities> {
  const follower = normalizeAddress(followerWallet);
  if (!HEX_ADDRESS.test(follower)) return { wallets: [], collections: [] };
  const result = await postgresQuery<{
    followed_wallet: string | null;
    followed_collection: string | null;
  }>(
    `SELECT followed_wallet, followed_collection FROM social_follows WHERE follower_wallet = $1`,
    [follower]
  );
  const wallets: string[] = [];
  const collections: string[] = [];
  for (const row of result.rows) {
    if (row.followed_wallet) wallets.push(row.followed_wallet);
    if (row.followed_collection) collections.push(row.followed_collection);
  }
  return { wallets, collections };
}

export type FeedItem = {
  wallet: string;
  category: PointCategory;
  points: number;
  sourceTxHash: string | null;
  earnedAt: string;
  metadata: Record<string, unknown>;
};

/**
 * Newest-first feed of activity from everything `followerWallet` follows.
 * A followed wallet's own events always qualify; a followed collection
 * qualifies an event when its metadata carries a matching `collection` key
 * (see migration 006's comment — an opt-in JSONB convention, not a new
 * ledger column). Returns an empty feed rather than erroring when the
 * caller follows nothing, since "no activity yet" is a normal empty state,
 * not a failure.
 */
export async function getFollowedActivityFeed(
  followerWallet: string,
  opts?: { limit?: number }
): Promise<FeedItem[]> {
  const { wallets, collections } = await getFollowedEntities(followerWallet);
  if (wallets.length === 0 && collections.length === 0) return [];

  const limit = Math.max(1, Math.min(opts?.limit ?? 50, 200));
  const params: unknown[] = [];
  const clauses: string[] = [];

  if (wallets.length > 0) {
    params.push(wallets);
    clauses.push(`wallet_address = ANY($${params.length}::text[])`);
  }
  if (collections.length > 0) {
    params.push(collections);
    clauses.push(`metadata->>'collection' = ANY($${params.length}::text[])`);
  }
  params.push(limit);

  const result = await postgresQuery<{
    wallet_address: string;
    category: PointCategory;
    points: string;
    source_tx_hash: string | null;
    earned_at: string;
    metadata: Record<string, unknown>;
  }>(
    `SELECT wallet_address, category, points, source_tx_hash, earned_at, metadata
     FROM plank_checks_events
     WHERE ${clauses.join(" OR ")}
     ORDER BY earned_at DESC
     LIMIT $${params.length}`,
    params
  );

  return result.rows.map((row) => ({
    wallet: row.wallet_address,
    category: row.category,
    points: Number(row.points),
    sourceTxHash: row.source_tx_hash,
    earnedAt: row.earned_at,
    metadata: row.metadata ?? {},
  }));
}
