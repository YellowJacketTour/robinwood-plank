import type { NftAttribute } from "@/lib/ipfs";

export type RarityTier =
  | "Mythic"
  | "Legendary"
  | "Epic"
  | "Rare"
  | "Uncommon"
  | "Common";

export type TraitValueStat = {
  trait: string;
  value: string;
  count: number;
  /** Share of the loaded sample (0–1). */
  frequency: number;
  /** Percent of collection (0–100). */
  pct: number;
  /** Statistical weight: rarer ⇒ higher (1 / frequency). */
  score: number;
};

export type TokenTraitBreakdown = {
  trait: string;
  value: string;
  count: number;
  pct: number;
  score: number;
};

export type TokenRarity = {
  tokenId: number;
  /** Sum of trait statistical scores. */
  score: number;
  /** 0–100 relative to current sample (100 = rarest in sample). */
  normalizedScore: number;
  /** 1 = rarest among scored tokens. */
  rank: number;
  /** 0–100; higher = rarer (top of collection). */
  percentile: number;
  tier: RarityTier;
  traits: TokenTraitBreakdown[];
};

export type RaritySnapshot = {
  sampleSize: number;
  scoredCount: number;
  byTokenId: Map<number, TokenRarity>;
  /** trait → values sorted rarest first */
  traitStats: Map<string, TraitValueStat[]>;
  traitOrder: string[];
  histogram: { label: string; min: number; max: number; count: number }[];
  tierCounts: Record<RarityTier, number>;
  topRarest: number[];
  uniqueBases: number;
  holoYes: number;
  holoPct: number;
};

export type RarityInput = {
  tokenId: number;
  attributes: NftAttribute[];
  loaded: boolean;
};

const TIER_ORDER: RarityTier[] = [
  "Mythic",
  "Legendary",
  "Epic",
  "Rare",
  "Uncommon",
  "Common",
];

export function tierFromPercentile(percentile: number): RarityTier {
  if (percentile >= 99) return "Mythic";
  if (percentile >= 95) return "Legendary";
  if (percentile >= 85) return "Epic";
  if (percentile >= 65) return "Rare";
  if (percentile >= 35) return "Uncommon";
  return "Common";
}

export function tierColor(tier: RarityTier): string {
  switch (tier) {
    case "Mythic":
      return "#f0abfc";
    case "Legendary":
      return "#f8d98a";
    case "Epic":
      return "#c4b5fd";
    case "Rare":
      return "#93c5fd";
    case "Uncommon":
      return "#86efac";
    default:
      return "#d6d3d1";
  }
}

function attrKey(trait: string, value: string) {
  return `${trait}\0${value}`;
}

/**
 * Live statistical rarity from currently loaded / revealed metadata only.
 * Unminted and unloaded tokens are excluded from the sample.
 */
