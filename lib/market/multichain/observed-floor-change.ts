import { postgresQuery } from "@/lib/postgres";
import type { FloorChangeObservation } from "./store";

export type FloorSubject = { chainSlug: string; collectionKey: string; marketplace: string | null; currency: string | null; currentPriceAtomic: string | null };
export const floorSubjectKey = (subject: Pick<FloorSubject, "chainSlug" | "collectionKey">) => JSON.stringify([subject.chainSlug, subject.collectionKey]);

/** Compare like-for-like executable floors, never average sale prices.
 * One indexed batch covers the visible page. Both endpoints must be recent,
 * same venue/currency, and the current observation must match the displayed ask. */
export async function observedFloorChanges24h(subjects: FloorSubject[]): Promise<Map<string, FloorChangeObservation>> {
  const targets = subjects.filter((subject) => subject.marketplace && subject.currency && subject.currentPriceAtomic && /^\d+$/.test(subject.currentPriceAtomic));
  if (!targets.length) return new Map();
  const result = await postgresQuery<{chain_slug:string;collection_key:string;current_price:string;comparison_price:string;current_at:string;comparison_at:string}>(
    `WITH subjects AS (
       SELECT * FROM jsonb_to_recordset($1::jsonb) AS s(chain_slug text, collection_key text, marketplace text, currency text, current_price text)
     ) SELECT s.chain_slug, s.collection_key, current_floor.price_atomic::text AS current_price,
         comparison.price_atomic::text AS comparison_price,
         current_floor.observed_at::text AS current_at, comparison.observed_at::text AS comparison_at
       FROM subjects s JOIN plank_multichain_collections c
         ON c.chain_slug=s.chain_slug AND c.contract_address=s.collection_key
       CROSS JOIN LATERAL (
         SELECT o.price_atomic, o.observed_at FROM plank_collection_floor_observations o
         WHERE o.collection_id=c.id AND o.marketplace=s.marketplace AND o.currency=s.currency
           AND o.observed_at <= NOW() AND o.observed_at >= NOW() - INTERVAL '2 hours'
         ORDER BY o.observed_at DESC LIMIT 1
       ) current_floor
       CROSS JOIN LATERAL (
         SELECT o.price_atomic, o.observed_at FROM plank_collection_floor_observations o
         WHERE o.collection_id=c.id AND o.marketplace=s.marketplace AND o.currency=s.currency
           AND o.observed_at <= current_floor.observed_at - INTERVAL '24 hours'
           AND o.observed_at >= current_floor.observed_at - INTERVAL '25 hours'
         ORDER BY o.observed_at DESC LIMIT 1
       ) comparison
       WHERE current_floor.price_atomic=s.current_price::numeric AND comparison.price_atomic>0`,
    [JSON.stringify(targets.map((subject) => ({chain_slug:subject.chainSlug,collection_key:subject.collectionKey,marketplace:subject.marketplace,currency:subject.currency,current_price:subject.currentPriceAtomic})))]
  );
  return new Map(result.rows.map((row) => [floorSubjectKey({chainSlug:row.chain_slug,collectionKey:row.collection_key}), {
    currentPriceAtomic:row.current_price, comparisonPriceAtomic:row.comparison_price,
    currentObservedAt:row.current_at, comparisonObservedAt:row.comparison_at,
    changePct:Number((BigInt(row.current_price)-BigInt(row.comparison_price))*1000000n/BigInt(row.comparison_price))/10000,
  }]));
}
