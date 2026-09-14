import { postgresQuery } from "@/lib/postgres";
import type { FloorChangeObservation } from "./store";

export type FloorSubject = { chainSlug: string; collectionKey: string; marketplace: string | null; currency: string | null; currentPriceAtomic: string | null };
export const floorSubjectKey = (subject: Pick<FloorSubject, "chainSlug" | "collectionKey">) => JSON.stringify([subject.chainSlug, subject.collectionKey]);

/**
 * The 24h floor change for a page of collections, closing INSTANTLY.
 *
 * The current endpoint is the floor the row displays (the snapshot's own
 * floor, venue and currency) -- every floor write now records that exact
 * value as an observation in the same statement (writeSnapshot,
 * updateCollectionFloorOnly), so the displayed floor IS the latest
 * observation by construction and no equality check against a recent row is
 * needed. The comparison endpoint is the latest observation of the same
 * venue and currency at least 24 hours old.
 *
 * When no observation is that old yet, the comparison is the EARLIEST
 * observation of that venue/currency and the result says so: basis
 * "first-observation" with its timestamp. A collection tracked for three
 * hours shows its real change over those three hours, labelled as such,
 * from the moment its second observation lands -- not a hole that says
 * "collecting" for a day. The two bases are never conflated: "24h" means two
 * endpoints at least 24 hours apart; "first-observation" means the whole
 * history is younger than that.
 *
 * Before 2026-09-14 the comparison window was [24h, 25h] and the current
 * endpoint had to equal an observation from the last 2 hours. With most
 * floors written by writeSnapshot -- which recorded no observation at all --
 * that could never match, and every row on the hub said "collecting
 * baseline" indefinitely. Migration 150 seeds one observation per stored
 * floor so the whole catalog closes on deploy rather than a day later.
 *
 * One query for the page: one lateral probe per subject on
 * (collection_id, observed_at DESC), no scans.
 */
export async function observedFloorChanges24h(subjects: FloorSubject[]): Promise<Map<string, FloorChangeObservation>> {
  const targets = subjects.filter((subject) => subject.marketplace && subject.currency && subject.currentPriceAtomic && /^[1-9]\d*$/.test(subject.currentPriceAtomic));
  if (!targets.length) return new Map();
  const result = await postgresQuery<{chain_slug:string;collection_key:string;current_price:string;comparison_price:string;comparison_at:string;basis:"24h"|"first-observation"}>(
    `WITH subjects AS (
       SELECT * FROM jsonb_to_recordset($1::jsonb) AS s(chain_slug text, collection_key text, marketplace text, currency text, current_price text)
     ) SELECT s.chain_slug, s.collection_key, s.current_price,
         comparison.price_atomic::text AS comparison_price,
         comparison.observed_at::text AS comparison_at,
         comparison.basis
       FROM subjects s JOIN plank_multichain_collections c
         ON c.chain_slug=s.chain_slug AND c.contract_address=s.collection_key
       LEFT JOIN LATERAL (
         SELECT o.price_atomic, o.observed_at, '24h'::text AS basis
           FROM plank_collection_floor_observations o
          WHERE o.collection_id=c.id AND o.marketplace=s.marketplace AND o.currency=s.currency
            AND o.observed_at <= NOW() - INTERVAL '24 hours'
          ORDER BY o.observed_at DESC LIMIT 1
       ) day_old ON TRUE
       LEFT JOIN LATERAL (
         SELECT o.price_atomic, o.observed_at, 'first-observation'::text AS basis
           FROM plank_collection_floor_observations o
          WHERE o.collection_id=c.id AND o.marketplace=s.marketplace AND o.currency=s.currency
            AND o.observed_at <= NOW()
          ORDER BY o.observed_at ASC LIMIT 1
       ) first_seen ON TRUE
       CROSS JOIN LATERAL (
         SELECT * FROM (SELECT day_old.price_atomic, day_old.observed_at, day_old.basis
                        UNION ALL
                        SELECT first_seen.price_atomic, first_seen.observed_at, first_seen.basis) both_bases
          WHERE price_atomic IS NOT NULL
          ORDER BY CASE basis WHEN '24h' THEN 0 ELSE 1 END LIMIT 1
       ) comparison
       WHERE comparison.price_atomic > 0`,
    [JSON.stringify(targets.map((subject) => ({chain_slug:subject.chainSlug,collection_key:subject.collectionKey,marketplace:subject.marketplace,currency:subject.currency,current_price:subject.currentPriceAtomic})))]
  );
  return new Map(result.rows.map((row) => [floorSubjectKey({chainSlug:row.chain_slug,collectionKey:row.collection_key}), {
    currentPriceAtomic:row.current_price, comparisonPriceAtomic:row.comparison_price,
    currentObservedAt:new Date().toISOString(), comparisonObservedAt:row.comparison_at,
    changePct:Number((BigInt(row.current_price)-BigInt(row.comparison_price))*1000000n/BigInt(row.comparison_price))/10000,
    basis:row.basis,
  }]));
}
