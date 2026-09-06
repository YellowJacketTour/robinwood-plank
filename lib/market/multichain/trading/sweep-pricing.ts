/**
 * Liquidity-aware sweep pricing from the REAL book and the REAL fill
 * ledger -- pure, unit-tested. Answers three questions a sweeper has:
 *   1. what will N items actually cost off the book right now (exact, from
 *      listings, not floor × N);
 *   2. how far up the book does that walk (impact vs floor);
 *   3. is that price sane against recent real fills (a max-price cap).
 * Rarity/trait scope is a filter applied before pricing, never a fudge on
 * price. No number is produced without the inputs that justify it.
 */

export type BookListing = { tokenId: string; priceWei: string; tier?: string | null; traits?: Array<{ traitType: string; value: string }> };

export type SweepScope =
  | { kind: "floor" }
  | { kind: "tier"; tiers: string[] }
  | { kind: "trait"; clauses: Array<{ traitType: string; value: string }> };

export function scopeListings(listings: BookListing[], scope: SweepScope): BookListing[] {
  if (scope.kind === "floor") return listings;
  if (scope.kind === "tier") {
    const want = new Set(scope.tiers.map((t) => t.toLowerCase()));
    return listings.filter((l) => l.tier && want.has(l.tier.toLowerCase()));
  }
  return listings.filter((l) => scope.clauses.every((c) => (l.traits ?? []).some((t) => t.traitType === c.traitType && t.value === c.value)));
}

export type SweepQuote = {
  count: number;
  items: BookListing[];
  totalWei: bigint;
  floorWei: bigint | null;
  /** Price of the most expensive item taken. */
  topWei: bigint | null;
  /** topWei / floorWei - 1, as a fraction (0.25 = walked 25% above floor). null with < 1 item. */
  impact: number | null;
  /** Items available in scope; count < requested means the book ran out. */
  available: number;
};

export function quoteSweep(listings: BookListing[], scope: SweepScope, requested: number): SweepQuote {
  const inScope = scopeListings(listings, scope)
    .map((l) => ({ l, p: safeBig(l.priceWei) }))
    .filter((x): x is { l: BookListing; p: bigint } => x.p != null)
    .sort((a, b) => (a.p < b.p ? -1 : a.p > b.p ? 1 : 0));
  const take = inScope.slice(0, Math.max(0, Math.floor(requested)));
  const totalWei = take.reduce((s, x) => s + x.p, BigInt(0));
  const floorWei = inScope[0]?.p ?? null;
  const topWei = take.at(-1)?.p ?? null;
  const impact = floorWei != null && topWei != null && floorWei > BigInt(0) ? Number((topWei - floorWei) * BigInt(10_000) / floorWei) / 10_000 : null;
  return { count: take.length, items: take.map((x) => x.l), totalWei, floorWei, topWei, impact, available: inScope.length };
}

export type FillSample = { priceWei: string; timestamp: string | null };

export type SweepSanity = {
  /** Median of the recent fills, or null when there are none. */
  medianFillWei: bigint | null;
  sampleSize: number;
  /** Suggested per-item cap = median × (1 + tolerance); null without fills. */
  maxPerItemWei: bigint | null;
  /** Items in the quote priced above the cap (would be dropped by a capped sweep). */
  aboveCap: number;
};

export function sweepSanity(quote: SweepQuote, recentFills: FillSample[], tolerance = 0.35): SweepSanity {
  const prices = recentFills.map((f) => safeBig(f.priceWei)).filter((p): p is bigint => p != null).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  if (prices.length === 0) return { medianFillWei: null, sampleSize: 0, maxPerItemWei: null, aboveCap: 0 };
  const mid = prices.length >> 1;
  const median = prices.length % 2 === 1 ? prices[mid] : (prices[mid - 1] + prices[mid]) / BigInt(2);
  const cap = (median * BigInt(Math.round((1 + tolerance) * 10_000))) / BigInt(10_000);
  const aboveCap = quote.items.filter((l) => (safeBig(l.priceWei) ?? BigInt(0)) > cap).length;
  return { medianFillWei: median, sampleSize: prices.length, maxPerItemWei: cap, aboveCap };
}

function safeBig(v: string): bigint | null {
  try {
    return BigInt(v);
  } catch {
    return null;
  }
}
