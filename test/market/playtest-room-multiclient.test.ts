import assert from "node:assert/strict";
import test from "node:test";
import {
  deriveRoundClock, msToReachMultiplierBps, multiplierBpsAtMs,
} from "../../lib/playtest-live-shared";
import {
  bettingRoundId, crashDurationMs, effectiveSettlementTarget, multiplierAt,
} from "../../lib/playtest-room-core";

/**
 * Deterministic in-memory model of the authoritative room protocol, driven by
 * a fake clock. It reuses the SAME pure invariants the SQL layer enforces
 * (bettingRoundId, multiplierAt, crashDurationMs, effectiveSettlementTarget,
 * duplicate-commandId idempotency, fail-closed late locks, pre-roll launch
 * scheduling, 30s intermission) so multi-client sequencing can be exercised
 * without PostgreSQL. Any drift between this model and lib/playtest-rooms.ts
 * is itself a finding.
 */
const INTERMISSION_MS = 30_000;
const PREROLL_MS = 1_500;

type Seat = {
  stake: bigint; requestedTargetBps: bigint; acceptedTargetBps: bigint | null;
  autoLockEnabled: boolean; settledTarget?: bigint; survived?: boolean;
};

class FakeRoom {
  phase: "lobby" | "running" | "settled" = "lobby";
  currentRound = 0n;
  version = 1n;
  startedAtMs: number | null = null;
  crashAtMs: number | null = null;
  settledAtMs: number | null = null;
  crashBps: bigint | null = null;
  seats = new Map<string, Map<string, Seat>>(); // roundId -> userId -> seat
  commands = new Set<string>();

  private roundSeats(roundId: bigint): Map<string, Seat> {
    const key = roundId.toString();
    if (!this.seats.has(key)) this.seats.set(key, new Map());
    return this.seats.get(key)!;
  }

  bet(userId: string, commandId: string, stake: bigint, targetBps: bigint, autoLockEnabled: boolean, nowMs: number) {
    void nowMs;
    if (this.commands.has(commandId)) return { duplicate: true };
    if (this.phase === "running") throw new Error("BETTING_CLOSED");
    this.commands.add(commandId);
    const roundId = bettingRoundId(this.phase, this.currentRound);
    this.roundSeats(roundId).set(userId, { stake, requestedTargetBps: targetBps, acceptedTargetBps: null, autoLockEnabled });
    if (this.phase === "lobby") this.currentRound = roundId;
    this.version += 1n;
    return { duplicate: false, roundId };
  }

  launch(commandId: string, nowMs: number, automated: boolean, crashBps: bigint) {
    if (this.commands.has(commandId)) return { duplicate: true };
    if (this.phase === "running") throw new Error("NOT_READY");
    if (automated) {
      if (this.phase !== "settled" || this.settledAtMs === null) throw new Error("NOT_READY");
      if (nowMs < this.settledAtMs + INTERMISSION_MS) throw new Error("INTERMISSION_ACTIVE");
    }
    this.commands.add(commandId);
    const launchRound = this.phase === "settled" ? this.currentRound + 1n : this.currentRound;
    if (this.roundSeats(launchRound).size < 2) throw new Error("MINIMUM_PLAYERS");
    this.currentRound = launchRound;
    this.phase = "running";
    this.crashBps = crashBps;
    this.startedAtMs = nowMs + PREROLL_MS;
    this.crashAtMs = this.startedAtMs + crashDurationMs(crashBps);
    this.settledAtMs = null;
    this.version += 1n;
    return { duplicate: false };
  }

  lock(userId: string, commandId: string, nowMs: number) {
    if (this.commands.has(commandId)) return { duplicate: true };
    if (this.phase !== "running" || this.startedAtMs === null || this.crashAtMs === null) throw new Error("NOT_RUNNING");
    if (nowMs >= this.crashAtMs) throw new Error("TOO_LATE");
    this.commands.add(commandId);
    const accepted = multiplierAt(this.startedAtMs, nowMs);
    if (accepted < 10_100n) throw new Error("TOO_EARLY");
    const seat = this.roundSeats(this.currentRound).get(userId);
    if (!seat || seat.acceptedTargetBps !== null) throw new Error("NO_ACTIVE_BET");
    if (seat.autoLockEnabled && accepted >= seat.requestedTargetBps) throw new Error("AUTO_TARGET_EXECUTED");
    seat.acceptedTargetBps = accepted;
    this.version += 1n;
    return { duplicate: false, accepted };
  }

