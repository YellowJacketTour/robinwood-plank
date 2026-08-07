import assert from "node:assert/strict";
import test from "node:test";
import {
  applyFlow,
  avgCostPerShareWei,
  cohortKey,
  computeCohortPositions,
  emptyPosition,
  isTradingVolumeEvent,
  marketValueWei,
  navPerShareWei,
  reduceFlows,
  unrealizedPnlWei,
  SHARE_UNIT,
  type FlowEvent,
} from "../../lib/market/portfolio-pnl";

const WALLET = "0xAaAaAaAAAaaAAaAaAAaAAAAAaAAaAAaAAaAaAaAa";
const VAULT = "0xb2019Fd4cA24502e812C0C73b751Fa49979BF708";

function inc(sharesWei: bigint, valueWei: bigint, blockNumber = 1): FlowEvent {
  return { kind: "increase", sharesWei, valueWei, source: "trade", blockNumber, txHash: `0x${blockNumber}` };
}
function dec(sharesWei: bigint, valueWei: bigint, blockNumber = 1, navParityValueWei?: bigint): FlowEvent {
  return {
    kind: "decrease",
    sharesWei,
    valueWei,
    navParityValueWei,
    source: "trade",
    blockNumber,
    txHash: `0x${blockNumber}`,
  };
}

test("empty position starts fully zeroed", () => {
  const pos = emptyPosition(WALLET, VAULT);
  assert.equal(pos.sharesHeld, 0n);
  assert.equal(pos.costBasisWei, 0n);
  assert.equal(avgCostPerShareWei(pos), 0n);
});

test("a single buy sets cost basis and avg cost to exactly what was paid", () => {
  // 1.0 share for 1.0 ETH -> avg cost = 1.0 ETH/share
  const pos = applyFlow(emptyPosition(WALLET, VAULT), inc(SHARE_UNIT, SHARE_UNIT));
  assert.equal(pos.sharesHeld, SHARE_UNIT);
  assert.equal(pos.costBasisWei, SHARE_UNIT);
  assert.equal(avgCostPerShareWei(pos), SHARE_UNIT);
});

test("two buys at different NAVs blend into a real weighted-average cost", () => {
  // Buy 1.0 share @ 1.0 ETH, then 1.0 share @ 3.0 ETH -> avg = 2.0 ETH/share
  let pos = emptyPosition(WALLET, VAULT);
  pos = applyFlow(pos, inc(SHARE_UNIT, SHARE_UNIT, 1));
  pos = applyFlow(pos, inc(SHARE_UNIT, 3n * SHARE_UNIT, 2));
  assert.equal(pos.sharesHeld, 2n * SHARE_UNIT);
  assert.equal(pos.costBasisWei, 4n * SHARE_UNIT);
  assert.equal(avgCostPerShareWei(pos), 2n * SHARE_UNIT);
});

test("three buys at different sizes and NAVs blend to the correct dollar-weighted average", () => {
  // 2 shares @ 1.0, 1 share @ 4.0, 1 share @ 10.0
  // total shares = 4, total cost = 2 + 4 + 10 = 16 -> avg = 4.0 ETH/share
  let pos = emptyPosition(WALLET, VAULT);
  pos = applyFlow(pos, inc(2n * SHARE_UNIT, 2n * SHARE_UNIT, 1));
  pos = applyFlow(pos, inc(SHARE_UNIT, 4n * SHARE_UNIT, 2));
  pos = applyFlow(pos, inc(SHARE_UNIT, 10n * SHARE_UNIT, 3));
  assert.equal(pos.sharesHeld, 4n * SHARE_UNIT);
  assert.equal(pos.costBasisWei, 16n * SHARE_UNIT);
  assert.equal(avgCostPerShareWei(pos), 4n * SHARE_UNIT);
});

