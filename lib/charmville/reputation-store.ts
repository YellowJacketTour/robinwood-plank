import type { Pool } from "pg";
import { projectReputation, type AcceptedReaction } from "./reputation";

/**
 * Internal adapter, not an authorization endpoint. The caller supplies IDs from its
 * viewer-aware content query (including blocks). This adapter additionally rechecks
 * moderation. Never accept an arbitrary client's ID array as authorization.
 *
 * Existing stamps are append-only: current and lifetime genuinely coincide today.
 * There is no invented withdrawal history and no inventory-derived reputation.
 */
export async function readPineReputation(pool: Pool, authorizedPostIds: readonly string[]) {
  if (authorizedPostIds.length > 1000 || authorizedPostIds.some(id => !/^[1-9]\d{0,17}$/.test(id))) throw new Error("Invalid authorized pine scope");
  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const posts = await client.query<{ id: string }>(`SELECT p.id::text FROM plankspace_posts p
      WHERE p.id=ANY($1::bigint[]) AND p.moderation_status='approved'
      AND EXISTS (SELECT 1 FROM plankspace_profiles author
        WHERE lower(author.wallet)=lower(p.author_wallet) AND author.moderation_status='approved')`, [[...new Set(authorizedPostIds)]]);
    const eligible = posts.rows.map(row => row.id);
    const accepted = await client.query<AcceptedReaction>(`SELECT s.receipt_id::text AS "receiptId",
      s.post_id::text AS "contentId", r.actor_profile_id::text AS "profileId",
      s.face_id AS face, s.qty::text AS quantity, true AS active
      FROM charmville_stamps s JOIN charmville_receipts r ON r.id=s.receipt_id
      WHERE s.post_id=ANY($1::bigint[]) AND r.action='stamp'`, [eligible]);
    const rows = projectReputation(eligible, accepted.rows);
    await client.query("COMMIT");
    return {
      rows,
      coverage: { content: "pines", source: "accepted-stamp-receipts", removals: "not-implemented", paging: "materialize-this-result" } as const,
    };
  } catch (error) {
    await client.query("ROLLBACK"); throw error;
  } finally { client.release(); }
}
