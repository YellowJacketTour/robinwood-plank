/**
 * Universal rarity (2026-09-05) -- one pipeline that adapts by collection
 * type, with `partial` honesty until the sample equals the real supply.
 * docs/marketplank/FABLE-ONESHOT-marketplank-all-chains-peak-2026-09-05.md §4D.
 *
 * lib/rarity.ts stays canonical for RobinWood; lib/rarity-generic.ts stays
 * the -log2 information-content kernel over any trait set. This module
 * decides HOW that kernel applies (editions vs generative vs 1/1s vs large
 * registries vs ordinals), adds per-trait frequency, floors by tier and
 * "rarer than X%", and never reports complete coverage without a real
 * supply to compare against. Pure; unit-tested in
 * test/market/rarity-universal.test.ts.
 */
import { TIER_ORDER, type RarityTier } from "@/lib/rarity";
import {
  computeGenericRaritySnapshot,
  scoredTraitTypes,
  type GenericRarityInput,
  type GenericRaritySnapshot,
  type GenericTokenRarity,
} from "@/lib/rarity-generic";

export type CollectionType =
  | "one-of-ones"
  | "editions"
  | "open-edition"
  | "generative"
  | "large-registry"
  | "ordinals"
  | "unknown";

export type CollectionTypeSignals = {
  sampleSize: number;
  /** Real known supply when available (never a source's own flag). */
  totalSupply: number | null;
  /** From the chain standard when known ("erc721" | "erc1155" | "editions" | "solana" | "ordinals" | "compressed"). */
  standard?: string | null;
  distinctTraitSets: number;
  tokensWithTraits: number;
  scoredTraitTypeCount: number;
};

export function collectionTypeSignals(items: GenericRarityInput[], opts?: { totalSupply?: number | null; standard?: string | null }): CollectionTypeSignals {
  const sets = new Set<string>();
  let withTraits = 0;
  for (const it of items) {
    if (it.traits.length > 0) withTraits += 1;
    sets.add(it.traits.map((t) => `${t.traitType}=${t.value}`).sort().join("|"));
  }
  return {
    sampleSize: items.length,
    totalSupply: opts?.totalSupply ?? null,
    standard: opts?.standard ?? null,
    distinctTraitSets: sets.size,
    tokensWithTraits: withTraits,
    scoredTraitTypeCount: scoredTraitTypes(items).length,
  };
}

/** Deterministic, explainable type detection from real signals only. */
export function detectCollectionType(s: CollectionTypeSignals): CollectionType {
  if (s.standard === "ordinals") return "ordinals";
  if (s.sampleSize === 0) return "unknown";
  const withTraitsRatio = s.tokensWithTraits / s.sampleSize;
  const distinctRatio = s.distinctTraitSets / s.sampleSize;
  const supply = s.totalSupply ?? s.sampleSize;
  if (withTraitsRatio < 0.2 || (s.scoredTraitTypeCount === 0 && s.distinctTraitSets <= 1)) {
    return s.distinctTraitSets <= 1 ? "open-edition" : "one-of-ones";
  }
  if (s.distinctTraitSets <= 1) return "open-edition";
  if (s.standard === "erc1155" || s.standard === "editions") return distinctRatio < 0.5 ? "editions" : "generative";
  if (distinctRatio < 0.25 && s.sampleSize >= 20) return "editions";
  if (supply >= 100_000 && s.scoredTraitTypeCount <= 2) return "large-registry";
  if (s.scoredTraitTypeCount === 0 && distinctRatio > 0.95) return "one-of-ones";
  return "generative";
}

export type TraitFrequency = Record<string, Record<string, { count: number; frequency: number }>>;

/** Per-trait, per-value frequency over the scored trait types -- the "rarer than X%" table. */
export function traitFrequencyTable(items: GenericRarityInput[]): TraitFrequency {
  const keep = new Set(scoredTraitTypes(items));
  const n = Math.max(1, items.length);
  const table: TraitFrequency = {};
  for (const it of items) {
    for (const t of it.traits) {
      if (!keep.has(t.traitType)) continue;
      const byValue = (table[t.traitType] ??= {});
      const cell = (byValue[t.value] ??= { count: 0, frequency: 0 });
      cell.count += 1;
    }
  }
  for (const byValue of Object.values(table)) for (const cell of Object.values(byValue)) cell.frequency = cell.count / n;
  return table;
}

