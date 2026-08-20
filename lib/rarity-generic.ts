/**
 * Generalized counterpart to lib/rarity.ts's computeRaritySnapshot —
 * same −log2 information-content kernel, competition rank, dual percentile.
 * Adaptive trait schema: official tier trait (Background-like) when present;
 * spam trait types excluded. Never invents missing traits.
 */
import { informationContent, tierFromBackground, tierFromPercentile, type RarityTier } from "@/lib/rarity";

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
  officialTierTrait: string | null;
  scoredTraitTypes: string[];
  partial?: boolean;
};

function traitKey(traitType: string, value: string): string {
  return `${traitType}\0${value}`;
}

function normType(t: string): string {
  return t.toLowerCase().replace(/[\s_-]+/g, "");
}

const TIER_TYPE_HINTS = ["background", "tier", "rarity", "rank", "class", "edition"] as const;
const JUNK_TYPE = /^(tokenid|id|editionnumber|serial|number|#)$/i;

/** Longest-first official-tier trait (RobinWood Background pattern). */
export function detectOfficialTierTrait(items: GenericRarityInput[]): string | null {
  const types = new Set<string>();
  for (const item of items) for (const t of item.traits) types.add(t.traitType);
  const ranked = [...types]
    .filter((t) => TIER_TYPE_HINTS.some((h) => normType(t).includes(h)))
    .sort((a, b) => b.length - a.length || a.localeCompare(b));
  const n = items.length;
  if (n === 0) return null;
  for (const type of ranked) {
    const values = items.map((i) => i.traits.find((t) => t.traitType === type)?.value).filter((v): v is string => Boolean(v));
    if (values.length < n * 0.4) continue;
    const unique = [...new Set(values)];
    const mapped = unique.filter((v) => tierFromBackground(v) != null);
    if (mapped.length >= 2 && mapped.length / unique.length >= 0.5) return type;
  }
  return null;
}

/** ID-like / sequential traits that would drown information content. */
export function isSpamTraitType(type: string, items: GenericRarityInput[]): boolean {
  const n = items.length;
  if (n === 0) return false;
  const values = items.map((i) => i.traits.find((t) => t.traitType === type)?.value).filter((v): v is string => v != null && v !== "");
  if (values.length === 0) return false;
  const unique = new Set(values);
  if (JUNK_TYPE.test(normType(type)) && unique.size > n * 0.8) return true;
  if (values.length / n > 0.99 && unique.size / values.length > 0.95) return true;
  if (unique.size > Math.min(500, Math.max(2, n / 2))) return true;
  return false;
}

export function scoredTraitTypes(items: GenericRarityInput[]): string[] {
  const types = new Set<string>();
  for (const item of items) for (const t of item.traits) types.add(t.traitType);
  return [...types].filter((t) => !isSpamTraitType(t, items)).sort((a, b) => a.localeCompare(b));
}

export function computeGenericRaritySnapshot(items: GenericRarityInput[]): GenericRaritySnapshot {
  const sampleSize = items.length;
  if (sampleSize === 0) {
    return { sampleSize: 0, byTokenId: new Map(), officialTierTrait: null, scoredTraitTypes: [] };
  }

  const officialTierTrait = detectOfficialTierTrait(items);
  const keepTypes = new Set(scoredTraitTypes(items));

  const counts = new Map<string, number>();
  for (const item of items) {
    for (const t of item.traits) {
      if (!keepTypes.has(t.traitType)) continue;
      const key = traitKey(t.traitType, t.value);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }

  const rawScores = items.map((item) => {
    const scored = item.traits.filter((t) => keepTypes.has(t.traitType));
    const score = scored.reduce((sum, t) => {
      const count = counts.get(traitKey(t.traitType, t.value)) ?? 1;
      return sum + informationContent(count / sampleSize);
    }, 0);
    const officialValue = officialTierTrait ? item.traits.find((t) => t.traitType === officialTierTrait)?.value : null;
    return {
      tokenId: item.tokenId,
      name: item.name ?? `#${item.tokenId}`,
      score,
      officialValue: officialValue ?? null,
    };
  });

  rawScores.sort((a, b) => b.score - a.score || a.tokenId.localeCompare(b.tokenId));
  const scoresAsc = [...rawScores].map((r) => r.score).sort((a, b) => a - b);

  function countStrictlyBelow(score: number): number {
    let lo = 0;
    let hi = scoresAsc.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (scoresAsc[mid] < score) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  const byTokenId = new Map<string, GenericTokenRarity>();
  let i = 0;
  while (i < rawScores.length) {
    const score = rawScores[i].score;
    let j = i + 1;
    while (j < rawScores.length && rawScores[j].score === score) j += 1;
    const rank = i + 1;
    const scorePercentile = sampleSize > 0 ? (countStrictlyBelow(score) / sampleSize) * 100 : 0;
    for (let k = i; k < j; k += 1) {
      const row = rawScores[k];
      const positionPct = sampleSize > 1 ? ((sampleSize - 1 - k) / (sampleSize - 1)) * 100 : 100;
      const percentile = Math.max(scorePercentile, positionPct);
      const tier = (row.officialValue ? tierFromBackground(row.officialValue) : null) ?? tierFromPercentile(positionPct);
      byTokenId.set(row.tokenId, {
        tokenId: row.tokenId,
        name: row.name,
        score: row.score,
        rank,
        percentile,
        tier,
      });
    }
    i = j;
  }

  return { sampleSize, byTokenId, officialTierTrait, scoredTraitTypes: [...keepTypes] };
}
