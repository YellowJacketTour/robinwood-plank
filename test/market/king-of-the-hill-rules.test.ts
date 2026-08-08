import assert from "node:assert/strict";
import test from "node:test";
import {
  applyCandidateSale,
  finalizeIfDue,
  GRACE_WINDOW_MS,
  EXTENSION_MS,
  seedExistingSale,
  type KothSale,
  type KothState,
} from "../../lib/market/king-of-the-hill-rules";

const DEADLINE = Date.parse("2026-08-08T09:20:00Z");

function sale(priceWei: string, txHash = "0xsale"): KothSale {
  return { txHash, tokenId: "1", wallet: "0xabc", priceWei };
}

function initial(deadlineMs = DEADLINE): KothState {
  return { deadlineMs, leadingSale: null, winnerFinalizedAtMs: null, winnerSale: null };
}

test("seeding an existing sale establishes the starting leader without extending the deadline", () => {
  const state = initial();
  const seeded = seedExistingSale(state, sale("5000", "0xexisting"));
  assert.equal(seeded.leadingSale?.txHash, "0xexisting");
  assert.equal(seeded.deadlineMs, DEADLINE);
});

test("seeding never replaces an existing leader or finalized winner", () => {
  const leader = sale("5000", "0xleader");
  const state = { ...initial(), leadingSale: leader };
  assert.equal(seedExistingSale(state, sale("9000", "0xother")), state);

  const finalized = {
    ...initial(),
    winnerFinalizedAtMs: DEADLINE + 1,
    winnerSale: leader,
  };
  assert.equal(seedExistingSale(finalized, sale("9000", "0xother")), finalized);
});

test("a new highest sale WITHIN the 2-hour grace window extends the deadline by exactly 4 hours", () => {
  const now = DEADLINE - 30 * 60 * 1000; // 30 minutes before deadline, inside the 2h window
  const state = initial();
  const next = applyCandidateSale(state, sale("1000"), now);
  assert.equal(next.leadingSale?.priceWei, "1000");
  assert.equal(next.deadlineMs, Math.max(now, DEADLINE) + EXTENSION_MS);
  assert.equal(next.deadlineMs, DEADLINE + EXTENSION_MS, "anchored off the old deadline, not off now");
});

test("a new highest sale exactly at the 2-hour boundary still qualifies (inclusive)", () => {
  const now = DEADLINE - GRACE_WINDOW_MS;
  const state = initial();
  const next = applyCandidateSale(state, sale("1000"), now);
  assert.equal(next.deadlineMs, DEADLINE + EXTENSION_MS);
});

test("a new highest sale OUTSIDE the 2-hour window (but before the deadline) records the new leader but does NOT extend", () => {
  const now = DEADLINE - GRACE_WINDOW_MS - 60_000; // 1 minute earlier than the window opens
  const state = initial();
  const next = applyCandidateSale(state, sale("1000"), now);
  assert.equal(next.leadingSale?.priceWei, "1000", "still the new record");
  assert.equal(next.deadlineMs, DEADLINE, "deadline untouched");
});

test("a sale that does not beat the current record changes nothing, even inside the grace window", () => {
  const state = { ...initial(), leadingSale: sale("5000", "0xleader") };
  const now = DEADLINE - 10_000;
  const tie = applyCandidateSale(state, sale("5000", "0xtie"), now);
  assert.equal(tie, state, "tie is not a NEW largest sale");
  const lower = applyCandidateSale(state, sale("4999", "0xlower"), now);
  assert.equal(lower, state);
});

test("once the deadline passes with no qualifying extension, the round finalizes exactly once and permanently", () => {
  const leader = sale("7000", "0xleader");
  const state: KothState = { deadlineMs: DEADLINE, leadingSale: leader, winnerFinalizedAtMs: null, winnerSale: null };
  const now = DEADLINE + 1;
  const finalized = finalizeIfDue(state, now);
  assert.equal(finalized.winnerFinalizedAtMs, now);
  assert.deepEqual(finalized.winnerSale, leader);

  // Calling finalize again (lazy check-on-read can run many times) is a no-op.
  const again = finalizeIfDue(finalized, now + 10_000);
  assert.equal(again, finalized);
});

