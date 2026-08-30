import assert from "node:assert/strict";
import test from "node:test";
import { BOT_PROFILE_NAMES, botProfile, botRoundCommitment, weightedTicketWinner } from "../../lib/playtest-bots";

test("every synthetic profile produces deterministic bounded commitments", () => {
  for (const preset of BOT_PROFILE_NAMES) {
    const profile = botProfile(preset, 1_000_000n);
    const input = { roomId: "room", roundId: 7n, botId: `bot-${preset}`, bankroll: 1_000_000n, minimumStake: 100n, profile };
    const a = botRoundCommitment(input);
    const b = botRoundCommitment(input);
    assert.deepEqual(a, b);
    assert.ok(a && a.stake >= 100n && a.stake <= 1_000_000n);
    assert.ok(a && a.targetBps >= BigInt(profile.targetMinBps) && a.targetBps <= BigInt(profile.targetMaxBps));
  }
});

test("Powerboard ticket selection is deterministic, bounded, and ignores zero weight", () => {
  const tickets = [{ id: "human", weight: 10n }, { id: "cpu", weight: 30n }, { id: "zero", weight: 0n }];
  const a = weightedTicketWinner(tickets, "committed-epoch-entropy");
  const b = weightedTicketWinner(tickets, "committed-epoch-entropy");
  assert.deepEqual(a, b);
  assert.ok(a?.id === "human" || a?.id === "cpu");
  assert.equal(weightedTicketWinner([], "entropy"), null);
});

test("disabled and ruined bots sit out without inventing credit", () => {
  const disabled = botProfile("balanced", 1_000n, { enabled: false });
  assert.equal(botRoundCommitment({ roomId: "r", roundId: 1n, botId: "b", bankroll: 1_000n, minimumStake: 100n, profile: disabled }), null);
  const active = botProfile("balanced", 1_000n);
  assert.equal(botRoundCommitment({ roomId: "r", roundId: 1n, botId: "b", bankroll: 99n, minimumStake: 100n, profile: active }), null);
});

test("behavioral profiles react to gains and losses only through bankroll history", () => {
  const house = botProfile("house-money", 1_000_000n);
  const base = botRoundCommitment({ roomId: "r", roundId: 2n, botId: "h", bankroll: 1_000_000n, minimumStake: 100n, profile: house })!;
  const winning = botRoundCommitment({ roomId: "r", roundId: 2n, botId: "h", bankroll: 1_500_000n, minimumStake: 100n, profile: house })!;
  assert.ok(winning.stake * 1_000_000n > base.stake * 1_500_000n);
});
