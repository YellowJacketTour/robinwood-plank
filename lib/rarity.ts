import type { NftAttribute } from "@/lib/ipfs";

/**
 * RobinWood Plank live rarity
 * ───────────────────────────
 * Method: information-content statistical rarity on the revealed sample.
 *
 * For each token, take the canonical traits (Base, Background, Holographic):
 *   traitScore = −log2(count(value) / N)
 *   tokenScore = sum(traitScores)
 *
 * Why not plain 1/frequency sum?
 *   • 1/f explodes for 1-of-N traits and drowns everything else
 *   • −log2(f) is standard information content (bits) and ranks the same
 *     ordinal intent with better spacing for mixed-rarity traits
 *
 * Why fixed trait keys?
 *   • Collection metadata is always Base + Background + Holographic
 *   • Ignoring extras / dupes prevents “more traits ⇒ rarer” inflation
 *
 * Rank: competition ranking — equal scores share the same rank
 *   (1,2,2,4 not 1,2,3,4 for a tie at #2).
 *
 * Percentile: “rarer than X% of the scored sample”
 *   = 100 * (tokens with strictly lower score) / N
 *
 * Tier: from that percentile (how exclusive the token is in-sample).
 *
 * IMPORTANT: N = currently revealed/loaded sample, not full 1542 until
 * the gallery has indexed everything. Ranks recompute as the sample grows.
 */

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
  /** Share of the scored sample (0–1). */
  frequency: number;
  /** Percent of sample (0–100). */
  pct: number;
  /** Information content in bits: −log2(frequency). */
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
  /** Sum of trait information-content scores (bits). */
  score: number;
  /**
   * 0–100 display score.
   * Equal to percentile of this token’s raw score within the sample
   * (100 ≈ rarest score mass, 0 ≈ most common score mass).
   */
  normalizedScore: number;
  /** 1 = rarest; ties share the same rank (competition ranking). */
  rank: number;
  /** 0–100; % of sample this token outranks by raw score. */
  percentile: number;
  tier: RarityTier;
  traits: TokenTraitBreakdown[];
};

export type RaritySnapshot = {
  sampleSize: number;
  scoredCount: number;
  byTokenId: Map<number, TokenRarity>;
  traitStats: Map<string, TraitValueStat[]>;
  traitOrder: string[];
  histogram: { label: string; min: number; max: number; count: number }[];
  tierCounts: Record<RarityTier, number>;
  topRarest: number[];
  uniqueBases: number;
  holoYes: number;
  holoPct: number;
  /** Scoring method label for UI honesty. */
  method: "information-content";
};

export type RarityInput = {
  tokenId: number;
  attributes: NftAttribute[];
  loaded: boolean;
};

/** Only these traits feed the score — matches on-chain metadata schema. */
export const CANONICAL_TRAITS = ["Base", "Background", "Holographic"] as const;
export type CanonicalTrait = (typeof CANONICAL_TRAITS)[number];

const TIER_ORDER: RarityTier[] = [
  "Mythic",
  "Legendary",
  "Epic",
  "Rare",
  "Uncommon",
  "Common",
];

/**
 * Tier from exclusivity percentile (share of sample outranked).
 * Cutoffs are population quantiles of the *scored sample*.
 */