  settle(commandId: string, nowMs: number) {
    if (this.commands.has(commandId)) return { duplicate: true };
    if (this.phase !== "running" || this.crashAtMs === null || this.crashBps === null) throw new Error("NOT_RUNNING");
    if (nowMs < this.crashAtMs) throw new Error("ROUND_ACTIVE");
    this.commands.add(commandId);
    for (const seat of this.roundSeats(this.currentRound).values()) {
      seat.settledTarget = effectiveSettlementTarget(this.crashBps, seat.requestedTargetBps, seat.acceptedTargetBps, seat.autoLockEnabled);
      seat.survived = seat.settledTarget <= this.crashBps;
    }
    this.phase = "settled";
    this.settledAtMs = nowMs;
    this.version += 1n;
    return { duplicate: false };
  }

  snapshot(serverNowMs: number) {
    return {
      phase: this.phase,
      startedAtMs: this.startedAtMs,
      crashAtMs: this.phase === "settled" ? this.crashAtMs : null,
      settledAtMs: this.settledAtMs,
      nextLaunchAtMs: this.settledAtMs === null ? null : this.settledAtMs + INTERMISSION_MS,
      serverNowMs,
    } as const;
  }
}

test("3 clients, 5 sequential automatic rounds: one shared round id, no early launch, no double-bet", () => {
  const room = new FakeRoom();
  const clients = ["alice", "bob", "cara"];
  let now = 1_000_000;
  let uid = 0;
  const cmd = () => `cmd-${uid += 1}`;

  for (let round = 1; round <= 5; round += 1) {
    // Every client commits; alternating commit order must land in ONE round.
    const roundIds = clients.map((c, i) =>
      room.bet(c, cmd(), 10_000n, BigInt(15_000 + i * 5_000), i % 2 === 0, now).roundId);
    assert.ok(roundIds.every((id) => id === roundIds[0]), "all clients join the same betting round");
    assert.equal(roundIds[0], BigInt(round), "rounds advance exactly once per settlement");

    // A duplicate-click retry of the same commandId is a no-op, not a double bet.
    const dupId = cmd();
    room.bet("alice", dupId, 5_000n, 12_000n, false, now);
    assert.deepEqual(room.bet("alice", dupId, 5_000n, 12_000n, false, now), { duplicate: true });
    assert.equal(room.seats.get(String(round))!.size, 3, "retries never create extra seats");

    // Launch: server schedules startedAt in the future (pre-roll).
    room.launch(cmd(), now, round > 1, room.crashBps === null ? 20_000n : 25_000n);
    const startedAt = room.startedAtMs!;
    assert.ok(startedAt > now, "authoritative launch timestamp is in the future at launch time");

    // While the countdown shows a positive number, the derived view is never
    // a flight — the round cannot visibly launch early.
    for (const dt of [0, 500, PREROLL_MS - 1]) {
      const view = deriveRoundClock(room.snapshot(now + dt));
      assert.equal(view.kind, "countdown", `pre-roll +${dt}ms stays a countdown`);
    }
    assert.equal(deriveRoundClock(room.snapshot(startedAt)).kind, "flight");

    // Betting is closed during flight (stale client state cannot mutate it).
    assert.throws(() => room.bet("bob", cmd(), 1_000n, 15_000n, false, startedAt + 10), /BETTING_CLOSED/);

    // Boundary timing: a lock at crashAt-1ms is accepted at the true live
    // multiplier; a lock at crashAt fails closed.
    const crashAt = room.crashAtMs!;
    if (round === 1) {
      const early = room.lock("bob", cmd(), crashAt - 1);
      assert.ok(!early.duplicate && early.accepted! <= room.crashBps!);
      assert.throws(() => room.lock("cara", cmd(), crashAt), /TOO_LATE|AUTO_TARGET_EXECUTED/);
    }

    // Settlement cannot happen before the committed crash instant.
    assert.throws(() => room.settle(cmd(), crashAt - 1), /ROUND_ACTIVE/);
    room.settle(cmd(), crashAt + 20);
    now = crashAt + 20;

    // Manual lock can never have overwritten a reached auto target.
    for (const seat of room.seats.get(String(round))!.values()) {
      if (seat.autoLockEnabled && seat.requestedTargetBps <= room.crashBps!) {
        assert.ok(seat.settledTarget! <= seat.requestedTargetBps, "auto target is a ceiling");
      }
    }

    // Automatic continuation with no host: launching during the intermission
    // fails closed; only after nextLaunchAt may the keeper relaunch.
    assert.throws(() => room.launch(cmd(), now + INTERMISSION_MS - 1, true, 20_000n), /INTERMISSION_ACTIVE/);
    now += INTERMISSION_MS + 5;

    // Refresh mid-intermission: a reconnecting client derives the exact same
    // countdown from the snapshot alone (no local carry-over state).
    const view = deriveRoundClock(room.snapshot(now - 5));
    assert.equal(view.kind, "intermission");
  }
  assert.equal(room.currentRound, 5n);
});