/** "Rarer than X% of the collection" from a competition percentile (0..100 where 100 = rarest). */
export function rarerThanPercent(percentile: number): number {
  return Math.max(0, Math.min(100, Math.round(percentile * 10) / 10));
}

export type RarityCoverage = {
  sampleSize: number;
  totalSupply: number | null;
  /** sampleSize / totalSupply, clamped; null when the real supply is unknown. */
  coverage: number | null;
  /** True until the real sample equals the real supply. Unknown supply = partial. */
  partial: boolean;
};

export function rarityCoverage(sampleSize: number, totalSupply: number | null): RarityCoverage {
  if (totalSupply == null || totalSupply <= 0) return { sampleSize, totalSupply, coverage: null, partial: true };
  const coverage = Math.max(0, Math.min(1, sampleSize / totalSupply));
  return { sampleSize, totalSupply, coverage, partial: sampleSize < totalSupply };
}

export type TierFloor = { tier: RarityTier; floorWei: string | null; listed: number };

/**
 * Floor by official/derived tier from the REAL book: cheapest listing whose
 * token carries that tier. Tiers with no listing are dash (null), never 0.
 */
export function floorsByTier(
  rarity: Map<string, { tier: RarityTier | string }>,
  listings: Array<{ tokenId: string; priceWei: string }>
): TierFloor[] {
  const best = new Map<string, { floor: bigint; listed: number }>();
  for (const l of listings) {
    const tier = rarity.get(l.tokenId)?.tier;
    if (!tier) continue;
    let price: bigint;
    try {
      price = BigInt(l.priceWei);
    } catch {
      continue;
    }
    const cur = best.get(tier);
    if (!cur) best.set(tier, { floor: price, listed: 1 });
    else {
      cur.listed += 1;
      if (price < cur.floor) cur.floor = price;
    }
  }
  return (TIER_ORDER as readonly string[]).map((tier) => {
    const b = best.get(tier);
    return { tier: tier as RarityTier, floorWei: b ? b.floor.toString() : null, listed: b?.listed ?? 0 };
  });
}

export type UniversalRaritySnapshot = GenericRaritySnapshot & {
  collectionType: CollectionType;
  coverage: RarityCoverage;
  traitFrequency: TraitFrequency;
};

/**
 * Editions: rank the distinct trait SET (the edition), then give every copy
 * that edition's rank -- so 500 identical copies never read as 500 ties
 * spread across percentiles. 1/1s and open editions get no fabricated
 * spread. Generative and others use computeGenericRaritySnapshot unchanged.
 */
export function computeUniversalRaritySnapshot(
  items: GenericRarityInput[],
  opts?: { totalSupply?: number | null; standard?: string | null }
): UniversalRaritySnapshot {
  const signals = collectionTypeSignals(items, opts);
  const collectionType = detectCollectionType(signals);
  const coverage = rarityCoverage(items.length, opts?.totalSupply ?? null);
  const traitFrequency = traitFrequencyTable(items);
  if (collectionType === "editions") {
    // Copies of one edition share one trait set, so the kernel scores them
    // identically and competition rank ties them at one rank; the
    // large-tie percentile rule in computeGenericRaritySnapshot keeps 500
    // copies from being spread across percentiles. Rarer editions (fewer
    // copies) score higher because frequency is counted over all copies.
    const snap = computeGenericRaritySnapshot(items);
    return { ...snap, partial: coverage.partial, collectionType, coverage, traitFrequency };
  }
  if (collectionType === "one-of-ones" || collectionType === "open-edition") {
    const byTokenId = new Map<string, GenericTokenRarity>();
    for (const it of items) byTokenId.set(it.tokenId, { tokenId: it.tokenId, name: it.name ?? `#${it.tokenId}`, score: 0, rank: 1, percentile: 0, tier: "Common" });
    return { sampleSize: items.length, byTokenId, officialTierTrait: null, scoredTraitTypes: [], partial: coverage.partial, collectionType, coverage, traitFrequency };
  }
  const snap = computeGenericRaritySnapshot(items);
  return { ...snap, partial: coverage.partial, collectionType, coverage, traitFrequency };
}
