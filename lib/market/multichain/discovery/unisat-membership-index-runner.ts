/** Durable UniSat collection membership enumeration.
 *
 * This lane establishes the complete item roster exposed by UniSat. Trait
 * absence remains absence: activity-derived traits are enriched by the
 * separate rarity lane and are never fabricated here.
 */
import { postgresQuery } from "@/lib/postgres";
import { reserveProviderCapacity, settleProviderCapacity, utcDayWindow } from "@/lib/market/multichain/control-plane";
import { isSourceJailed } from "@/lib/market/multichain/mesh/jail";
import {
  readCollectionMembershipCursor,
  upsertCollectionTokenProjection,
  writeCollectionMembershipCursor,
} from "@/lib/market/multichain/collection-token-store";

const PAGE_SIZE = 100;
const SOURCE = "unisat-collection-items";

type UniSatItem = {
  inscriptionId?: string;
  name?: string | null;
  collectionItemName?: string | null;
  attributes?: Array<{ trait_type?: string; value?: string | number | null }> | null;
};

function apiKey(): string {
  const key = process.env.UNISAT_API_KEY?.trim();
  if (!key) throw new Error("unisat-membership: UNISAT_API_KEY is not configured");
  return key;
}

async function fetchPage(collectionId: string, start: number): Promise<{ items: UniSatItem[]; total: number | null }> {
  if (await isSourceJailed("unisat")) throw new Error("unisat-membership: source jailed");
  const window = utcDayWindow(900);
  if (!(await reserveProviderCapacity("unisat:default", window))) {
    throw new Error("unisat-membership: durable daily ceiling");
  }
  try {
    const response = await fetch(
      `https://open-api.unisat.io/v1/collection-indexer/collection/${encodeURIComponent(collectionId)}/items?start=${start}&limit=${PAGE_SIZE}`,
      { headers: { authorization: `Bearer ${apiKey()}` }, signal: AbortSignal.timeout(15_000) }
    );
    if (!response.ok) throw new Error(`unisat-membership: HTTP ${response.status}`);
    const body = await response.json() as {
      code?: number; msg?: string;
      data?: { list?: UniSatItem[]; items?: UniSatItem[]; total?: number };
    };
    if (body.code !== 0) throw new Error(`unisat-membership: API ${body.code} ${body.msg ?? ""}`);
    return { items: body.data?.list ?? body.data?.items ?? [], total: body.data?.total ?? null };
  } finally {
    await settleProviderCapacity("unisat:default", window, 1, true).catch(() => {});
  }
}

export async function advanceBitcoinCollectionMembership(collectionId: string) {
  const checkpoint = await readCollectionMembershipCursor("bitcoin-mainnet", collectionId, SOURCE);
  const start = Math.max(0, Number.parseInt(checkpoint?.cursor ?? "0", 10) || 0);
  const observedAt = new Date();
  try {
    const page = await fetchPage(collectionId, start);
    const expected = page.total ?? checkpoint?.expectedCount ?? null;
    const next = start + page.items.length;
    const complete = page.items.length < PAGE_SIZE || (expected !== null && next >= expected);
    await upsertCollectionTokenProjection("bitcoin-mainnet", collectionId, {
      tokens: page.items.flatMap((item) => item.inscriptionId ? [{
        tokenId: item.inscriptionId,
        name: item.collectionItemName ?? item.name ?? null,
        imageUrl: `https://ordinals.com/content/${item.inscriptionId}`,
        traits: (item.attributes ?? []).flatMap((trait) =>
          trait.trait_type && trait.value != null
            ? [{ traitType: trait.trait_type, value: String(trait.value) }]
            : []),
      }] : []),
      expectedCount: expected,
      partial: !complete,
      provenance: [SOURCE, "ordinals-inscription-content"],
      sourceObservedAt: observedAt,
    });
    await writeCollectionMembershipCursor({
      chainSlug: "bitcoin-mainnet", collectionSlug: collectionId, source: SOURCE,
      cursor: complete ? null : String(next), expectedCount: expected, complete,
      sourceObservedAt: observedAt,
    });
    return { collectionId, itemsObserved: page.items.length, nextStart: next, expectedCount: expected, complete };
  } catch (error) {
    await writeCollectionMembershipCursor({
      chainSlug: "bitcoin-mainnet", collectionSlug: collectionId, source: SOURCE,
      cursor: String(start), expectedCount: checkpoint?.expectedCount, complete: false,
      lastError: error instanceof Error ? error.message : String(error),
    }).catch(() => {});
    throw error;
  }
}

export async function advanceNextTrackedBitcoinMembership() {
  const candidates = await postgresQuery<{ contract_address: string }>(
    `SELECT c.contract_address
     FROM plank_multichain_collections c
     LEFT JOIN plank_collection_membership_cursors m
       ON m.chain_slug = c.chain_slug AND lower(m.collection_slug) = lower(c.contract_address) AND m.source = $1
     WHERE c.chain_slug = 'bitcoin-mainnet'
     ORDER BY (m.complete IS NOT TRUE) DESC, m.updated_at ASC NULLS FIRST, c.id
     LIMIT 1`, [SOURCE]);
  const collectionId = candidates.rows[0]?.contract_address;
  if (!collectionId) return null;
  return advanceBitcoinCollectionMembership(collectionId);
}
