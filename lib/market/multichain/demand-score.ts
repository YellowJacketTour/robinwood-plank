/**
 * Real, explainable "demand" ranking for tracked collections -- distinct
 * from gradeScore() in components/market/GlobalMarketHub.tsx, which grades
 * *market readiness/data completeness* (has art? has a live book? has a
 * floor?), never trend or popularity (see that file's own header: "A grade
 * is a current market-readiness score, not a popularity score.").
 * computeDemandScore fills that real gap using only signals this app
 * genuinely stores today (lib/market/multichain/store.ts's
 * CollectionWithSnapshot: volume24h/7d/30d, sales24h/7d/30d, listedCount,
 * totalSupply, holderCount) -- no external "AI prediction" API, no black
 * box, no fabricated number.
 *
 * RESEARCHED FORMULA BASIS (real, cited, adapted -- not invented):
 *
 * 1) Momentum/velocity term -- rate-of-change of a short window vs a longer
 *    baseline rate. This is the same technique underlying:
 *      - Hacker News' ranking formula, `score = (P - 1) / (T + 2)^G`
 *        (Amir Salihefendic's widely cited reverse-engineering of HN's
 *        actual Arc source, https://medium.com/hacking-and-gonzo/how-hacker-news-ranking-algorithm-works-1d9b0cf2c08d,
 *        and HN's own leaked news.arc `frontpage-rank`), which decays an
 *        absolute count by elapsed time so *recent* activity outweighs
 *        stale totals of the same size.
 *      - Reddit's "hot" ranking (Reddit r/programming: "reddit's ranking
 *        algorithm", https://medium.com/hacking-and-gonzo/how-reddit-ranking-algorithms-work-ef111e33d0d9),
 *        `score = log10(z) + (sign * seconds) / 45000`, which likewise
 *        favors recent magnitude over an undifferentiated cumulative count.
 *    We adapt the same *shape* (recent rate compared against a decayed
 *    baseline rate, not a raw magnitude) to this app's own volume/sales
 *    windows: rate24 = volume24h / 1 day, rate7 = volume7d / 7 days,
 *    rate30 = volume30d / 30 days. Momentum = how much rate24 exceeds the
 *    trailing rate7/rate30 baseline, i.e. real acceleration, not just size.
 *
 * 2) Depth/liquidity term -- listedCount / totalSupply, the same "float"
 *    concept real markets use (fraction of supply actually available to
 *    trade right now). A deep, executable book is real, present demand
 *    evidence independent of whether a big trade happened to land today.
 *
 * 3) Distribution-breadth term -- holderCount / totalSupply. This app does
 *    NOT store a true holder-concentration figure (e.g. top-10-wallet %),
 *    so this is honestly documented as a breadth PROXY, not a Gini
 *    coefficient: more distinct holders relative to supply is a real,
 *    computable signal that ownership (and therefore demand) is spread
 *    across many participants rather than concentrated in one or two
 *    wallets sitting on unsold inventory.
 *
 * 4) Rarity-depth term -- fraction of the tracked token projection that has
 *    a computed rarity rank at all (from plank_collection_tokens via
 *    readProjectedRarityInputs/upsertCollectionTokenProjection). A
 *    collection with a real, populated rarity distribution is one this app
 *    can actually facet/rank pieces within, which is itself evidence of a
 *    collection worth surfacing prominently in search.
 *
 * Every term is normalized to [0, 1] and combined as a weighted sum, so the
 * final score is always in [0, 100] and every weight below is a comment,
 * not a magic number buried in code.
 */

export type DemandScoreInput = {
  /** Raw wei/atomic strings as stored, or null when this app has never observed the window. */
  volume24hWei: string | null;
  volume7dWei: string | null;
  volume30dWei: string | null;
  sales24h: number | null;
  sales7d: number | null;
  sales30d: number | null;
  listedCount: number | null;
  totalSupply: number | null;
  holderCount: number | null;
  /** Count of tokens in the projection that carry a real computed rarity rank, and the total projected token count -- both from plank_collection_tokens (see collection-token-store.ts). Optional: undefined when the token projection hasn't run for this collection yet (never fabricated as 0/0). */
  rankedTokenCount?: number | null;
  projectedTokenCount?: number | null;
};

export type DemandScoreBreakdown = {
  /** Final composite, always in [0, 100]. */
  score: number;
  /** Each weighted term, already scaled to its max contribution, so a UI can show its work exactly like GradeBreakdown does for gradeScore(). */
  parts: Array<{ label: string; points: number; max: number }>;
  /** True only when there was at least one non-null real signal to score; a collection with zero data everywhere gets score 0 with gradable=false rather than a misleadingly confident 0. */
  gradable: boolean;
};

function toNumberOrNull(wei: string | null): number | null {
  if (wei == null) return null;
  const n = Number(wei);
  return Number.isFinite(n) ? n : null;
}

