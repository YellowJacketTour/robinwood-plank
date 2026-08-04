/**
 * OpenRarity-style (information-content) rarity scoring — generic across
 * arbitrary, per-collection trait taxonomies (unlike lib/rarity.ts, which is
 * scoped to RobinWood's fixed Base/Background/Holographic schema for the
 * live gallery UI). This module is pure math with no I/O, so it is run from
 * the offline batch job (scripts/compute-rarity.ts) against whatever traits
 * are on file for a collection in Postgres, and unit-tested directly.
 *
 * Method (OpenRarity's core idea, "information content" / entropy scoring):
 *   For each trait value in a collection:
 *     probability(trait, value) = count(trait, value) / totalTokens
 *     informationContent(trait, value) = -log2(probability(trait, value))
 *   A token's rarity score = sum of informationContent over its own traits.
 *   Rarer (lower-probability) trait values contribute more bits, so a token
 *   with several uncommon traits scores higher than one with a single very
 *   rare trait and nothing else notable — unlike naive 1/count scoring,
 *   which is dominated by whichever single trait is rarest.
 *
 * Missing traits: a token that lacks a trait_type present on other tokens in
 * the collection is NOT assigned any score contribution for that trait_type
 * — it is simply absent from the sum, exactly as OpenRarity treats missing
 * attributes. This means two tokens with the same traits-present but
 * different totals are still comparable per-trait; nothing is imputed.
 */

export type TraitPair = { traitType: string; traitValue: string };

export type TokenTraits = {
  tokenId: number;
  traits: TraitPair[];
};

export type TraitValueScore = {
  traitType: string;
  traitValue: string;
  count: number;
  probability: number;
  informationContent: number;
};

export type TokenRarityScore = {
  tokenId: number;
  score: number;
  traitCount: number;
  rank: number;
};

function traitKey(traitType: string, traitValue: string): string {
  return `${traitType}::${traitValue}`;
}

/**
 * Frequency table for every (traitType, traitValue) pair across the given
 * tokens. `totalTokens` is the collection's total token count, NOT
 * necessarily `tokens.length` — a caller scoring a partial sample (e.g. only
 * revealed tokens) should still pass the true collection size so probability
 * reflects the whole collection, matching OpenRarity's definition. When
 * omitted, `tokens.length` is used.
 */
export function computeTraitValueScores(
  tokens: readonly TokenTraits[],
  totalTokens?: number
): Map<string, TraitValueScore> {
  const total = totalTokens ?? tokens.length;
  const counts = new Map<string, TraitValueScore>();
  if (total <= 0) return counts;

  for (const token of tokens) {
    for (const { traitType, traitValue } of token.traits) {
      const key = traitKey(traitType, traitValue);
      const existing = counts.get(key);
      if (existing) {
        existing.count += 1;
      } else {
        counts.set(key, {
          traitType,
          traitValue,
          count: 1,
          probability: 0,
          informationContent: 0,
        });
      }
    }
  }

  for (const entry of counts.values()) {
    entry.probability = entry.count / total;
    entry.informationContent =
      entry.probability > 0 ? -Math.log2(entry.probability) : 0;
  }

  return counts;
}

/**
 * Score every token: sum of information content across its own traits, then
 * rank (competition ranking — ties share a rank, e.g. 1,2,2,4) by descending
 * score (rarer first, rank 1 = rarest).
 *
 * Edge cases this handles explicitly:
 *  - Single-trait collections: every token has exactly one trait, so scores
 *    reduce to plain information content of that one value — still correct,
 *    since the sum of one term is that term.
 *  - A trait value present on 100% of tokens contributes probability = 1,
 *    informationContent = -log2(1) = 0 bits — it adds nothing to the score,
 *    which is the right behavior: a universal trait carries no rarity signal.
 *  - A token with zero recognized traits scores 0 and ranks last (tied with
 *    any other zero-trait token) rather than throwing or being dropped.
 */
export function computeTokenRarityScores(
  tokens: readonly TokenTraits[],
  totalTokens?: number
): TokenRarityScore[] {
  const traitScores = computeTraitValueScores(tokens, totalTokens);

  const raw = tokens.map((token) => {
    let score = 0;
    for (const { traitType, traitValue } of token.traits) {
      score += traitScores.get(traitKey(traitType, traitValue))?.informationContent ?? 0;
    }
    return { tokenId: token.tokenId, score, traitCount: token.traits.length };
  });

  raw.sort((a, b) => b.score - a.score || a.tokenId - b.tokenId);

  const out: TokenRarityScore[] = [];
  let i = 0;
  while (i < raw.length) {
    const score = raw[i].score;
    let j = i + 1;
    while (j < raw.length && raw[j].score === score) j += 1;
    const rank = i + 1; // competition ranking: ties share the rank of the first tied position
    for (let k = i; k < j; k += 1) {
      out.push({ tokenId: raw[k].tokenId, score: raw[k].score, traitCount: raw[k].traitCount, rank });
    }
    i = j;
  }

  // Preserve caller's original token order for convenience.
  const byId = new Map(out.map((r) => [r.tokenId, r]));
  return tokens.map((t) => byId.get(t.tokenId)!);
}

/** Facet counts keyed by (traitType -> traitValue -> count), for the filter panel. */
export function computeFacetCounts(
  tokens: readonly TokenTraits[]
): Map<string, Map<string, number>> {
  const facets = new Map<string, Map<string, number>>();
  for (const token of tokens) {
    for (const { traitType, traitValue } of token.traits) {
      const byValue = facets.get(traitType) ?? new Map<string, number>();
      byValue.set(traitValue, (byValue.get(traitValue) ?? 0) + 1);
      facets.set(traitType, byValue);
    }
  }
  return facets;
}