export function tierFromPercentile(percentile: number): RarityTier {
  if (percentile >= 99) return "Mythic";
  if (percentile >= 95) return "Legendary";
  if (percentile >= 85) return "Epic";
  if (percentile >= 70) return "Rare";
  if (percentile >= 40) return "Uncommon";
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

/**
 * Escalating visual intensity by tier — box-shadow ring that gets brighter
 * and thicker the more exclusive the tier, so exclusivity reads at a glance
 * without needing to read the tier label. Common gets no glow at all (the
 * baseline every other tier stands out against).
 */
export function tierGlow(tier: RarityTier): string {
  const c = tierColor(tier);
  switch (tier) {
    case "Mythic":
      return `0 0 0 2px ${c}, 0 0 22px 4px ${c}99, 0 0 44px 10px ${c}44`;
    case "Legendary":
      return `0 0 0 2px ${c}, 0 0 16px 3px ${c}80`;
    case "Epic":
      return `0 0 0 1.5px ${c}, 0 0 10px 2px ${c}66`;
    case "Rare":
      return `0 0 0 1.5px ${c}, 0 0 6px 1px ${c}4d`;
    case "Uncommon":
      return `0 0 0 1px ${c}88`;
    default:
      return `0 0 0 1px ${c}33`;
  }
}

/** CSS class for tier-specific motion (see .tier-shimmer / .tier-pulse in
 * app/globals.css). Only the most exclusive tiers animate — motion itself is
 * part of the escalation, not just color/glow. */
export function tierAnimationClass(tier: RarityTier): string {
  if (tier === "Mythic") return "tier-shimmer tier-pulse";
  if (tier === "Legendary") return "tier-shimmer";
  return "";
}

function attrKey(trait: string, value: string) {
  return `${trait}\0${value}`;
}

function normalizeTraitName(raw: string): string {
  return String(raw ?? "").trim() || "Trait";
}

function normalizeValue(raw: unknown): string {
  const v = String(raw ?? "—").trim();
  return v || "—";
}

/**
 * Collapse attributes to one value per trait type (first wins).
 * Only canonical traits are kept for scoring.
 */
export function pickCanonicalTraits(
  attributes: NftAttribute[],
): Array<{ trait: CanonicalTrait; value: string }> {
  const found = new Map<string, string>();
  for (const attribute of attributes) {
    const trait = normalizeTraitName(attribute.trait_type ?? "");
    if (!CANONICAL_TRAITS.includes(trait as CanonicalTrait)) continue;
    if (found.has(trait)) continue; // first wins — ignore dupes
    found.set(trait, normalizeValue(attribute.value));
  }
  // Stable order: Base → Background → Holographic
  const out: Array<{ trait: CanonicalTrait; value: string }> = [];
  for (const trait of CANONICAL_TRAITS) {
    const value = found.get(trait);
    if (value !== undefined) out.push({ trait, value });
  }
  return out;
}

function informationContent(frequency: number): number {
  if (frequency <= 0) return 0;
  // bits
  return -Math.log2(frequency);
}

/**
 * Live statistical rarity from currently loaded / revealed metadata only.
 * Unminted and unloaded tokens are excluded from the sample.
 */
export function computeRaritySnapshot(items: RarityInput[]): RaritySnapshot {
  const scored = items.filter(
    (item) =>
      item.loaded &&
      Array.isArray(item.attributes) &&
      item.attributes.length > 0 &&
      pickCanonicalTraits(item.attributes).length > 0,
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
    method: "information-content",
  };

  if (sampleSize === 0) return empty;

  // Frequency tables over canonical traits only
  const counts = new Map<string, number>();
  const traitValues = new Map<string, Map<string, number>>();

  const perTokenTraits = scored.map((item) => ({
    tokenId: item.tokenId,
    traits: pickCanonicalTraits(item.attributes),
  }));

  for (const { traits } of perTokenTraits) {
    for (const { trait, value } of traits) {
      const key = attrKey(trait, value);
      counts.set(key, (counts.get(key) || 0) + 1);
      if (!traitValues.has(trait)) traitValues.set(trait, new Map());
      const map = traitValues.get(trait)!;
      map.set(value, (map.get(value) || 0) + 1);
    }
  }

  const traitStats = new Map<string, TraitValueStat[]>();
  // Prefer canonical order, then any extras (none expected)
  const traitOrder = [
    ...CANONICAL_TRAITS.filter((t) => traitValues.has(t)),
    ...Array.from(traitValues.keys())
      .filter((t) => !(CANONICAL_TRAITS as readonly string[]).includes(t))
      .sort((a, b) => a.localeCompare(b)),
  ];

  for (const trait of traitOrder) {
    const map = traitValues.get(trait)!;
    const stats: TraitValueStat[] = Array.from(map.entries()).map(
      ([value, count]) => {
        const frequency = count / sampleSize;
        return {
          trait,
          value,
          count,
          frequency,
          pct: frequency * 100,
          score: informationContent(frequency),
        };
      },
    );
    stats.sort((a, b) => b.score - a.score || a.value.localeCompare(b.value));
    traitStats.set(trait, stats);
  }

  type Raw = {
    tokenId: number;
    score: number;
    traits: TokenTraitBreakdown[];
  };

  const rawScores: Raw[] = perTokenTraits.map(({ tokenId, traits }) => {
    const breakdown: TokenTraitBreakdown[] = traits.map(({ trait, value }) => {
      const count = counts.get(attrKey(trait, value)) || 1;
      const frequency = count / sampleSize;
      return {
        trait,
        value,
        count,
        pct: frequency * 100,
        score: informationContent(frequency),
      };
    });
    // Sum of bits across present canonical traits
    const score = breakdown.reduce((sum, row) => sum + row.score, 0);
    return {
      tokenId,
      score,
      traits: breakdown.sort((a, b) => b.score - a.score),
    };
  });

  // Sort rarest first; stable tokenId for deterministic ordering within ties
  rawScores.sort((a, b) => b.score - a.score || a.tokenId - b.tokenId);

  // Competition ranks + percentiles from score mass
  const byTokenId = new Map<number, TokenRarity>();
  const tierCounts: Record<RarityTier, number> = {
    Mythic: 0,
    Legendary: 0,
    Epic: 0,
    Rare: 0,
    Uncommon: 0,
    Common: 0,
  };

  // Precompute how many tokens have score < S (for percentile)
  const scoresAsc = [...rawScores].map((r) => r.score).sort((a, b) => a - b);

  function countStrictlyBelow(score: number): number {
    // binary search
    let lo = 0;
    let hi = scoresAsc.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (scoresAsc[mid] < score) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  let i = 0;
  while (i < rawScores.length) {
    const score = rawScores[i].score;
    let j = i + 1;
    while (j < rawScores.length && rawScores[j].score === score) j += 1;
    // Competition rank: 1-based index of first member of this tie group
    const rank = i + 1;
    const below = countStrictlyBelow(score);
    const percentile = sampleSize > 0 ? (below / sampleSize) * 100 : 0;
    // Display score 0–100 mirrors exclusivity (same units as percentile)
    const normalizedScore = percentile;
    const tier = tierFromPercentile(percentile);

    for (let k = i; k < j; k += 1) {
      const row = rawScores[k];
      tierCounts[tier] += 1;
      byTokenId.set(row.tokenId, {
        tokenId: row.tokenId,
        score: row.score,
        normalizedScore,
        rank,
        percentile,
        tier,
        traits: row.traits,
      });
    }
    i = j;
  }

  // Histogram on normalized (percentile) score
  const bucketCount = 8;
  const histogram = Array.from({ length: bucketCount }, (_, idx) => {
    const min = (idx / bucketCount) * 100;
    const max = ((idx + 1) / bucketCount) * 100;
    return {
      label:
        idx === bucketCount - 1
          ? `${Math.round(min)}–100`
          : `${Math.round(min)}–${Math.round(max)}`,
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
    if (rarity.normalizedScore >= 100) idx = bucketCount - 1;
    if (idx < 0) idx = 0;
    histogram[idx].count += 1;
  }

  const baseStats = traitStats.get("Base") || [];
  const holoStats = traitStats.get("Holographic") || [];
  const holoYes =
    holoStats.find((row) => row.value.toLowerCase() === "yes")?.count || 0;

  // topRarest: one token per rank group, rarest first
  const topRarest: number[] = [];
  const seenRanks = new Set<number>();
  for (const row of rawScores) {
    const r = byTokenId.get(row.tokenId)!;
    if (seenRanks.has(r.rank)) continue;
    seenRanks.add(r.rank);
    topRarest.push(row.tokenId);
    if (topRarest.length >= 12) break;
  }

  return {
    sampleSize,
    scoredCount: sampleSize,
    byTokenId,
    traitStats,
    traitOrder,
    histogram,
    tierCounts,
    topRarest,
    uniqueBases: baseStats.length,
    holoYes,
    holoPct: sampleSize > 0 ? (holoYes / sampleSize) * 100 : 0,
    method: "information-content",
  };
}

export function formatRank(rank: number): string {
  return `#${rank.toLocaleString()}`;
}

/** Human-readable one-liner for modals / tooltips. */
export function rarityMethodBlurb(sampleSize: number): string {
  return `Live info-content rarity on ${sampleSize.toLocaleString()} revealed Planks (Base + Background + Holo). Ranks recompute as the gallery indexes.`;
}

export { TIER_ORDER };
