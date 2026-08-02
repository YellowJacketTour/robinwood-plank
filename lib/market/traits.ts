import type { Listing, MarketCollection } from "@/lib/market/types";

/**
 * Client access to the server's verified trait index, plus the pure
 * floor-by-trait computation ("instant visibility to floor priced NFTs",
 * scoped to a trait).
 */

export type TraitIndexResponse = {
  collection: string;
  complete: boolean;
  building: boolean;
  totalSupply: number | null;
  scanned: number;
  /** traitType → value → token-id list; null until the scan completes. */
  traits: Record<string, Record<string, string[]>> | null;
  /** Token id → verified collection rank; null if rarity data is unavailable. */
  rankings: Record<string, number> | null;
};

export async function fetchTraitIndex(
  collection: MarketCollection
): Promise<TraitIndexResponse> {
  const res = await fetch(`/api/market/traits?collection=${encodeURIComponent(collection.slug)}`);
  const data = (await res.json()) as TraitIndexResponse & { message?: string };
  if (!res.ok) throw new Error(data.message || "Could not load trait index.");
  return data;
}

export function getTokenIdsForTrait(
  index: TraitIndexResponse,
  traitType: string,
  value: string
): string[] {
  return index.traits?.[traitType]?.[value] ?? [];
}

/**
 * Floor price (wei, as string) among live listings whose tokenId is in the
 * trait's set — null when nothing matching is listed. Pure; unit-tested.
 */
export function traitFloorWei(
  listings: readonly Pick<Listing, "tokenId" | "priceWei">[],
  tokenIds: readonly string[]
): string | null {
  const set = new Set(tokenIds.map((id) => BigInt(id).toString()));
  let floor: bigint | null = null;
  for (const l of listings) {
    if (!l.tokenId || !set.has(BigInt(l.tokenId).toString())) continue;
    const p = BigInt(l.priceWei);
    if (floor === null || p < floor) floor = p;
  }
  return floor === null ? null : floor.toString();
}