export function computeRaritySnapshot(items: RarityInput[]): RaritySnapshot {
  const scored = items.filter(
    (item) => item.loaded && Array.isArray(item.attributes) && item.attributes.length > 0,
  );
  const sampleSize = scored.length;

  const empty: RaritySnapshot = {
    sampleSize: 0,
    scoredCount: 0,
    byTokenId: new Map(),
    traitStats: new Map(),
    traitOrder: [],
    histogram: [],
    tierCounts: {
      Mythic: 0,
      Legendary: 0,
      Epic: 0,
      Rare: 0,
      Uncommon: 0,
      Common: 0,
    },
    topRarest: [],
    uniqueBases: 0,
    holoYes: 0,
    holoPct: 0,
  };

  if (sampleSize === 0) return empty;

  // Frequency tables
  const counts = new Map<string, number>();
  const traitValues = new Map<string, Map<string, number>>();

  for (const item of scored) {
    for (const attribute of item.attributes) {
      const trait = String(attribute.trait_type ?? "Trait").trim() || "Trait";
      const value = String(attribute.value ?? "—").trim() || "—";
      const key = attrKey(trait, value);
      counts.set(key, (counts.get(key) || 0) + 1);
      if (!traitValues.has(trait)) traitValues.set(trait, new Map());
      const map = traitValues.get(trait)!;
      map.set(value, (map.get(value) || 0) + 1);
    }
  }

  const traitStats = new Map<string, TraitValueStat[]>();
  const traitOrder = Array.from(traitValues.keys()).sort((a, b) => a.localeCompare(b));

  for (const trait of traitOrder) {
    const map = traitValues.get(trait)!;
    const stats: TraitValueStat[] = Array.from(map.entries()).map(([value, count]) => {
      const frequency = count / sampleSize;
      return {
        trait,
        value,
        count,
        frequency,
        pct: frequency * 100,
        score: frequency > 0 ? 1 / frequency : 0,
      };
    });
    stats.sort((a, b) => b.score - a.score || a.value.localeCompare(b.value));
    traitStats.set(trait, stats);
  }

  // Per-token scores
  type Raw = { tokenId: number; score: number; traits: TokenTraitBreakdown[] };
  const rawScores: Raw[] = scored.map((item) => {
    const traits: TokenTraitBreakdown[] = item.attributes.map((attribute) => {
      const trait = String(attribute.trait_type ?? "Trait").trim() || "Trait";
      const value = String(attribute.value ?? "—").trim() || "—";
      const count = counts.get(attrKey(trait, value)) || 1;
      const frequency = count / sampleSize;
      const score = frequency > 0 ? 1 / frequency : 0;
      return {
        trait,
        value,
        count,
        pct: frequency * 100,
        score,
      };
    });
    const score = traits.reduce((sum, row) => sum + row.score, 0);
    return { tokenId: item.tokenId, score, traits };
  });

  rawScores.sort((a, b) => b.score - a.score || a.tokenId - b.tokenId);

  const maxScore = rawScores[0]?.score || 1;
  const minScore = rawScores[rawScores.length - 1]?.score || 0;
  const span = Math.max(1e-9, maxScore - minScore);

  const byTokenId = new Map<number, TokenRarity>();
  const tierCounts: Record<RarityTier, number> = {
    Mythic: 0,
    Legendary: 0,
    Epic: 0,
    Rare: 0,
    Uncommon: 0,
    Common: 0,
  };

  rawScores.forEach((row, index) => {
    const rank = index + 1;
    const percentile = ((sampleSize - rank + 1) / sampleSize) * 100;
    const tier = tierFromPercentile(percentile);
    tierCounts[tier] += 1;
    byTokenId.set(row.tokenId, {
      tokenId: row.tokenId,
      score: row.score,
      normalizedScore: ((row.score - minScore) / span) * 100,
      rank,
      percentile,
      tier,
      traits: row.traits.sort((a, b) => b.score - a.score),
    });
  });

  // Histogram on normalized score
  const bucketCount = 8;
  const histogram = Array.from({ length: bucketCount }, (_, i) => {
    const min = (i / bucketCount) * 100;
    const max = ((i + 1) / bucketCount) * 100;
    return {
      label: i === bucketCount - 1 ? `${Math.round(min)}–100` : `${Math.round(min)}–${Math.round(max)}`,
      min,
      max,
      count: 0,
    };
  });
  for (const rarity of byTokenId.values()) {
    let idx = Math.min(
      bucketCount - 1,
      Math.floor((rarity.normalizedScore / 100) * bucketCount),
    );
    if (idx < 0) idx = 0;
    histogram[idx].count += 1;
  }

  const baseStats = traitStats.get("Base") || [];
  const holoStats = traitStats.get("Holographic") || [];
  const holoYes = holoStats.find((row) => row.value.toLowerCase() === "yes")?.count || 0;

  return {
    sampleSize,
    scoredCount: sampleSize,
    byTokenId,
    traitStats,
    traitOrder,
    histogram,
    tierCounts,
    topRarest: rawScores.slice(0, 12).map((row) => row.tokenId),
    uniqueBases: baseStats.length,
    holoYes,
    holoPct: sampleSize > 0 ? (holoYes / sampleSize) * 100 : 0,
  };
}

export function formatRank(rank: number): string {
  return `#${rank.toLocaleString()}`;
}

export { TIER_ORDER };
