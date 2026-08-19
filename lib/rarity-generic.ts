/**
 * The generalized counterpart to lib/rarity.ts's computeRaritySnapshot --
 * same information-content algorithm (traitScore = -log2(frequency),
 * tokenScore = sum(traitScores), competition ranking, score-mass
 * percentile, tierFromPercentile bucketing), but scored across WHATEVER
 * trait categories a collection actually has, instead of RobinWood's
 * fixed Base/Background/Holographic schema (which has no meaning for a
 * foreign collection -- GRiBBiTS uses Frog/Tops/Hoody/Eyewear/Headwear/
 * Background/Accessories, entirely different categories).
 *
 * Reuses informationContent/tierFromPercentile/tierColor from lib/rarity.ts
 * as-is (pure math, no RobinWood-specific assumption) rather than
 * reimplementing them -- this IS "our own rarity solution," generalized,
 * per the standing instruction to reuse it for other collections.
 */
import { informationContent, tierFromPercentile, type RarityTier } from "@/lib/rarity";

export type GenericRarityInput = {
  tokenId: string;
  name: string | null;
  traits: Array<{ traitType: string; value: string }>;
};

export type GenericTokenRarity = {
  tokenId: string;
  name: string;
  score: number;
  rank: number;
  percentile: number;
  tier: RarityTier;
};

export type GenericRaritySnapshot = {
  sampleSize: number;
  byTokenId: Map<string, GenericTokenRarity>;
};

function traitKey(traitType: string, value: string): string {
  return `${traitType}\0${value}`;
}

export function computeGenericRaritySnapshot(items: GenericRarityInput[]): GenericRaritySnapshot {
  const sampleSize = items.length;
  if (sampleSize === 0) return { sampleSize: 0, byTokenId: new Map() };

  const counts = new Map<string, number>();
  for (const item of items) {
    for (const t of item.traits) {
      const key = traitKey(t.traitType, t.value);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }

  const rawScores = items.map((item) => {
    const score = item.traits.reduce((sum, t) => {
      const count = counts.get(traitKey(t.traitType, t.value)) ?? 1;
      return sum + informationContent(count / sampleSize);
    }, 0);
    return { tokenId: item.tokenId, name: item.name ?? `#${item.tokenId}`, score };
  });

  rawScores.sort((a, b) => b.score - a.score || a.tokenId.localeCompare(b.tokenId));

  const byTokenId = new Map<string, GenericTokenRarity>();
  let i = 0;
  while (i < rawScores.length) {
    const score = rawScores[i].score;
    let j = i + 1;
    while (j < rawScores.length && rawScores[j].score === score) j += 1;
    const rank = i + 1;
    for (let k = i; k < j; k += 1) {
      const row = rawScores[k];
      const positionPct = sampleSize > 1 ? ((sampleSize - 1 - k) / (sampleSize - 1)) * 100 : 100;
      byTokenId.set(row.tokenId, {
        tokenId: row.tokenId,
        name: row.name,
        score: row.score,
        rank,
        percentile: positionPct,
        tier: tierFromPercentile(positionPct),
      });
    }
    i = j;
  }

  return { sampleSize, byTokenId };
}