test("a single participant's commitment does not advance the round for others", () => {
  const room = new FakeRoom();
  let now = 500_000;
  room.bet("alice", "a1", 1_000n, 20_000n, false, now);
  room.bet("bob", "b1", 1_000n, 20_000n, false, now);
  room.launch("l1", now, false, 30_000n);
  room.settle("s1", room.crashAtMs!);
  now = room.crashAtMs! + 1;
  // After settlement the first commit opens round 2 …
  assert.equal(room.bet("alice", "a2", 1_000n, 20_000n, false, now).roundId, 2n);
  // … and EVERY later commit joins that same round 2 instead of leapfrogging.
  assert.equal(room.bet("bob", "b2", 1_000n, 20_000n, false, now).roundId, 2n);
  assert.equal(room.bet("cara", "c2", 1_000n, 20_000n, false, now).roundId, 2n);
  assert.equal(room.currentRound, 1n, "the visible settled round is untouched until launch");
});

test("locked commitment presentation: accepted lock equals the live law at the accepted instant", () => {
  const room = new FakeRoom();
  const now = 2_000_000;
  room.bet("alice", "a1", 1_000n, 990_000n, false, now);
  room.bet("bob", "b1", 1_000n, 990_000n, false, now);
  room.launch("l1", now, false, 100_000n);
  const at = room.startedAtMs! + 4_000;
  const { accepted } = room.lock("alice", "la", at);
  assert.equal(accepted, BigInt(multiplierBpsAtMs(4_000)), "lock is priced by the shared M(t)");
  // Idempotent retry of the same lock command.
  assert.deepEqual(room.lock("alice", "la", at + 100), { duplicate: true });
  // A second manual lock for the same seat/round fails closed.
  assert.throws(() => room.lock("alice", "la2", at + 200), /NO_ACTIVE_BET/);
});

// ── Auto-lock amendment contract (the "turned auto-lock off but 2.0x still
// fired" bug). The committed auto target is part of the bet; disabling it is
// only possible while commitments are open, as a REAL re-commit -- and after
// launch the commitment is immutable and executes exactly as committed. ──

test("pre-launch auto-lock disarm re-commits the seat; no auto target fires; a later manual lock stands", () => {
  const room = new FakeRoom();
  let now = 3_000_000;
  room.bet("owner", "o1", 10_000n, 20_000n, true, now); // auto 2.0x armed
  room.bet("bob", "b1", 10_000n, 20_000n, false, now);
  // The disarm: same seat, same stake/target, autoLockEnabled false.
  room.bet("owner", "o2", 10_000n, 20_000n, false, now + 10);
  const seat = room.seats.get("1")!.get("owner")!;
  assert.equal(seat.autoLockEnabled, false, "server state must show the auto target disarmed");
  room.launch("l1", now + 100, false, 40_000n); // crashes at 4.0x
  // The flight passes 2.0x: nothing auto-fires (the seat is disarmed) and a
  // LATER manual lock at ~2.5x is accepted -- exactly what the owner tried.
  const at25 = room.startedAtMs! + msToReachMultiplierBps(25_000);
  const { accepted } = room.lock("owner", "lo", at25);
  assert.ok(accepted >= 25_000n, "manual lock accepted after the old auto altitude");
  room.settle("s1", room.crashAtMs!);
  assert.equal(seat.settledTarget, accepted, "settlement uses the ACCEPTED manual lock only");
  assert.equal(seat.survived, true);
  assert.notEqual(seat.settledTarget, 20_000n, "the disarmed 2.0x auto target must NOT execute");
});

test("post-launch auto-lock change is impossible; the armed target executes; a later manual lock fails closed", () => {
  const room = new FakeRoom();
  const now = 4_000_000;
  room.bet("owner", "o1", 10_000n, 20_000n, true, now); // auto 2.0x armed
  room.bet("bob", "b1", 10_000n, 20_000n, false, now);
  room.launch("l1", now + 100, false, 40_000n);
  // Committed is committed: no amendment path exists once running.
  assert.throws(() => room.bet("owner", "o2", 10_000n, 20_000n, false, room.startedAtMs! + 5), /BETTING_CLOSED/);
  const seat = room.seats.get("1")!.get("owner")!;
  assert.equal(seat.autoLockEnabled, true, "server truth stays ARMED -- the UI must show it armed");
  // Once the live law crosses the armed target, manual lock is already dead.
  const past = room.startedAtMs! + msToReachMultiplierBps(20_000) + 5;
  assert.throws(() => room.lock("owner", "lo", past), /AUTO_TARGET_EXECUTED/);
  room.settle("s1", room.crashAtMs!);
  assert.equal(seat.settledTarget, 20_000n, "settlement executes the committed 2.0x auto target exactly");
  assert.equal(seat.survived, true);
});
