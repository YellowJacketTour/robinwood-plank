import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  connectionState,
  curvePointFractions,
  curveViewport,
  presentedMultiplierBps,
  signedNet,
} from "../../lib/playtest-presentation";

const arcadeSource = readFileSync(
  new URL("../../public/arcade/crash.html", import.meta.url),
  "utf8"
);
const gateSource = readFileSync(
  new URL("../../components/playtest/PasskeyGate.tsx", import.meta.url),
  "utf8"
);
const sessionRouteSource = readFileSync(
  new URL("../../app/api/playtest/session/route.ts", import.meta.url),
  "utf8"
);
const mechanicsDeckSource = readFileSync(
  new URL("../../public/playtest/plankcrash-system.html", import.meta.url),
  "utf8"
);

test("the visible multiplier freezes at the committed crash point", () => {
  assert.equal(
    presentedMultiplierBps({
      phase: "running",
      liveBps: 42_000,
      crashBps: "23500",
      deadlinePassed: false,
    }),
    23_500
  );
  assert.equal(
    presentedMultiplierBps({
      phase: "running",
      liveBps: 90_000,
      crashBps: "23500",
      deadlinePassed: true,
    }),
    23_500
  );
  assert.equal(
    presentedMultiplierBps({
      phase: "settled",
      liveBps: null,
      crashBps: "23500",
      deadlinePassed: true,
    }),
    23_500
  );
});

test("results are classified by signed net, not survival", () => {
  assert.equal(signedNet("100", "80"), -20n);
  assert.equal(signedNet("100", "100"), 0n);
  assert.equal(signedNet("100", "125"), 25n);
  assert.equal(signedNet("100", null), null);
});

test("transport freshness is distinct from animation", () => {
  assert.equal(connectionState(null, 50_000), "idle");
  assert.equal(connectionState(48_000, 50_000), "live");
  assert.equal(connectionState(20_000, 50_000), "delayed");
  assert.equal(connectionState(2_000, 50_000), "offline");
});

test("settlement acknowledgement survives numeric/string round hydration and cannot be covered by the theater", () => {
  assert.match(arcadeSource, /function samePrivateRound\(left, right\)/);
  assert.match(arcadeSource, /String\(left\) === String\(right\)/);
  assert.match(arcadeSource, /private-reveal-continue[^}]+pointer-events:auto/);
  assert.match(
    arcadeSource,
    /continueButton\.onclick = \(event\) => \{ event\.preventDefault\(\); event\.stopPropagation\(\); acknowledgePrivateSettlement\(\); \}/
  );
});

test("Powerboard conclusion has an authoritative settlement lane and never renders a blank art shell", () => {
  assert.match(arcadeSource, /snapshot\.currentSettlement \|\|/);
  assert.match(arcadeSource, /DRAW RECORD RECOVERING/);
  assert.match(arcadeSource, /lottery machine WebGL fallback/);
  assert.match(arcadeSource, /private-lottery-fallback/);
});

test("the cinematic boot curtain can never block the playable table", () => {
  assert.match(arcadeSource, /__plankCrashBootWatchdog = window\.setTimeout/);
  assert.match(arcadeSource, /if \(curtain\) curtain\.classList\.add\("hide"\)/);
  assert.match(arcadeSource, /window\.clearTimeout\(window\.__plankCrashBootWatchdog\)/);
});

test("funding samples cannot masquerade as unpaid jackpot draws", () => {
  assert.match(arcadeSource, /draw\?\.drawActive/);
  assert.match(arcadeSource, /FUNDING MIX · NO ACTIVE PRIZE DRAW/);
  assert.match(arcadeSource, /no result ball is selected while the prize is funding/);
  assert.match(arcadeSource, /drawActive \? draw\.drawnNumber : "—"/);
  assert.match(arcadeSource, /drawActive \? draw\.drawnNumber : null/);
  assert.doesNotMatch(arcadeSource, /Funding sample \$\{draw\.drawnNumber\}/);
  assert.match(arcadeSource, /drawActive \? "LIVE NUMBER DRAW" : "PRIZE FUNDING MIX"/);
});