test("a later, larger sale arriving AFTER finalization never changes the recorded winner", () => {
  const leader = sale("7000", "0xleader");
  const state: KothState = { deadlineMs: DEADLINE, leadingSale: leader, winnerFinalizedAtMs: null, winnerSale: null };
  const finalized = finalizeIfDue(state, DEADLINE + 1);

  const attack = applyCandidateSale(finalized, sale("999999999", "0xattacker"), DEADLINE + 2);
  assert.equal(attack, finalized, "finalized state is immutable");
  assert.deepEqual(attack.winnerSale, leader);
});

test("a sale that arrives after the deadline but BEFORE finalization runs cannot revive the round", () => {
  // finalizeIfDue has not been called yet (e.g. two writers race), but the
  // rule for candidate sales must independently refuse anything past the
  // deadline — the round being "over" does not depend on finalize having
  // already executed.
  const leader = sale("7000", "0xleader");
  const state: KothState = { deadlineMs: DEADLINE, leadingSale: leader, winnerFinalizedAtMs: null, winnerSale: null };
  const late = applyCandidateSale(state, sale("999999999", "0xlate"), DEADLINE + 5_000);
  assert.equal(late, state);
});

test("not gameable by rapid tiny-increment sales right at the boundary: each must strictly beat the record, and every accepted extension grants a fixed 4h regardless of how many attempts preceded it", () => {
  let state = initial();
  const start = DEADLINE - 1_000; // 1 second before deadline, inside grace window
  // Spam ten tiny increments 1ms apart, right at the boundary.
  for (let i = 0; i < 10; i++) {
    const now = start + i;
    const price = String(1000 + i); // each strictly higher than the last by 1 wei
    state = applyCandidateSale(state, sale(price, `0xspam${i}`), now);
  }
  assert.equal(state.leadingSale?.priceWei, "1009", "only the true highest survives");
  // Only the FIRST improving sale actually extends anything: the moment it
  // does, the new deadline is a full 4h out, so every subsequent tiny-spam
  // increment 1ms later is no longer "within 2 hours of the deadline" and
  // cannot re-extend — this is exactly what makes rapid boundary spam
  // pointless rather than a way to compound extensions.
  assert.equal(state.deadlineMs, DEADLINE + EXTENSION_MS);

  // A duplicate/non-improving resubmission at the very same instant does nothing.
  const before = state;
  state = applyCandidateSale(state, sale("1009", "0xduplicate"), start + 9);
  assert.equal(state, before);

  // An attacker cannot exploit floating deadline math by sending a sale
  // exactly ON the (now-extended) deadline and then another 1ms later hoping
  // the second one is silently accepted after "the round should be over":
  // the second is simply evaluated against the same well-defined rule.
  const atDeadline = applyCandidateSale(state, sale("2000", "0xexact"), state.deadlineMs);
  assert.equal(atDeadline.leadingSale?.priceWei, "2000");
  const afterDeadline = applyCandidateSale(atDeadline, sale("3000", "0xafter"), atDeadline.deadlineMs + 1);
  assert.equal(afterDeadline, atDeadline, "one ms past deadline is refused, no exception");
});

test("finalize does nothing while the deadline has not yet passed", () => {
  const state = initial();
  const same = finalizeIfDue(state, DEADLINE - 1);
  assert.equal(same, state);
  const atDeadline = finalizeIfDue(state, DEADLINE);
  assert.equal(atDeadline, state, "at the deadline itself, extension is still possible — not yet over");
});

test("finalizing a round with no sales ever recorded finalizes with a null winner (round simply had no entrants)", () => {
  const state = initial();
  const finalized = finalizeIfDue(state, DEADLINE + 1);
  assert.equal(finalized.winnerFinalizedAtMs, DEADLINE + 1);
  assert.equal(finalized.winnerSale, null);
});
