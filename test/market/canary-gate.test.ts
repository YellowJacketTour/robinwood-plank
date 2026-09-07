import assert from "node:assert/strict";
import test from "node:test";
import {
  canaryGateResponse,
  fungibleAmountWei,
  weiToUsdNotional,
} from "../../lib/market/multichain/trading/canary-limits";

/**
 * AUDIT lens 3 D7 (2026-09-06): the pure decision layer every gated route
 * (fulfillment-data, offer-fulfillment-data, submit-offer, floor-listings)
 * shares. The Postgres-backed cap arithmetic itself is covered by
 * test/market/canary-limits.test.ts; this file covers the mapping from a
 * canary result to the 429/503 JSON the client sees, and the two pure
 * helpers that turn a Seaport order into a USD notional.
 */

test("canary gate: allowed -> null (route proceeds)", () => {
  assert.equal(canaryGateResponse({ allowed: true }), null);
});

test("canary gate: a cap breach is a 429 CANARY_LIMIT with the reason and a retry hint", () => {
  const out = canaryGateResponse({ allowed: false, reason: "per-wallet 24h cap exceeded: $190.00 + $20 > $200" });
  assert.ok(out);
  assert.equal(out.status, 429);
  assert.equal(out.body.error, "CANARY_LIMIT");
  assert.match(out.body.message, /per-wallet 24h cap exceeded/);
  assert.ok((out.body.retryAfterSec ?? 0) > 0);
  for (const reason of ["per-trade cap exceeded: $80 > $50", "global 24h cap exceeded: ...", "per-venue 24h cap exceeded (opensea/eth-mainnet): ...", "invalid usd_notional", "usd price unavailable for this chain's currency"]) {
    assert.equal(canaryGateResponse({ allowed: false, reason })?.status, 429, reason);
  }
});

test("canary gate: kill switch off / ledger unavailable is a 503 FOREIGN_TRADE_DISABLED, not a per-wallet limit", () => {
  for (const reason of ["canary disabled", "canary ledger unavailable (no Postgres config)"]) {
    const out = canaryGateResponse({ allowed: false, reason });
    assert.ok(out);
    assert.equal(out.status, 503, reason);
    assert.equal(out.body.error, "FOREIGN_TRADE_DISABLED");
    assert.equal(out.body.retryAfterSec, undefined);
  }
});

test("fungibleAmountWei sums only native (0) and ERC-20 (1) items, ignoring NFTs", () => {
  const items = [
    { itemType: 0, startAmount: "1000" },
    { itemType: "1", startAmount: "250" },
    { itemType: 2, startAmount: "1" }, // ERC721
    { itemType: 4, startAmount: "1" }, // ERC721_WITH_CRITERIA
  ];
  assert.equal(fungibleAmountWei(items), BigInt(1250));
  assert.equal(fungibleAmountWei([]), BigInt(0));
});

test("weiToUsdNotional keeps sub-dollar precision and matches wei * price", () => {
  const oneEth = BigInt(10) ** BigInt(18);
  assert.equal(weiToUsdNotional(oneEth, 2500), 2500);
  assert.equal(weiToUsdNotional(oneEth / BigInt(1000), 2500), 2.5); // 0.001 ETH
  assert.equal(weiToUsdNotional(BigInt(1), 2500), 0); // dust rounds to 0, which the cap treats as invalid -> blocked
  assert.equal(weiToUsdNotional(oneEth * BigInt(3), 0.5), 1.5);
});
