import assert from "node:assert/strict";
import test from "node:test";
import {
  CCS2L_RULE_ID,
  ccs2lParamsHash,
  parimutuelParamsHash,
  replayCommittedRound,
  settlementDescriptor,
  SettlementRuleMismatch,
  type CommittedCcs2LRound,
  type CommittedParimutuelRound,
} from "../../lib/casino/settlement-rules";
import { settleParimutuel, type Seat } from "../../lib/casino/economics";
import { DEFAULT_CCS2L_PARAMS, settleCcs2L, type Ccs2LSettlement } from "../../lib/casino/economics-ccs2l";
import { DEFAULT_PLAYTEST_POLICY } from "../../lib/playtest-room-core";
import { simulateIteration, initialSimulationState, type SimulationPolicy } from "../../lib/casino/simulation";

const SEATS: Seat[] = [
  { id: "a", stake: 4_000n, targetBps: 12_000n },
  { id: "b", stake: 6_000n, targetBps: 30_000n },
];

test("ccs-2l paramsHash is pinned to the Solidity convention byte-for-byte", () => {
  // These literals are asserted against contracts/lib/PlankCcs2LMath.sol in
  // test/contracts/PlankCcs2LSettlement.test.ts ("paramsHash matches the
  // registry convention"). Together the two pins bind TS and Solidity.
  assert.equal(CCS2L_RULE_ID, "0xcee375f888dd3a2ee6094d52174fc8c6ee0ca62cd11be35250e739528a4f3091");
  // v3: the hash now also binds maxVaultBonusBps/vaultBonusDecayWad (both 0n
  // in DEFAULT_CCS2L_PARAMS -- feature off) -- this literal necessarily
  // changed from the pre-v3 pin; re-verified against test/contracts/
  // PlankCcs2LSettlement.test.ts's own Solidity-side "paramsHash matches the
  // registry convention byte-for-byte" test, which passes with these SAME
  // two new fields added, over the SAME feature-off (0n, 0n) values.
  assert.equal(
    ccs2lParamsHash(DEFAULT_CCS2L_PARAMS),
    "0xc1d923dff6d91e7d56cc18393bdaaa42e1e6c5043e412230a37465c0e8bec1e5",
  );
});

test("ccs-2l v2 registers variant A only; other versions rejected (v1 lacks the actuarial rake cap)", () => {
  assert.throws(() => ccs2lParamsHash({ ...DEFAULT_CCS2L_PARAMS, playerWeight: "odds" }), RangeError);
  assert.throws(() => ccs2lParamsHash(DEFAULT_CCS2L_PARAMS, 1), RangeError);
  assert.throws(() => ccs2lParamsHash(DEFAULT_CCS2L_PARAMS, 3), RangeError);
  assert.throws(() => parimutuelParamsHash("pfss", 2), RangeError);
});