test("a partial sell realizes PnL against the weighted-average cost, not FIFO/LIFO", () => {
  // Buy 2 @ 1.0 (avg 1.0), buy 2 @ 3.0 (avg blends to 2.0 across 4 shares).
  // Sell 1 share @ 5.0 -> realized = 5.0 - 2.0 (avg cost) = 3.0 ETH.
  // FIFO would say realized = 5.0 - 1.0 = 4.0 — this must NOT match FIFO.
  let pos = emptyPosition(WALLET, VAULT);
  pos = applyFlow(pos, inc(2n * SHARE_UNIT, 2n * SHARE_UNIT, 1)); // 2 @ 1.0
  pos = applyFlow(pos, inc(2n * SHARE_UNIT, 6n * SHARE_UNIT, 2)); // 2 @ 3.0 -> avg 2.0/4
  pos = applyFlow(pos, dec(SHARE_UNIT, 5n * SHARE_UNIT, 3)); // sell 1 @ 5.0

  assert.equal(pos.sharesHeld, 3n * SHARE_UNIT);
  assert.equal(pos.realizedPnlWei, 3n * SHARE_UNIT);
  // remaining cost basis: 8.0 total - 2.0 removed = 6.0 over 3 shares -> avg still 2.0
  assert.equal(pos.costBasisWei, 6n * SHARE_UNIT);
  assert.equal(avgCostPerShareWei(pos), 2n * SHARE_UNIT);
});

test("selling the entire position realizes total proceeds minus total cost and zeroes basis", () => {
  let pos = emptyPosition(WALLET, VAULT);
  pos = applyFlow(pos, inc(3n * SHARE_UNIT, 6n * SHARE_UNIT, 1)); // avg 2.0
  pos = applyFlow(pos, dec(3n * SHARE_UNIT, 9n * SHARE_UNIT, 2)); // sell all @ effective 3.0 total... i.e. 3 shares for 9 ETH
  assert.equal(pos.sharesHeld, 0n);
  assert.equal(pos.costBasisWei, 0n);
  assert.equal(pos.realizedPnlWei, 3n * SHARE_UNIT); // 9 - 6
});

test("realized and unrealized PnL are tracked and reported separately", () => {
  let pos = emptyPosition(WALLET, VAULT);
  pos = applyFlow(pos, inc(4n * SHARE_UNIT, 4n * SHARE_UNIT, 1)); // 4 @ 1.0 avg
  pos = applyFlow(pos, dec(SHARE_UNIT, 2n * SHARE_UNIT, 2)); // sell 1 @ 2.0 -> realized +1.0
  assert.equal(pos.realizedPnlWei, SHARE_UNIT);
  assert.equal(pos.sharesHeld, 3n * SHARE_UNIT);

  // Mark remaining 3 shares (cost basis 3.0) against a current NAV of 1.5/share.
  const currentNav = (3n * SHARE_UNIT) / 2n;
  const unrealized = unrealizedPnlWei(pos, currentNav);
  // market value = 3 * 1.5 = 4.5; cost basis = 3.0 -> unrealized = +1.5
  assert.equal(unrealized, (3n * SHARE_UNIT) / 2n);
  assert.equal(marketValueWei(pos, currentNav), (9n * SHARE_UNIT) / 2n);

  // Realized PnL must be untouched by marking unrealized against a new NAV.
  assert.equal(pos.realizedPnlWei, SHARE_UNIT);
});

test("unrealized PnL uses NAV, not last-trade price — a stale/manipulated trade price never enters the calc", () => {
  let pos = emptyPosition(WALLET, VAULT);
  pos = applyFlow(pos, inc(SHARE_UNIT, SHARE_UNIT, 1)); // bought at 1.0
  // Simulate a wildly-off last trade elsewhere (e.g. 100 ETH/share) — irrelevant,
  // since unrealizedPnlWei only ever takes an explicit NAV-per-share argument.
  const realNav = navPerShareWei(2n * SHARE_UNIT, SHARE_UNIT); // reserve 2 ETH / supply 1 share = 2.0 NAV
  assert.equal(realNav, 2n * SHARE_UNIT);
  assert.equal(unrealizedPnlWei(pos, realNav), SHARE_UNIT); // +1.0, computed off NAV only
});

