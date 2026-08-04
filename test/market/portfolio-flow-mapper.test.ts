import assert from "node:assert/strict";
import test from "node:test";
import {
  vaultEventToFlowRow,
  vaultEventsToFlowRows,
  type NavAtBlockResolver,
} from "../../lib/market/portfolio-flow-mapper";
import { SHARE_UNIT, isTradingVolumeEvent } from "../../lib/market/portfolio-pnl";
import type { VaultTradeEvent, VaultTradeKind } from "../../lib/market/vault-activity";

const WALLET = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const VAULT = "0xb2019fd4ca24502e812c0c73b751fa49979bf708";

function baseEvent(kind: VaultTradeKind, overrides: Partial<VaultTradeEvent> = {}): VaultTradeEvent {
  return {
    kind,
    address: WALLET,
    ethWei: null,
    sharesWei: null,
    tokenId: null,
    txHash: "0xabc",
    blockNumber: 100,
    logIndex: 0,
    timestamp: null,
    vaultAddress: VAULT,
    ...overrides,
  };
}

const flatNav: NavAtBlockResolver = async () => SHARE_UNIT; // 1:1 NAV
const failingNav: NavAtBlockResolver = async () => {
  throw new Error("should not be called for buy/sell");
};

test("buy maps to an increase using the event's real ETH amount, no NAV lookup", async () => {
  const event = baseEvent("buy", { ethWei: (2n * SHARE_UNIT).toString(), sharesWei: SHARE_UNIT.toString() });
  const row = await vaultEventToFlowRow(event, failingNav);
  assert.ok(row);
  assert.equal(row!.event.kind, "increase");
  assert.equal(row!.event.valueWei, 2n * SHARE_UNIT);
  assert.equal(row!.event.sharesWei, SHARE_UNIT);
  assert.equal(row!.event.source, "trade");
  assert.equal(row!.wallet, WALLET.toLowerCase());
  assert.equal(row!.vaultAddress, VAULT.toLowerCase());
});

test("sell maps to a decrease using the event's real ETH amount, no NAV lookup", async () => {
  const event = baseEvent("sell", { ethWei: SHARE_UNIT.toString(), sharesWei: SHARE_UNIT.toString() });
  const row = await vaultEventToFlowRow(event, failingNav);
  assert.ok(row);
  assert.equal(row!.event.kind, "decrease");
  assert.equal(row!.event.valueWei, SHARE_UNIT);
});

test("deposit maps to an increase valued at navPerShare * sharesWei (NAV lookup used)", async () => {
  const event = baseEvent("deposit", { tokenId: "42" });
  let queriedBlock: number | null = null;
  const nav: NavAtBlockResolver = async (vault, block) => {
    queriedBlock = block;
    assert.equal(vault, VAULT);
    return 3n * SHARE_UNIT; // 3 ETH per share
  };
  const row = await vaultEventToFlowRow(event, nav);
  assert.ok(row);
  assert.equal(row!.event.kind, "increase");
  assert.equal(row!.event.source, "vault");
  assert.equal(row!.event.sharesWei, SHARE_UNIT); // documented approximation: 1.0 share per NFT
  assert.equal(row!.event.valueWei, 3n * SHARE_UNIT); // 1.0 share * 3.0 ETH/share
  assert.equal(queriedBlock, 100);
});

test("redeem maps to a decrease valued at navPerShare * sharesWei", async () => {
  const event = baseEvent("redeem", { tokenId: "7" });
  const row = await vaultEventToFlowRow(event, flatNav);
  assert.ok(row);
  assert.equal(row!.event.kind, "decrease");
  assert.equal(row!.event.valueWei, SHARE_UNIT);
});

test("add_lp and remove_lp are excluded (null), matching isTradingVolumeEvent's non-trading bucket", async () => {
  assert.equal(isTradingVolumeEvent("add_lp"), false);
  assert.equal(isTradingVolumeEvent("remove_lp"), false);
  const addLp = await vaultEventToFlowRow(baseEvent("add_lp", { ethWei: "1", sharesWei: "1" }), failingNav);
  const removeLp = await vaultEventToFlowRow(baseEvent("remove_lp", { ethWei: "1", sharesWei: "1" }), failingNav);
  assert.equal(addLp, null);
  assert.equal(removeLp, null);
});

test("buy/sell classification agrees with isTradingVolumeEvent (increase/decrease vs trading-volume)", async () => {
  for (const kind of ["buy", "sell"] as const) {
    assert.equal(isTradingVolumeEvent(kind), true);
    const event = baseEvent(kind, { ethWei: SHARE_UNIT.toString(), sharesWei: SHARE_UNIT.toString() });
    const row = await vaultEventToFlowRow(event, failingNav);
    assert.ok(row, `${kind} should produce a row`);
  }
  for (const kind of ["deposit", "redeem"] as const) {
    assert.equal(isTradingVolumeEvent(kind), false);
    const event = baseEvent(kind);
    const row = await vaultEventToFlowRow(event, flatNav);
    assert.ok(row, `${kind} should still produce a cost-basis row (it's just not trading volume)`);
  }
});

test("malformed buy/sell (missing ethWei or sharesWei) is dropped rather than fabricated", async () => {
  const missingEth = baseEvent("buy", { ethWei: null, sharesWei: SHARE_UNIT.toString() });
  const missingShares = baseEvent("sell", { ethWei: SHARE_UNIT.toString(), sharesWei: null });
  assert.equal(await vaultEventToFlowRow(missingEth, failingNav), null);
  assert.equal(await vaultEventToFlowRow(missingShares, failingNav), null);
});

test("events with no wallet or vault address are dropped", async () => {
  const noWallet = baseEvent("buy", { address: "", ethWei: "1", sharesWei: "1" });
  const noVault = baseEvent("buy", { vaultAddress: undefined, ethWei: "1", sharesWei: "1" });
  assert.equal(await vaultEventToFlowRow(noWallet, failingNav), null);
  assert.equal(await vaultEventToFlowRow(noVault, failingNav), null);
});

test("vaultEventsToFlowRows preserves order and drops non-participating events", async () => {
  const events: VaultTradeEvent[] = [
    baseEvent("buy", { blockNumber: 1, ethWei: SHARE_UNIT.toString(), sharesWei: SHARE_UNIT.toString() }),
    baseEvent("add_lp", { blockNumber: 2, ethWei: "1", sharesWei: "1" }),
    baseEvent("deposit", { blockNumber: 3, tokenId: "1" }),
  ];
  const rows = await vaultEventsToFlowRows(events, flatNav);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].event.blockNumber, 1);
  assert.equal(rows[1].event.blockNumber, 3);
});