test("descriptors are deterministic and rule-distinct", () => {
  const pfss = settlementDescriptor("pfss");
  const ccs = settlementDescriptor("ccs-2l");
  assert.equal(pfss.rule, "pfss");
  assert.equal(pfss.version, 1);
  assert.match(pfss.paramsHash, /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual(pfss, settlementDescriptor("pfss"));
  assert.equal(ccs.paramsHash, ccs2lParamsHash(DEFAULT_CCS2L_PARAMS));
  assert.notEqual(pfss.paramsHash, settlementDescriptor("stake-only").paramsHash);
});

test("historical pfss rounds replay under pfss regardless of current defaults", () => {
  const record: CommittedParimutuelRound = {
    descriptor: settlementDescriptor("pfss"),
    inputs: { distributable: 9_550n, crashBps: 20_000n, seats: SEATS },
  };
  const replayed = replayCommittedRound(record);
  const direct = settleParimutuel("pfss", 9_550n, 20_000n, SEATS);
  assert.deepEqual(replayed, direct);
});

test("committed ccs-2l rounds replay under the recorded parameters", () => {
  const record: CommittedCcs2LRound = {
    descriptor: settlementDescriptor("ccs-2l"),
    inputs: { playerDistributable: 9_550n, seedH: 500n, crashBps: 20_000n, seats: SEATS, reserveAtLock: 100_000n },
  };
  const replayed = replayCommittedRound(record) as Ccs2LSettlement;
  const direct = settleCcs2L(9_550n, 500n, 20_000n, SEATS, 100_000n, DEFAULT_CCS2L_PARAMS);
  assert.deepEqual(replayed, direct);
  assert.equal(replayed.totalPlayerPaid, 9_550n);
  assert.equal(replayed.totalBonus + replayed.houseReturned, 500n);
});

test("tampered or drifted records are refused, never defaulted", () => {
  const record: CommittedCcs2LRound = {
    descriptor: { ...settlementDescriptor("ccs-2l"), params: { floorBps: "5000", playerWeight: "ln", houseCapBps: "1000", houseRakeCapBps: "5000" } },
    inputs: { playerDistributable: 9_550n, seedH: 500n, crashBps: 20_000n, seats: SEATS, reserveAtLock: 100_000n },
  };
  assert.throws(() => replayCommittedRound(record), SettlementRuleMismatch);
  const badVersion: CommittedParimutuelRound = {
    descriptor: { ...settlementDescriptor("pfss"), version: 2 },
    inputs: { distributable: 9_550n, crashBps: 20_000n, seats: SEATS },
  };
  assert.throws(() => replayCommittedRound(badVersion), SettlementRuleMismatch);
});

test("the public playtest defaults to the proven ccs-2l rule", () => {
  assert.equal(DEFAULT_PLAYTEST_POLICY.allocationRule, "ccs-2l");
  const policy: SimulationPolicy = { ...DEFAULT_PLAYTEST_POLICY, allocationRule: "ccs-2l" };
  const state = initialSimulationState(policy);
  const result = simulateIteration(state, policy, {
    players: SEATS.map((seat) => ({ ...seat, stake: seat.stake * 100n })),
    crashBps: 20_000n,
    lotteryOutcome: "none",
  });
  assert.ok(result.qualified);
  assert.ok(result.settlement);
  const settlement = result.settlement as Ccs2LSettlement;
  assert.equal(settlement.rule, "ccs-2l");
  // Both conservation identities hold inside the simulation dispatch too.
  assert.equal(settlement.totalPlayerPaid, settlement.playerDistributable);
  assert.equal(settlement.totalBonus + settlement.houseReturned, settlement.seedH);
});

test("settleParimutuel refuses the two-purse rule", () => {
  assert.throws(() => settleParimutuel("ccs-2l", 9_550n, 20_000n, SEATS), RangeError);
});

// ── RATIFICATION 2026-09-02: per-seat payout decomposition telemetry ──
// Every settled round's record must let the owner reconstruct floor part,
// performance part, and house bonus per seat for the adversarial-multiplayer
// evidence phase. The decomposition is additive reporting: it must sum
// exactly, wei-for-wei, and never perturb the payout arithmetic.
test("ccs-2l allocations expose an exact floor/performance/house decomposition", () => {
  const settled = settleCcs2L(9_550n, 500n, 20_000n, SEATS, 100_000n, DEFAULT_CCS2L_PARAMS);
  let floorSum = 0n;
  let perfSum = 0n;
  for (const allocation of settled.allocations) {
    assert.equal(allocation.floorPayout + allocation.performancePayout, allocation.playerPayout);
    assert.equal(allocation.playerPayout + allocation.houseBonus, allocation.payout);
    if (!allocation.survived) {
      assert.equal(allocation.floorPayout, 0n);
      assert.equal(allocation.performancePayout, 0n);
      assert.equal(allocation.houseBonus, 0n);
    }
    floorSum += allocation.floorPayout;
    perfSum += allocation.performancePayout;
  }
  assert.equal(floorSum + perfSum, settled.totalPlayerPaid);
  // Conservation identities are untouched by the added telemetry fields.
  assert.equal(settled.totalPlayerPaid, 9_550n);
  assert.equal(settled.totalBonus + settled.houseReturned, 500n);
});

test("all-bust ccs-2l rounds decompose to zero for every seat", () => {
  const bustSeats = SEATS.map((seat) => ({ ...seat, targetBps: 1_000_000n }));
  const settled = settleCcs2L(9_550n, 500n, 20_000n, bustSeats, 100_000n, DEFAULT_CCS2L_PARAMS);
  assert.equal(settled.allBust, true);
  for (const allocation of settled.allocations) {
    assert.equal(allocation.floorPayout, 0n);
    assert.equal(allocation.performancePayout, 0n);
    assert.equal(allocation.payout, 0n);
  }
});
