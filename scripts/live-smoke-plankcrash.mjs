#!/usr/bin/env node
/**
 * Post-deploy live smoke check for PlankCrash playtest rooms.
 *
 * READ-ONLY: it only calls health/session/snapshot/updates endpoints and
 * verifies the published timing/geometry invariants over N automatic rounds.
 * It never places bets, locks, launches, or settles.
 *
 * Usage:
 *   node scripts/live-smoke-plankcrash.mjs \
 *     --base https://example.com \
 *     --room <roomId> \
 *     --cookie "plank_playtest_session=..." \
 *     [--rounds 3] [--timeout-min 15]
 *
 * The cookie must belong to a playtest identity that is already a member of
 * the observed room. Exit code 0 = all invariants held; 1 = a violation or
 * an operational failure.
 */

const args = Object.fromEntries(
  process.argv.slice(2).reduce((pairs, part, index, all) => {
    if (part.startsWith("--")) pairs.push([part.slice(2), all[index + 1] ?? "true"]);
    return pairs;
  }, []),
);
const BASE = (args.base ?? "").replace(/\/$/, "");
const ROOM = args.room;
const COOKIE = args.cookie ?? "";
const ROUNDS = Number(args.rounds ?? 3);
const TIMEOUT_MS = Number(args["timeout-min"] ?? 15) * 60_000;
if (!BASE || !ROOM) {
  console.error("Required: --base <url> --room <roomId> [--cookie <session cookie>]");
  process.exit(1);
}

const failures = [];
const note = (ok, label, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures.push(label);
};

async function get(path) {
  const started = performance.now();
  const response = await fetch(`${BASE}${path}`, {
    headers: { cookie: COOKIE, accept: "application/json" },
    redirect: "manual",
  });
  const rtt = performance.now() - started;
  const body = await response.json().catch(() => null);
  return { status: response.status, body, rtt };
}

// ── 1. health / version ───────────────────────────────────────────────────
const health = await get("/api/health");
note(health.status === 200, "health endpoint returns 200", `status ${health.status}`);
if (health.body?.version || health.body?.commit) {
  console.log(`      version: ${JSON.stringify(health.body.version ?? health.body.commit)}`);
}

// ── 2. observe N automatic rounds via the published room state ────────────
const GROWTH = 0.22;
const mBps = (ms) => Math.floor(10_000 * Math.exp(GROWTH * Math.max(0, ms) / 1_000));

let after = "-1";
let observedSettles = 0;
let lastSnapshot = null;
let prevRound = null;
const deadline = Date.now() + TIMEOUT_MS;

while (observedSettles < ROUNDS && Date.now() < deadline) {
  const result = await get(`/api/playtest/rooms/${ROOM}/updates?after=${encodeURIComponent(after)}`);
  if (result.status !== 200) {
    note(false, "updates endpoint reachable", `status ${result.status}`);
    break;
  }
  const serverNow = Date.parse(result.body.snapshot?.serverNow ?? result.body.serverNow ?? "");
  const snapshot = result.body.snapshot;
  after = snapshot ? snapshot.room.version : result.body.version;
  if (!snapshot) continue;
  const room = snapshot.room;

  // Timing invariants on every observed transition.
  if (room.phase === "running" && room.startedAt) {
    const startedAt = Date.parse(room.startedAt);
    // The server may only publish a running row whose launch instant is not
    // absurdly in the past relative to its own clock at response time, and a
    // FIRST observation of a new running round must never begin mid-flight
    // beyond the poll latency window (launch-before-countdown regression).
    if (lastSnapshot?.room.currentRound !== room.currentRound) {
      const preRoll = startedAt - serverNow;
      note(preRoll > -(result.rtt + 2_000),
        `round ${room.currentRound}: launch not observed already mid-flight`,
        `startedAt-serverNow=${preRoll}ms`);
    }
    note(room.crashAt === null || room.crashAt === undefined,
      `round ${room.currentRound}: crash deadline stays private while running`);
  }
  if (room.phase === "settled" && lastSnapshot?.room.phase === "settled"
      && lastSnapshot.room.currentRound === room.currentRound) {
    // no-op: same settlement re-observed
  } else if (room.phase === "settled" && room.currentRound !== prevRound) {
    prevRound = room.currentRound;
    observedSettles += 1;
    const crashBps = Number(room.crashBps);
    const startedAt = Date.parse(room.startedAt);
    const crashAt = Date.parse(room.crashAt);
    // Geometry invariant: the revealed crash instant must equal the shared
    // multiplier law's inverse at the committed crash multiplier (±25ms of
    // integer rounding + storage precision).
    const lawMs = Math.max(350, Math.log(crashBps / 10_000) / GROWTH * 1_000);
    note(Number.isFinite(crashAt - startedAt) && Math.abs((crashAt - startedAt) - lawMs) <= 25,
      `round ${room.currentRound}: crash duration matches M(t) inverse`,
      `flight=${crashAt - startedAt}ms law=${Math.round(lawMs)}ms crash=${(crashBps / 10_000).toFixed(2)}x`);
    // Truthful endpoint: M(flight duration) reaches the committed crash bps.
    note(mBps(crashAt - startedAt) >= crashBps - 1,
      `round ${room.currentRound}: multiplier law reaches the committed crash point`);
    // Intermission schedule: nextLaunchAt = settledAt + 30s exactly.
    const settledAt = Date.parse(room.settledAt);
    const nextLaunchAt = Date.parse(room.nextLaunchAt);
    note(nextLaunchAt - settledAt === 30_000,
      `round ${room.currentRound}: automatic relaunch scheduled 30s after settlement`);
    console.log(`      observed settlement ${observedSettles}/${ROUNDS}`);
  }
  // The previous round, once settled, must have launched no earlier than its
  // scheduled intermission end (server-side early-launch invariant).
  if (room.phase === "running" && lastSnapshot?.room.phase === "settled"
      && lastSnapshot.room.nextLaunchAt && room.startedAt) {
    const scheduled = Date.parse(lastSnapshot.room.nextLaunchAt);
    const started = Date.parse(room.startedAt);
    note(started >= scheduled - 5,
      `round ${room.currentRound}: did not launch before the visible countdown reached zero`,
      `startedAt=${room.startedAt} scheduled=${lastSnapshot.room.nextLaunchAt}`);
  }
  lastSnapshot = snapshot;
}

note(observedSettles >= ROUNDS, `observed ${ROUNDS} automatic rounds`, `saw ${observedSettles}`);

console.log(failures.length ? `\n${failures.length} invariant(s) FAILED` : "\nAll live invariants held.");
process.exit(failures.length ? 1 : 0);