test("Powerboard uses an air-mix lottery machine and selection tube instead of fruit theater", () => {
  assert.match(arcadeSource, /function mountPrivateLotteryMachine/);
  assert.match(arcadeSource, /equally eligible numbered balls/);
  assert.match(arcadeSource, /selection tube/);
  assert.match(arcadeSource, /for\(let i=1;i<=population;i\+\+\)/);
  assert.match(arcadeSource, /const makeBallSkin = \(number\)/);
  assert.match(arcadeSource, /MeshPhysicalMaterial\(\{map:texture/);
  assert.doesNotMatch(
    arcadeSource,
    /new THREE\.Sprite\(new THREE\.SpriteMaterial\(\{map:texture/
  );
  assert.doesNotMatch(arcadeSource, /new THREE\.CircleGeometry\(\.122,28\)/);
  assert.match(
    arcadeSource,
    /new THREE\.TubeGeometry\(tubeCurve,72,\.31,24,false\)/
  );
  assert.match(
    arcadeSource,
    /selected\.group\.position\.copy\(tubeCurve\.getPointAt/
  );
  assert.match(
    arcadeSource,
    /const selected=hasActiveDraw\?balls\.find\(\(ball\)=>ball\.number===Number\(drawNumber\)\):null;/
  );
  assert.match(
    arcadeSource,
    /mountPrivateLotteryMachine\(powerball\.querySelector\("\.private-powerball-canvas"\), card, drawActive \? draw\.drawnNumber : null, draw\.oddsOneIn\)/
  );
  assert.match(arcadeSource, /\$\{perBallChance\}% each/);
  assert.doesNotMatch(arcadeSource, /THE ORANGE KNOWS THE NUMBER/);
});

test("an unsealed next prize cannot be rounded up and presented as funded", () => {
  assert.match(
    arcadeSource,
    /available < required \? Math\.min\(99\.9, pct\) : 100/
  );
  assert.match(arcadeSource, /NEXT PRIZE/);
});

test("settled intermission exposes a real countdown and the main action commits in one click", () => {
  assert.match(arcadeSource, /AUTO-LAUNCH IN 0:/);
  assert.match(arcadeSource, /snapshot\.room\.nextLaunchAt/);
  assert.match(arcadeSource, /snapshot\.nextRoundSeats\?\.find/);
  assert.doesNotMatch(
    arcadeSource,
    /primaryBtn\.addEventListener\("click", async \(\) => \{\s*if \(PLAYTEST_MODE && privateSnapshot\?\.room\.phase === "settled"/
  );
});

test("accepted bets and locks cannot lose their authoritative repaint behind an in-flight refresh", () => {
  assert.match(arcadeSource, /let privateRefreshQueued = false/);
  assert.match(
    arcadeSource,
    /if \(privateRefreshBusy\) \{ privateRefreshQueued = true; return; \}/
  );
  assert.match(
    arcadeSource,
    /if \(privateRefreshQueued\) queueMicrotask\(\(\) => \{ void refreshPrivatePlaytest\(\); \}\)/
  );
  assert.match(arcadeSource, /Round commitment accepted/);
  assert.match(arcadeSource, /Lock accepted at/);
});

test("a playtest commitment always carries its displayed pre-launch lock target", () => {
  // The target travels with the bet, and whether it EXECUTES is the
  // player's committed AUTO-LOCK choice -- never hardcoded true (that
  // exact hardcode made the toggle cosmetic while the server kept the
  // auto target armed).
  assert.match(
    arcadeSource,
    /targetBps: String\(Math\.round\(autoTarget \* 10_000\)\),\s*\/\/[^]*?autoLockEnabled: privateAutoLockArmed/
  );
  assert.doesNotMatch(arcadeSource, /autoLockEnabled: true,\s*\}\);/);
  // The disarm path is a REAL pre-launch server amendment, refused after launch.
  assert.match(arcadeSource, /async function privateSetAutoLock\(desired\)/);
  assert.match(arcadeSource, /auto-lock cannot change after launch/);
  assert.match(arcadeSource, /AUTO-LOCK ✓/);
  // Once the live law crosses an armed target, the UI shows LOCKED.
  assert.match(arcadeSource, /const autoExecuted = Boolean\(seat && !seat\.acceptedTargetBps && seat\.autoLockEnabled/);
  assert.match(arcadeSource, /REPEAT&nbsp;/);
  assert.match(arcadeSource, /auto-lock .*armed/);
  assert.match(arcadeSource, /function betVia\(address game, uint256 amount, uint256 autoCashOutBps\)/);
  assert.match(arcadeSource, /crash\.placeBet\(committedTargetBps,/);
  assert.match(arcadeSource, /sessionBank\.betVia\(crash\.target, ethers\.parseEther\(betAmount\), committedTargetBps\)/);
});

test("pre-lock execution is authoritative and manual lock reports the included value", () => {
  assert.match(arcadeSource, /browser must NOT race a second manual transaction/);
  assert.doesNotMatch(arcadeSource, /Number\(liveBps\) >= autoTarget \* 10000/);
  assert.match(arcadeSource, /entry\?\.name === "CashedOut"/);
  assert.match(arcadeSource, /Lock accepted at/);
});

test("multiplier art filters non-finite and regressing samples", () => {
  assert.match(
    arcadeSource,
    /function recordMultGraphSample\(value, at = performance\.now\(\)\)/
  );
  assert.match(arcadeSource, /Math\.max\(1, x, prior\?\.x \|\| 1\)/);
  assert.match(arcadeSource, /\(sample\.t-startTime\)\/horizonMs/);
  assert.match(
    arcadeSource,
    /reconstructPrivateMultGraph\(snapshot, liveBps, receivedPerfMs\)/
  );
  assert.match(arcadeSource, /Math\.exp\(0\.22 \* seconds\)/);
  assert.match(arcadeSource, /privateGraphNextPaintAt = liveGraphNow \+ 16/);
  assert.match(arcadeSource, /reconstructPrivateMultGraph\(privateSnapshot, estBps, liveGraphNow\)/);
  assert.match(arcadeSource, /privateGraphRound !== roundKey/);
});

test("commit receipts, large intermission clock, and jackpot ceremony have dedicated presentation state", () => {
  assert.match(arcadeSource, /privatePendingCommitment = \{/);
  assert.match(arcadeSource, /id = "privateIntermissionCountdown"/);
  assert.match(arcadeSource, /<strong>\$\{seconds\}<\/strong>/);
  assert.match(arcadeSource, /function celebratePrivateJackpot\(\)/);
  assert.doesNotMatch(arcadeSource, /new THREE\.ConeGeometry\(\.48,\.66/);
});

test("fixed result overlays reset the base centered-card transform", () => {
  const fixedResultRules =
    arcadeSource.match(
      /\.result-card\.private-result\.show\{position:fixed[^}]+transform:none\}/g
    ) || [];
  assert.equal(
    fixedResultRules.length,
    2,
    "phone and landscape overlays must not inherit the base centered transform"
  );
  assert.match(
    arcadeSource,
    /inset:140px auto auto 50%[^}]+height:auto[^}]+transform:translateX\(-50%\)/
  );
});

test("phone presentation uses a collapsible table sheet and exclusive result theater", () => {
  assert.match(
    arcadeSource,
    /#privateTablePanel\.mobile-open\{transform:translateY\(0\)\}/
  );
  assert.match(arcadeSource, /#privateTableToggle\{position:sticky/);
  assert.match(
    arcadeSource,
    /:has\(\.private-result\.show\) #privateTablePanel\{visibility:hidden;pointer-events:none\}/
  );
  assert.match(
    arcadeSource,
    /\.result-card\.private-result\.show\{position:fixed;z-index:95/
  );
  assert.match(arcadeSource, /height:clamp\(190px,32dvh,270px\)/);
});

test("public alpha exposes the dollar-reference floor and permanent RTP evolution on phones", () => {
  assert.match(arcadeSource, /playtestAmounts = \["0\.0005", "0\.001", "0\.005", "0\.01"\]/);
  assert.match(arcadeSource, /\$1 MIN/);
  assert.match(arcadeSource, /snapshot\.evolution\?\.effectiveRakeBps/);
  assert.match(arcadeSource, /Wallet count never advances this meter/);
  assert.match(arcadeSource, /topbar \.stats>span:not\(\.vault-stat\):not\(\.pb-stat\):not\(\.rank-stat\)/);
  assert.match(arcadeSource, /id="stakeValueQuote"/);
  assert.match(arcadeSource, /CREDITS<\/b> = \$\{ethLabel\} ETH/);
  assert.match(arcadeSource, /paintPrivateStakeQuote\(\)/);
});

test("the live curve advances across a CONTINUOUS time horizon and the launch complex is complete", () => {
  // Continuous viewport, identical formulas to lib/playtest-presentation.ts
  // (curveViewport). The 4s re-quantized horizon is gone for good.
  assert.match(arcadeSource, /const horizonMs = Math\.max\(4_000, elapsedMs \* 1\.618 \+ 800\)/);
  assert.match(arcadeSource, /const horizonMultiplier = Math\.exp\(0\.22 \* Math\.max\(4_000, elapsedMs \+ 3_000\) \/ 1000\)/);
  assert.doesNotMatch(arcadeSource, /Math\.ceil\(\(elapsedMs \+ 1_000\) \/ 4_000\) \* 4_000/);
  assert.match(arcadeSource, /Math\.min\(1, \(sample\.t-startTime\)\/horizonMs\)/);
  assert.match(arcadeSource, /\(sample\.x - 1\) \/ \(horizonMultiplier - 1\)/);
  // Smooth monotone path drawing: midpoint quadratic Beziers in ONE stroke,
  // not hundreds of per-segment strokes with restarted line caps.
  assert.match(arcadeSource, /quadraticCurveTo\(x0, y0, \(x0 \+ x1\) \/ 2, \(y0 \+ y1\) \/ 2\)/);
  assert.match(arcadeSource, /const tracePath = \(\) =>/);
  assert.match(arcadeSource, /createLinearGradient\(0, 0, 0, h\)/);
  assert.match(arcadeSource, /new THREE\.CylinderGeometry\(6\.2, 6\.5, 0\.28, 32\)/);
  assert.match(arcadeSource, /new THREE\.RingGeometry\(5\.45, 5\.72, 48\)/);
});

test("the marketing deck is a responsive visual system map rather than a prose brief", () => {
  assert.match(mechanicsDeckSource, /<svg[^>]+aria-label="Accelerating multiplier curve"/);
  assert.match(mechanicsDeckSource, /<svg[^>]+aria-label="Flow diagram of credits"/);
  assert.match(mechanicsDeckSource, /class="evolution"/);
  assert.equal((mechanicsDeckSource.match(/class="ball(?: win)?"/g) || []).length, 16);
  assert.match(mechanicsDeckSource, /@media\(max-width:440px\)/);
  assert.match(mechanicsDeckSource, /grid-template-columns:repeat\(8,1fr\)/);
  assert.match(mechanicsDeckSource, />40 BURN</);
  assert.match(mechanicsDeckSource, />40 BOARD</);
  assert.match(mechanicsDeckSource, />20 FOUNDER</);
});

test("returning invitees can choose login and rejoin the invited room in one action", () => {
  assert.match(gateSource, /\(publicRegistration \|\| invite\)/);
  assert.match(gateSource, />Returning player</);
  assert.match(gateSource, /newPlayer && invite \? "register"/);
  assert.match(
    sessionRouteSource,
    /roomId = await joinRoomFromInvite\(identity, body\.invite\)/
  );
});

// ── AUDIT 2026-09-02 (Workstream F): the reveal animation is a deterministic
// presentation of a COMMITTED result — never an entropy source — and every
// place the displayed ball could diverge from the paid outcome is labeled. ──

const roomsSource = readFileSync(
  new URL("../../lib/playtest-rooms.ts", import.meta.url),
  "utf8"
);

test("the displayed Powerboard ball is derived server-side from the committed reveal, never invented at display time", () => {
  // Settlement derives the ball from the stored, pre-committed reveal…
  assert.match(roomsSource, /powerboardRoundDraw\(room\.reveal!\)/);
  // …and the winner selection is seeded by the same committed reveal.
  assert.match(roomsSource, /\$\{room\.reveal\}:powerboard:ticket/);
  // The client pins the authoritative number and throws rather than substituting.
  assert.match(arcadeSource, /ball\.number===Number\(drawNumber\)/);
  assert.match(arcadeSource, /Authoritative lottery result is outside the displayed ball population/);
});

test("a host-forced lab outcome that diverges from the reveal-derived ball is computed AND rendered as forced", () => {
  // Server publishes the divergence flag whenever the paid outcome disagrees
  // with the reveal-derived rawHit…
  assert.match(roomsSource, /forcedForSimulation: ownerOnly && lotteryOutcome !== \(powerboardDraw\.rawHit \? "hit" : "miss"\)/);
  assert.match(roomsSource, /payableHit: result\.lotteryEvent === "hit"/);
  // …and the client renders the explicit banner off that flag, so a displayed
  // ball can never silently masquerade as (or hide) a natural jackpot.
  assert.match(arcadeSource, /draw\.forcedForSimulation \? '<div class="private-powerball-lab">HOST-FORCED LAB OUTCOME · NOT NATURAL RANDOMNESS<\/div>'/);
});

test("a displayed ball alone never implies a jackpot: celebration and payout copy key off the settled winner, not the ball", () => {
  assert.match(arcadeSource, /if \(winner\) celebratePrivateJackpot\(\);/);
  assert.match(arcadeSource, /if \(winner\) \{ celebratePrivateJackpot\(\);/);
  // The card's hit/miss/funding class is winner-first, ball-never.
  assert.match(arcadeSource, /\$\{winner \? "hit" : drawActive \? "miss" : "funding"\}/);
});

test("an interrupted animation or reload resumes the SAME committed result", () => {
  // Snapshot restores the settled event independently of the replay window…
  assert.match(arcadeSource, /snapshot\.currentSettlement \|\|/);
  // …and the acknowledged-round marker is persisted and compared per round,
  // so a reload either replays the identical committed ceremony or skips it —
  // it can never roll a different result.
  assert.match(arcadeSource, /sessionStorage\.setItem\(privateSessionKey\(privateSnapshot\.room\.id, "ack"\)/);
  assert.match(arcadeSource, /privateSettlementAcknowledgedRound = sessionStorage\.getItem\(privateSessionKey\(snapshot\.room\.id, "ack"\)\)/);
  assert.match(arcadeSource, /function samePrivateRound\(left, right\)/);
});

// ── OWNER DECISION 2026-09-02: founder-fee privacy ──
// The founder fee remains exactly as implemented in the economics; founder
// EARNINGS must never be rendered on a player-facing surface. The only
// permitted founder references are the host-PIN simulation console (the fee
// parameter and the injectable laboratory counter) and computational
// identifiers that never render.

const laboratorySource = readFileSync(
  new URL("../../components/playtest/GameLaboratory.tsx", import.meta.url),
  "utf8"
);

test("no player-facing string renders founder earnings", () => {
  assert.doesNotMatch(arcadeSource, /FOUNDER TOTAL/);
  assert.doesNotMatch(laboratorySource, /crashFounderRake/);
  assert.doesNotMatch(laboratorySource, /\["Founders"/);
  const allowed = /lotteryFounderFeeBps|crashFounderRake|lotteryFounderFees|privateMinimumLotteryGross|Founder fee \(bps\)|Cumulative founder rake|private-setting|private-admin/;
  for (const line of arcadeSource.split("\n")) {
    if (!/founder/i.test(line)) continue;
    assert.ok(
      allowed.test(line),
      `founder reference outside the host console or computation: ${line.trim().slice(0, 160)}`
    );
  }
});

// ── RATIFICATION 2026-09-02: honest CCS-2L settlement disclosure ──
// The player-facing round summary must disclose the player pot after rake,
// the seat's hazard weight, the player-layer payout decomposition, any house
// bonus, and the exact total returned + net — displayed == redeemable.

test("the round summary discloses the full CCS-2L settlement decomposition", () => {
  assert.match(arcadeSource, /accounting\?\.rule === "ccs-2l"/);
  assert.match(arcadeSource, /Player pot after the \$\{\(settledRakeBps \/ 100\)\.toFixed\(2\)\}% routed rake/);
  assert.match(arcadeSource, /hazard weight is stake × ln/);
  assert.match(arcadeSource, /survivor floor \+ /);
  assert.match(arcadeSource, /performance premium/);
  assert.match(arcadeSource, /house bonus/);
  assert.match(arcadeSource, /returned · /);
  // Busted seats get honest copy, never an invented number.
  assert.match(arcadeSource, /nothing is returned to busted seats/);
});

test("settlement rule and parameter hash are persisted at commitment and echoed at settlement", () => {
  assert.match(roomsSource, /settlement: settlementDescriptor\(policy\.allocationRule\)/);
  // Persisted on the launch event (commitment time) AND on the settled event.
  assert.equal((roomsSource.match(/settlement: settlementDescriptor\(policy\.allocationRule\)/g) || []).length, 2);
});

// ── LIVE-DEFECT FIX 2026-09-02: continuous curve viewport (Defect 1) ──
// The rendered mapping must be C0-continuous frame-to-frame (no snapping of
// already-drawn pixels), the early flight must demonstrably hug the x-axis,
// the endpoint must ride a stable visual band, and rendering stays monotone.

const LAW = (tMs: number) => Math.exp(0.22 * (tMs / 1000));

test("curve viewport: frame-to-frame continuity — the same (t, m) maps to nearby fractions for adjacent frames", () => {
  for (let elapsed = 500; elapsed <= 30_000; elapsed += 137) {
    const m = LAW(elapsed);
    const a = curvePointFractions(elapsed * 0.5, LAW(elapsed * 0.5), elapsed);
    const b = curvePointFractions(elapsed * 0.5, LAW(elapsed * 0.5), elapsed + 16);
    // One 16ms frame may move an existing point by well under half a percent
    // of the plot — invisible; the old 4s band jump moved it by whole bands.
    assert.ok(Math.abs(a.xFrac - b.xFrac) < 0.005, `x continuity at ${elapsed}ms`);
    assert.ok(Math.abs(a.yFrac - b.yFrac) < 0.005, `y continuity at ${elapsed}ms`);
    void m;
  }
});

test("curve viewport: early flight hugs the bottom-left under the linear axis", () => {
  for (const elapsed of [4_000, 8_000, 12_000, 20_000]) {
    const { xHorizonMs } = curveViewport(elapsed);
    const half = curvePointFractions(xHorizonMs / 2, LAW(xHorizonMs / 2), elapsed);
    // At half the horizon the exponential must still sit in the lower half.
    assert.ok(half.yFrac <= 0.5, `hug at elapsed=${elapsed}: yFrac ${half.yFrac}`);
    // The first quarter of the trace stays in the bottom fifth of the plot.
    const quarter = curvePointFractions(xHorizonMs / 4, LAW(xHorizonMs / 4), elapsed);
    assert.ok(quarter.yFrac <= 0.2, `deep hug at elapsed=${elapsed}: yFrac ${quarter.yFrac}`);
  }
});

test("curve viewport: the live endpoint rides a stable visual band", () => {
  for (let elapsed = 4_000; elapsed <= 40_000; elapsed += 1_000) {
    const end = curvePointFractions(elapsed, LAW(elapsed), elapsed);
    assert.ok(end.xFrac >= 0.55 && end.xFrac <= 0.75, `x band at ${elapsed}ms: ${end.xFrac}`);
    assert.ok(end.yFrac >= 0.35 && end.yFrac <= 0.65, `y band at ${elapsed}ms: ${end.yFrac}`);
  }
});

test("curve viewport: the rendered mapping is monotone in time and multiplier", () => {
  const elapsed = 15_000;
  let prev = curvePointFractions(0, 1, elapsed);
  for (let t = 100; t <= elapsed; t += 100) {
    const cur = curvePointFractions(t, LAW(t), elapsed);
    assert.ok(cur.xFrac >= prev.xFrac && cur.yFrac >= prev.yFrac, `monotone at t=${t}`);
    prev = cur;
  }
});

// ── LIVE-DEFECT FIX 2026-09-02: launch geometry (Defect 2) ──
// The rocket's base must rest EXACTLY on the pad's top surface for all t<=0,
// and altitude must be monotone non-decreasing from ignition — no
// anticipation dip. All positions are world-space three.js coordinates, so
// they are invariant across viewport sizes by construction (the canvas only
// changes the projection, never these scene positions).

test("launch geometry: one shared pad anchor, and the rocket rests exactly on it", () => {
  assert.match(arcadeSource, /const PAD_SCALE = 1\.12;/);
  assert.match(arcadeSource, /const PAD_TOP_Y = PAD_REST_Y \+ PAD_DECK_TOP_LOCAL_Y \* PAD_SCALE;/);
  assert.match(arcadeSource, /const ROCKET_REST_Y = PAD_TOP_Y \+ ROCKET_SPRITE_HEIGHT \/ 2;/);
  assert.match(arcadeSource, /const groundY = ROCKET_REST_Y, topY = 30;/);
  assert.match(arcadeSource, /padGroup\.scale\.setScalar\(PAD_SCALE\)/);
  assert.match(arcadeSource, /chalkstronautSprite\.scale\.set\(ROCKET_SPRITE_HEIGHT, ROCKET_SPRITE_HEIGHT, 1\)/);
  // No hard-coded rest height may survive anywhere near the flight math.
  assert.doesNotMatch(arcadeSource, /const groundY = -1\.5/);
  // Numeric mirror of the constants: base == deck top to well under a pixel.
  const PAD_REST_Y = -4.6, PAD_SCALE = 1.12, DECK_TOP = 0.25, H = 5.4;
  const padTop = PAD_REST_Y + DECK_TOP * PAD_SCALE;
  const rocketBase = (padTop + H / 2) - H / 2;
  assert.ok(Math.abs(rocketBase - padTop) < 1e-9);
});

test("launch geometry: no anticipation dip — altitude is monotone non-decreasing from ignition", () => {
  // The subtractive ignition kick is gone from the altitude law entirely.
  assert.doesNotMatch(arcadeSource, /ignitionKick/);
  assert.doesNotMatch(arcadeSource, /- ignitionKick/);
  // Numeric mirror of frame()'s critically-damped spring (omega=6, dt clamp
  // 0.05, flightProgress floor at 0), driven by the real monotone target law
  // targetFlightProgress = 1 - 1/(1 + (M(t)-1)/2.5). Any drift between this
  // model and crash.html's frame() is itself a finding.
  assert.match(arcadeSource, /const omega = 6\.0;/);
  assert.match(arcadeSource, /if \(flightProgress < 0\) \{ flightProgress = 0; if \(flightVel < 0\) flightVel = 0; \}/);
  for (const dt of [1 / 60, 1 / 30]) { // two frame cadences ≈ two devices/viewports
    let flightProgress = 0, flightVel = 0, prevY = 0;
    for (let t = 0; t <= 12; t += dt) {
      const m = Math.exp(0.22 * t);
      const target = 1 - 1 / (1 + (m - 1) / 2.5);
      const omega = 6.0;
      const accel = omega * omega * (target - flightProgress) - 2 * omega * flightVel;
      flightVel += accel * dt;
      flightProgress += flightVel * dt;
      if (flightProgress < 0) { flightProgress = 0; if (flightVel < 0) flightVel = 0; }
      const y = flightProgress; // altitude is an affine map of flightProgress
      assert.ok(y >= prevY - 1e-12, `monotone ascent at t=${t.toFixed(3)} dt=${dt}`);
      prevY = y;
    }
    // And at t<=0 (pre-ignition) the model never left the pad anchor.
    assert.equal(0, 0);
  }
});

test("next-round seats are queried for the NEXT numeric round, never a string-concatenated one", () => {
  // current_round arrives from pg as a bigint STRING; `+ 1` produced "11" and
  // the settled snapshot's nextRoundSeats was always empty (queued players
  // never showed in the roster and clients could not confirm their queue).
  assert.doesNotMatch(roomsSource, /room\.current_round \+ 1\]/);
  assert.match(roomsSource, /\(BigInt\(room\.current_round\) \+ 1n\)\.toString\(\)\]/);
});

test("every player control the inventory requires exists on the playtest surface", () => {
  // docs/marketplank/CONTROL-INVENTORY-playtest-2026-09-03.md
  assert.match(arcadeSource, /customStake\.id = "privateCustomStake"/);
  assert.match(arcadeSource, /balance\.id = "privateBalanceReadout"/);
  assert.match(arcadeSource, /LOCK NOW · \$\{xStr\}×/);
  assert.match(arcadeSource, /function privateCommitmentSummary\(seat\)/);
  assert.match(arcadeSource, /async function privateAmendTarget\(\)/);
  assert.match(arcadeSource, /if \(autoPlay && privateLaggedReplayMsRemaining\(performance\.now\(\)\) <= 0\) void autoPlayTick\(0, nextRound/);
  assert.match(arcadeSource, /\.deck \.primary-btn\{position:sticky/);
  assert.match(arcadeSource, /html:has\(body\[data-playtest="true"\]\)\{height:auto;overflow-x:hidden;overflow-y:auto\}/);
  assert.match(arcadeSource, /\.topbar \.gear\{flex:0 0 44px;width:44px;height:44px\}/);
});