test("a deposit (NFT-in) and later redeem (NFT-out) are valued at NAV-per-share, not a trade price", () => {
  // Deposit at NAV=1.0/share mints ~0.99 shares (1% mint fee) -> increase.
  // Redeem later at NAV=1.5/share burns 1.0099 shares for ~0.99 ETH worth net
  // of fee -> decrease. Values below are the NAV-derived economic values a
  // caller (the indexer) is responsible for computing before calling this API.
  let pos = emptyPosition(WALLET, VAULT);
  const depositShares = (SHARE_UNIT * 99n) / 100n; // 0.99 shares out after 1% mint fee
  const depositValue = depositShares; // NAV=1.0 at deposit time
  pos = applyFlow(pos, {
    kind: "increase",
    sharesWei: depositShares,
    valueWei: depositValue,
    source: "vault",
    blockNumber: 1,
    txHash: "0xd1",
  });
  assert.equal(pos.sharesHeld, depositShares);
  assert.equal(pos.costBasisWei, depositValue);

  const nav = navPerShareWei(3n * SHARE_UNIT, 2n * SHARE_UNIT); // 1.5 NAV/share
  assert.equal(nav, (3n * SHARE_UNIT) / 2n);
  const proceeds = (depositShares * nav) / SHARE_UNIT;
  pos = applyFlow(pos, {
    kind: "decrease",
    sharesWei: depositShares,
    valueWei: proceeds,
    source: "vault",
    blockNumber: 2,
    txHash: "0xr1",
  });
  assert.equal(pos.sharesHeld, 0n);
  // realized = proceeds (NAV 1.5) - cost (NAV 1.0 at deposit) = +0.5 * 0.99 shares
  const expected = proceeds - depositValue;
  assert.equal(pos.realizedPnlWei, expected);
  assert.ok(expected > 0n, "wallet should show a real gain from NAV appreciation, not zero");
});

test("fee drag is attributed separately from raw price movement on a decrease", () => {
  let pos = emptyPosition(WALLET, VAULT);
  pos = applyFlow(pos, inc(SHARE_UNIT, SHARE_UNIT, 1)); // cost basis 1.0
  // Redeem at NAV-parity 1.0 but the vault's redeem fee actually pays out 0.99.
  pos = applyFlow(pos, dec(SHARE_UNIT, (SHARE_UNIT * 99n) / 100n, 2, SHARE_UNIT));
  // realized = 0.99 - 1.00 = -0.01 (all fee, no real price movement)
  assert.equal(pos.realizedPnlWei, -(SHARE_UNIT / 100n));
  // fee drag = navParity(1.0) - actual(0.99) = 0.01
  assert.equal(pos.feeDragWei, SHARE_UNIT / 100n);
});

test("fee drag defaults to zero when no NAV-parity reference is supplied (pure AMM trade)", () => {
  let pos = emptyPosition(WALLET, VAULT);
  pos = applyFlow(pos, inc(SHARE_UNIT, SHARE_UNIT, 1));
  pos = applyFlow(pos, dec(SHARE_UNIT, 2n * SHARE_UNIT, 2));
  assert.equal(pos.feeDragWei, 0n);
});

test("a decrease larger than the tracked position clamps to what's held, never goes net negative", () => {
  let pos = emptyPosition(WALLET, VAULT);
  pos = applyFlow(pos, inc(SHARE_UNIT, SHARE_UNIT, 1));
  // Sell 2 shares when only 1 is tracked (e.g. history starts mid-stream).
  pos = applyFlow(pos, dec(2n * SHARE_UNIT, 4n * SHARE_UNIT, 2));
  assert.equal(pos.sharesHeld, 0n);
  assert.equal(pos.costBasisWei, 0n);
  // Proceeds split proportionally: only the matched half (1 of 2 shares,
  // 2.0 of the 4.0 proceeds) is realized against the known 1.0 cost.
  // Folding the whole 4.0 in against a 1.0 cost would manufacture a fake
  // 3.0 "gain" for shares this cohort never actually tracked owning.
  assert.equal(pos.realizedPnlWei, SHARE_UNIT); // 2.0 matched proceeds - 1.0 cost
  assert.equal(pos.unmatchedSharesWei, SHARE_UNIT);
  assert.equal(pos.unmatchedProceedsWei, 2n * SHARE_UNIT);
});

test("an unmatched decrease with zero tracked history reports zero realized gain, not the full proceeds as profit", () => {
  // No prior increase event at all — this cohort's history starts mid-stream.
  const pos = applyFlow(emptyPosition(WALLET, VAULT), dec(5n * SHARE_UNIT, 500n * SHARE_UNIT, 1));
  assert.equal(pos.sharesHeld, 0n);
  assert.equal(pos.realizedPnlWei, 0n, "zero known cost basis must not be read as 100% profit");
  assert.equal(pos.unmatchedSharesWei, 5n * SHARE_UNIT);
  assert.equal(pos.unmatchedProceedsWei, 500n * SHARE_UNIT);
});

