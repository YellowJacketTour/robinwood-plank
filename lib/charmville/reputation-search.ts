import { createHash } from "node:crypto";
import type { Pool } from "pg";
import { discoverReputation, projectReputation, type AcceptedReaction } from "./reputation";
import { ReputationSearchError, type PineSearch } from "./reputation-query";
export { parsePineSearch, ReputationSearchError, type PineSearch } from "./reputation-query";

export type PineResult = { id: string; handle: string; displayName: string; body: string; count: string };

/** Viewer eligibility and receipts share one database snapshot; no client-supplied content scope. */
export async function searchPineReputation(pool: Pool, search: PineSearch, token = "") {
  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    let wallet: string | null = null;
    if (token) {
      if (!/^[a-f0-9]{64}$/i.test(token)) throw new ReputationSearchError("Sign in again to apply your block list.", 401);
      const session = await client.query<{ wallet: string }>(`SELECT wallet FROM plankspace_wallet_sessions
        WHERE token_hash=$1 AND expires_at::timestamptz > clock_timestamp()`, [createHash("sha256").update(token).digest("hex")]);
      if (!session.rows[0]) throw new ReputationSearchError("Sign in again to apply your block list.", 401);
      wallet = session.rows[0].wallet;
    }
    const posts = await client.query<Omit<PineResult, "count">>(`SELECT p.id::text, a.handle, a.display_name AS "displayName", p.body
      FROM plankspace_posts p JOIN plankspace_profiles a ON lower(a.wallet)=lower(p.author_wallet)
      WHERE p.moderation_status='approved' AND a.moderation_status='approved'
      AND ($1::text='' OR strpos(lower(p.body || ' ' || a.handle || ' ' || a.display_name), lower($1)) > 0)
      AND ($2::text IS NULL OR NOT EXISTS (SELECT 1 FROM plankspace_profile_relations b
        WHERE b.kind='block' AND ((lower(b.owner_wallet)=lower($2) AND b.target_handle=a.handle)
          OR (lower(b.owner_wallet)=lower(a.wallet) AND b.target_handle IN
            (SELECT handle FROM plankspace_profiles WHERE lower(wallet)=lower($2))))))
      ORDER BY p.id DESC LIMIT 1001`, [search.q, wallet]);
    const scoped = posts.rows.slice(0, 1000), ids = scoped.map(p => p.id);
    const accepted = await client.query<AcceptedReaction>(`SELECT s.receipt_id::text AS "receiptId", s.post_id::text AS "contentId",
      r.actor_profile_id::text AS "profileId", s.face_id AS face, s.qty::text AS quantity, true AS active
      FROM charmville_stamps s JOIN charmville_receipts r ON r.id=s.receipt_id
      WHERE s.post_id=ANY($1::bigint[]) AND r.action='stamp'`, [ids]);
    const rows = discoverReputation(projectReputation(ids, accepted.rows), search.filter ?? { ...search, op: "gte", value: search.minimum }, [search]);
    const byId = new Map(scoped.map(p => [p.id, p]));
    const items: PineResult[] = rows.slice(0, 100).map(row => ({ ...byId.get(row.contentId)!, count: row.counts[search.face][search.basis][search.metric] }));
    await client.query("COMMIT");
    return { items, matched: rows.length, examined: scoped.length, scopeLimited: posts.rows.length > 1000, resultLimited: rows.length > 100, search };
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}