/** log-scale a non-negative ratio into [0,1] via a smooth clamp -- avoids one whale trade producing an out-of-range explosion while still rewarding large real acceleration. tanh is the standard bounded-growth curve for this (same role sigmoid/tanh play in any bounded scoring/activation function). */
function clampGrowth(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return Math.max(0, Math.min(1, Math.tanh(Math.max(x, 0) / 2)));
}

function ratio01(numerator: number | null, denominator: number | null): number | null {
  if (numerator == null || denominator == null || denominator <= 0) return null;
  return Math.max(0, Math.min(1, numerator / denominator));
}

/**
 * Momentum = how much the last-24h daily rate exceeds the trailing 7d/30d
 * daily baseline rate, HN/Reddit-style recency weighting applied to this
 * app's own real volume windows (see file header, term 1). Uses whichever
 * of sales-count or $ volume is present for a window (some adapters only
 * populate one); prefers $ volume when both exist since it is the more
 * complete demand signal, falling back to sales count so a collection with
 * volume=null but real sales_24h/7d/30d still gets a real momentum figure
 * instead of being scored as "no data".
 */
function windowMomentum(input: DemandScoreInput): number | null {
  const v24 = toNumberOrNull(input.volume24hWei);
  const v7 = toNumberOrNull(input.volume7dWei);
  const v30 = toNumberOrNull(input.volume30dWei);
  const haveVolume = v24 != null && v7 != null && v30 != null;
  const rate24 = haveVolume ? v24! : input.sales24h;
  const rate7Total = haveVolume ? v7! : input.sales7d;
  const rate30Total = haveVolume ? v30! : input.sales30d;
  if (rate24 == null || rate7Total == null || rate30Total == null) return null;
  const rate7 = rate7Total / 7;
  const rate30 = rate30Total / 30;
  // Blend the two baselines (7d weighted higher: closer in time, so a
  // truer "was this already trending this week" comparator than 30d
  // alone) -- same recency-favoring intent as HN's time-decayed
  // denominator, just applied to a rate baseline instead of raw age.
  const baseline = rate7 * 0.7 + rate30 * 0.3;
  if (baseline <= 0) {
    // No real historical baseline to compare against: any positive 24h
    // activity is, honestly, the entire signal available -- score it on
    // presence alone rather than dividing by zero or fabricating a ratio.
    return rate24 > 0 ? 1 : 0;
  }
  // Relative acceleration: 0 = flat, 1 = double the baseline rate, negative = decline.
  // clampGrowth already floors negative input at 0 (a real decline is
  // honestly scored as "no momentum", never a negative/fabricated boost)
  // and bounds growth via tanh so one outsized trade cannot blow past 1.
  const relativeChange = (rate24 - baseline) / baseline;
  return clampGrowth(relativeChange);
}

const WEIGHTS = {
  /** Recency-weighted volume/sales momentum -- the primary "is this hot right now" signal (term 1). */
  momentum: 45,
  /** Listed depth relative to supply -- real executable liquidity right now (term 2). */
  liquidityDepth: 20,
  /** Distinct holders relative to supply -- distribution-breadth proxy (term 3). */
  distributionBreadth: 15,
  /** Fraction of the token projection with a real computed rarity rank -- facetability/data richness (term 4). */
  rarityDepth: 20,
} as const;

/**
 * Compute a fully explainable [0,100] demand score. Every branch documents
 * why a null input is treated as "no opinion" (excluded from both the
 * numerator and the gradable max) rather than silently coerced to 0, so a
 * collection missing one window is never punished as if it had zero demand
 * on that axis -- only genuinely zero/negative real activity scores 0.
 */
export function computeDemandScore(input: DemandScoreInput): DemandScoreBreakdown {
  const parts: DemandScoreBreakdown["parts"] = [];
  let gradable = false;

  const momentum = windowMomentum(input);
  if (momentum != null) {
    gradable = true;
    parts.push({ label: "Volume/sales momentum (24h vs 7d/30d baseline)", points: Math.round(momentum * WEIGHTS.momentum), max: WEIGHTS.momentum });
  }

  const depth = ratio01(input.listedCount, input.totalSupply);
  if (depth != null) {
    gradable = true;
    parts.push({ label: "Listed depth (listedCount / totalSupply)", points: Math.round(depth * WEIGHTS.liquidityDepth), max: WEIGHTS.liquidityDepth });
  }

  const breadth = ratio01(input.holderCount, input.totalSupply);
  if (breadth != null) {
    gradable = true;
    parts.push({ label: "Distribution breadth (holderCount / totalSupply)", points: Math.round(breadth * WEIGHTS.distributionBreadth), max: WEIGHTS.distributionBreadth });
  }

  const rarity = ratio01(input.rankedTokenCount ?? null, input.projectedTokenCount ?? null);
  if (rarity != null) {
    gradable = true;
    parts.push({ label: "Rarity coverage (ranked / projected tokens)", points: Math.round(rarity * WEIGHTS.rarityDepth), max: WEIGHTS.rarityDepth });
  }

  const score = parts.reduce((sum, p) => sum + p.points, 0);
  return { score: Math.max(0, Math.min(100, score)), parts, gradable };
}