test("a full exit leaves zero cost-basis dust despite weighted-average rounding", () => {
  let pos = emptyPosition(WALLET, VAULT);
  // 3 wei-shares for 1 wei of cost — avgCostPerShareWei floors to 0.
  pos = applyFlow(pos, inc(3n, 1n, 1));
  pos = applyFlow(pos, dec(3n, 10n, 2));
  assert.equal(pos.sharesHeld, 0n);
  assert.equal(pos.costBasisWei, 0n, "a fully-exited cohort must never carry rounding dust forward");
});

test("events are reduced in ascending block order regardless of input order", () => {
  const events: FlowEvent[] = [
    dec(SHARE_UNIT, 5n * SHARE_UNIT, 3), // sell, applied last
    inc(SHARE_UNIT, SHARE_UNIT, 1), // buy 1 @ 1.0
    inc(SHARE_UNIT, 3n * SHARE_UNIT, 2), // buy 1 @ 3.0 -> avg 2.0
  ];
  const pos = reduceFlows(WALLET, VAULT, events);
  assert.equal(pos.sharesHeld, SHARE_UNIT);
  assert.equal(pos.realizedPnlWei, 3n * SHARE_UNIT); // 5.0 - 2.0 avg cost
});

test("a zero-share event is a safe no-op", () => {
  const pos = applyFlow(emptyPosition(WALLET, VAULT), inc(0n, SHARE_UNIT, 1));
  assert.equal(pos.sharesHeld, 0n);
  assert.equal(pos.costBasisWei, 0n);
  assert.equal(pos.eventCount, 0);
});

test("computeCohortPositions groups by wallet+vault independently and never mixes cohorts", () => {
  const WALLET2 = "0xBbBbBbBBBbbBBbBbBBbBBBBBbBBbBBbBBbBbBbBb";
  const VAULT2 = "0xC0C0C0C0c0C0c0C0c0c0C0C0c0c0c0C0c0c0C0c0";
  const rows = [
    { wallet: WALLET, vaultAddress: VAULT, event: inc(SHARE_UNIT, SHARE_UNIT, 1) },
    { wallet: WALLET, vaultAddress: VAULT, event: inc(SHARE_UNIT, 3n * SHARE_UNIT, 2) },
    { wallet: WALLET2, vaultAddress: VAULT, event: inc(SHARE_UNIT, 5n * SHARE_UNIT, 1) },
    { wallet: WALLET, vaultAddress: VAULT2, event: inc(SHARE_UNIT, 9n * SHARE_UNIT, 1) },
  ];
  const positions = computeCohortPositions(rows);
  assert.equal(positions.size, 3);

  const p1 = positions.get(cohortKey(WALLET, VAULT))!;
  assert.equal(p1.sharesHeld, 2n * SHARE_UNIT);
  assert.equal(avgCostPerShareWei(p1), 2n * SHARE_UNIT);

  const p2 = positions.get(cohortKey(WALLET2, VAULT))!;
  assert.equal(avgCostPerShareWei(p2), 5n * SHARE_UNIT);

  const p3 = positions.get(cohortKey(WALLET, VAULT2))!;
  assert.equal(avgCostPerShareWei(p3), 9n * SHARE_UNIT);
});

test("cohortKey is address-case-insensitive", () => {
  assert.equal(cohortKey(WALLET, VAULT), cohortKey(WALLET.toLowerCase(), VAULT.toUpperCase()));
});

test("navPerShareWei divides reserves correctly and never divides by zero supply", () => {
  assert.equal(navPerShareWei(10n * SHARE_UNIT, 5n * SHARE_UNIT), 2n * SHARE_UNIT);
  assert.equal(navPerShareWei(10n * SHARE_UNIT, 0n), 0n);
});

test("isTradingVolumeEvent excludes vault mint/burn and LP events, includes only AMM buy/sell", () => {
  assert.equal(isTradingVolumeEvent("buy"), true);
  assert.equal(isTradingVolumeEvent("sell"), true);
  assert.equal(isTradingVolumeEvent("deposit"), false);
  assert.equal(isTradingVolumeEvent("redeem"), false);
  assert.equal(isTradingVolumeEvent("add_lp"), false);
  assert.equal(isTradingVolumeEvent("remove_lp"), false);
});
