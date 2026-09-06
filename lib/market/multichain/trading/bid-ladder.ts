/**
 * Portfolio-level bid ladder planner -- pure, unit-tested. Turns a budget
 * and a floor into N descending rungs (collection or trait criteria
 * offers) the UI submits as real Seaport offers. Never guesses a floor:
 * the caller passes the real one (dash in, no ladder out).
 */

export type BidLadderInput = {
  /** Total budget in wei for the whole ladder. */
  budgetWei: bigint;
  /** Real current floor in wei (from the book); required. */
  floorWei: bigint;
  /** Number of rungs, 1..12. */
  rungs: number;
  /** Top rung as a fraction of floor, e.g. 0.9 = 90% of floor. */
  startPct: number;
  /** Step between rungs as a fraction of floor, e.g. 0.05. */
  stepPct: number;
  /** Optional cap on items per rung. */
  maxPerRung?: number;
};

export type BidRung = { index: number; priceWei: bigint; quantity: number; totalWei: bigint };

export type BidLadder = { rungs: BidRung[]; spentWei: bigint; leftoverWei: bigint; items: number };

function pct(wei: bigint, fraction: number): bigint {
  const bps = BigInt(Math.round(fraction * 10_000));
  return (wei * bps) / BigInt(10_000);
}

export function planBidLadder(input: BidLadderInput): BidLadder {
  const rungCount = Math.max(1, Math.min(12, Math.floor(input.rungs)));
  if (input.floorWei <= BigInt(0) || input.budgetWei <= BigInt(0)) return { rungs: [], spentWei: BigInt(0), leftoverWei: input.budgetWei, items: 0 };
  const prices: bigint[] = [];
  for (let i = 0; i < rungCount; i++) {
    const fraction = input.startPct - i * input.stepPct;
    if (fraction <= 0) break;
    prices.push(pct(input.floorWei, fraction));
  }
  // Spread the budget evenly per rung, then fill each rung with whole items.
  const perRung = input.budgetWei / BigInt(Math.max(1, prices.length));
  const rungs: BidRung[] = [];
  let spent = BigInt(0);
  prices.forEach((priceWei, index) => {
    if (priceWei <= BigInt(0)) return;
    let quantity = Number(perRung / priceWei);
    if (input.maxPerRung != null) quantity = Math.min(quantity, Math.max(0, Math.floor(input.maxPerRung)));
    if (quantity <= 0) return;
    const totalWei = priceWei * BigInt(quantity);
    spent += totalWei;
    rungs.push({ index, priceWei, quantity, totalWei });
  });
  // Sweep leftover into the top rung one item at a time while it fits.
  let leftover = input.budgetWei - spent;
  if (rungs.length > 0) {
    const top = rungs[0];
    while (leftover >= top.priceWei && (input.maxPerRung == null || top.quantity < input.maxPerRung)) {
      top.quantity += 1;
      top.totalWei += top.priceWei;
      spent += top.priceWei;
      leftover -= top.priceWei;
    }
  }
  return { rungs, spentWei: spent, leftoverWei: leftover, items: rungs.reduce((n, r) => n + r.quantity, 0) };
}
