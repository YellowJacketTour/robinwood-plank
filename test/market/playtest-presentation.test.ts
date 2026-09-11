// @ts-expect-error browser ESM module
import {advanceFlightMotion} from "../../public/arcade/flight-motion.js";
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

// BUGFIX 2026-09-06 (reported live): a player who left the settled-round
// reveal card open past the real launch instant, then dismissed it, saw the
// intermission countdown jump back up toward a near-full "30 seconds" while
// the real, server-fixed launch fired on schedule regardless. Root cause:
// paintPrivateSnapshot recomputed a naive Date.now()-based server-time offset
// on EVERY call, including acknowledgePrivateSettlement's repaint of the SAME
// cached (stale) snapshot -- re-anchoring "now" to whenever that snapshot was
// first fetched and discarding all real elapsed time since. Fixed by routing
// through ServerClockSync (RTT-compensated, monotonic, only advances from a
// REAL network round trip -- ported to public/arcade/private-server-clock.js
// from the already-tested lib/playtest-live-shared.ts source). These pins
// guard the two halves of the fix: a real fetch must observe a real send
// timestamp, and a stale-data repaint must NOT.
test("the intermission clock cannot be corrupted by a repaint of stale cached data", () => {
  assert.match(arcadeSource, /import \{ ServerClockSync \} from "\.\/private-server-clock\.js"/);
  assert.doesNotMatch(arcadeSource, /privateServerOffsetMs/, "the naive, repaint-corruptible offset must be fully removed, not just unused");
  // paintPrivateSnapshot must accept an explicit sentPerfMs and only observe
  // a real round trip when one was actually provided.
  assert.match(arcadeSource, /function paintPrivateSnapshot\(snapshot, sentPerfMs = null\)/);
  assert.match(arcadeSource, /if \(sentPerfMs !== null\) privateServerClock/);
  assert.match(arcadeSource, /privateServerClock\.observe\(Date\.parse\(snapshot\.serverNow\), sentPerfMs, receivedPerfMs\)/);
  // The reveal-dismiss repaint (acknowledgePrivateSettlement) must call
  // paintPrivateSnapshot with NO second argument -- passing a fresh
  // performance.now() here for stale cached data is exactly the bug.
  assert.match(arcadeSource, /try \{ paintPrivateSnapshot\(privateSnapshot\); \} catch \(error\) \{ console\.error\("\[playtest\] result acknowledgement repaint failed", error\); \}/);
  // Real fetch call sites must capture sentPerfMs BEFORE the request and pass
  // it through, so ServerClockSync can bound the estimate by the true RTT.
  assert.match(arcadeSource, /const sentPerfMs = performance\.now\(\);\s*\n\s*const response = await fetch\(`\/api\/playtest\/rooms\/\$\{roomId\}\/updates/);
  assert.match(arcadeSource, /paintPrivateSnapshot\(update\.snapshot, sentPerfMs\)/);
  assert.match(arcadeSource, /const refreshSentPerfMs = performance\.now\(\);/);
  assert.match(arcadeSource, /paintPrivateSnapshot\(await privateJson\(await fetch\(`\/api\/playtest\/rooms\/\$\{privateRoomId\}`[^)]*\)\), refreshSentPerfMs\)/);
  // updatePrivateIntermissionAction (the actual countdown display) must read
  // the monotonic estimate, never the removed naive offset.
  assert.match(arcadeSource, /privateServerClock\.synchronized \? privateServerClock\.now\(performance\.now\(\)\) : Date\.now\(\)/);
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
  // No placeholder ball ("—") exists while funding: the drum / fallback
  // result sphere is rendered only for an active draw (owner fix 2026-09-03).
  assert.doesNotMatch(arcadeSource, /drawnNumber : "—"/);
  // The drum is now the WebGL-less fallback, not the primary reveal: Astra's
  // 3D machine shows the same ball as a real object that rolls, ejects and
  // settles, so rendering both was two answers to one question. The property
  // this test actually guards is unchanged -- no result ball while funding.
  assert.match(arcadeSource, /\$\{drawActive && canvas3dUnavailable \? `<div class="private-powerball-drum"/);
  assert.match(arcadeSource, /powerball\.dataset\.drawActive = drawActive \? "true" : "false"/);
  assert.match(arcadeSource, /drawActive \? draw\.drawnNumber : null/);
  assert.doesNotMatch(arcadeSource, /Funding sample \$\{draw\.drawnNumber\}/);
  assert.match(arcadeSource, /drawActive \? "LIVE NUMBER DRAW" : "PRIZE FUNDING MIX"/);
});

const gumballSource = readFileSync(new URL("../../public/arcade/gumball-machine.js", import.meta.url), "utf8");
test("lottery presentation uses the committed draw and supports reduced motion", () => {
  assert.match(arcadeSource, /mountGumballMachine\(canvas, card, drawNumber, populationSize\)/);
  assert.match(gumballSource, /prefers-reduced-motion: reduce/);
  assert.match(gumballSource, /Invalid committed lottery ball/);
  assert.match(gumballSource, /cancelAnimationFrame\(frame\)/);
  assert.match(arcadeSource, /drawActive \? draw\.drawnNumber : null/);
});

test("displayed == redeemable: the prize chip and tiles show the winner's exact take from the carve, never the pool", () => {
  // The client mirrors the kernel's carve and hit rule byte-faithfully...
  assert.match(arcadeSource, /function privateCarve\(prize, policy\)/);
  assert.match(arcadeSource, /function privateHitThreshold\(contribution, prize, policy\)/);
  assert.match(arcadeSource, /const seeded = \(P \* \(xMin \* denom \+ \(xMax - xMin\) \* P\)\) \/ \(10_000n \* denom\);/);
  // ...and every player-facing prize figure is the winner's take.
  assert.match(arcadeSource, /label:`PRIZE \$\{privateCredits\(winnerTake\)\}`/);
  assert.match(arcadeSource, /<small>\$\{winner \? "NEXT PRIZE" : "LOTTERY PRIZE"\}<\/small>\$\{privateCredits\(boardCarve\.winnerTake\)\} cr/);
  assert.match(arcadeSource, /If you win you receive/);
  // No sealing / reset-reserve / ratchet copy survives on any surface.
  assert.doesNotMatch(arcadeSource, /resetReserve|nextPrizeTarget|cycleBase|awaitingSeal|readyForDraw|NOW SEALED/);
  assert.match(arcadeSource, /Nothing is forced/);
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
  assert.match(arcadeSource, /Lock granted at/);
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
  assert.match(arcadeSource, /new ethers\.Contract\(BANK_ADDR, ARCADE_ABI\.PlankBank, signer\)/);
  assert.match(arcadeSource, /crash\.placeBetInRound\(BigInt\(expectedRound\), committedTargetBps,/);
  assert.match(arcadeSource, /sessionBank\.betViaInRound\(crash\.target, BigInt\(expectedRound\), ethers\.parseEther\(betAmount\), committedTargetBps\)/);
});

test("pre-lock execution is authoritative and manual lock reports the included value", () => {
  assert.match(arcadeSource, /browser must NOT race a second manual transaction/);
  assert.doesNotMatch(arcadeSource, /Number\(liveBps\) >= autoTarget \* 10000/);
  assert.match(arcadeSource, /scoreCrash\.filters\.SeatSettled\(rid,scoreSigner\.address\)/);
  assert.match(arcadeSource, /Lock granted at/);
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
  // Phone machine canvas: ~32dvh, never above 34dvh, floor 200px; the docked
  // action block is fixed to the sheet bottom with its height reserved.
  assert.match(arcadeSource, /height:clamp\(200px,32dvh,300px\);max-height:max\(200px,34dvh\)/);
  assert.match(arcadeSource, /padding-bottom:calc\(var\(--private-dock-h,150px\) \+ 16px\)/);
  assert.match(arcadeSource, /\.private-result-next\{grid-template-columns:1fr;position:fixed;z-index:96/);
  assert.match(arcadeSource, /\.result-mult\{font-size:clamp\(24px,7\.4vw,32px\)/);
  assert.match(arcadeSource, /summary\.textContent = "How this settled"/);
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
  assert.match(arcadeSource, /createLaunchEnvironment\(THREE\)/);
  assert.match(arcadeSource, /launchEnvironment\.update\(/);
});

test("the SYSTEM & MATH manual is a readable, plain-language, formula-accurate field manual", () => {
  // Illustrations that anchor the visual identity survive.
  assert.match(mechanicsDeckSource, /<svg[^>]+aria-label="Multiplier vs\. time,/);
  assert.match(mechanicsDeckSource, /<svg[^>]+aria-label="Flow diagram of credits"/);
  assert.equal((mechanicsDeckSource.match(/class="ball(?: win)?"/g) || []).length, 16);
  // Six-step strip.
  for (const step of ["COMMIT", "LAUNCH", "FLY", "LOCK", "SETTLE", "DRAW"]) {
    assert.match(mechanicsDeckSource, new RegExp(`<b>0[1-6]</b>${step}<small>`));
  }
  // The five player questions, in order.
  const questions = [
    "What am I putting in?",
    "What can I get back on a flight?",
    "How does the lottery work and what does it cost me?",
    "What does the whole table's money do?",
    "What is guaranteed vs what varies",
  ];
  let cursor = -1;
  for (const q of questions) {
    const at = mechanicsDeckSource.indexOf(q);
    assert.ok(at > cursor, `question heading present and in order: ${q}`);
    cursor = at;
  }
  // Key formulas from the real constants.
  assert.match(mechanicsDeckSource, /95\.5%/);
  assert.match(mechanicsDeckSource, /75%\s+of your stake back/);
  assert.match(mechanicsDeckSource, /stake_i × ln\(m_i\)/);
  assert.match(mechanicsDeckSource, /× 1\/16/);
  assert.match(mechanicsDeckSource, /e\^\(0\.22·t\)/);
  assert.match(mechanicsDeckSource, /4\.50%/);
  assert.match(mechanicsDeckSource, /2\.50%/);
  assert.match(mechanicsDeckSource, /pot × 0\.0202/);
  assert.match(mechanicsDeckSource, /max\(base × 1\.05, base \+ 50,000\)/);
  assert.match(mechanicsDeckSource, />6%<\/strong><span>Operations</);
  // v3 vault-bonus/carve-ceiling mechanism (SPEC-monotonic-vault-positive-
  // sum-2026-09-05), now that it ships on by default.
  assert.match(mechanicsDeckSource, /25% × \(1 − 0\.999<sup>n<\/sup>\)/);
  assert.match(mechanicsDeckSource, /rounds ever contributed/);
});

test("the SYSTEM & MATH manual reserves no viewport-height block and has no text under 11px", () => {
  const css = mechanicsDeckSource.slice(
    mechanicsDeckSource.indexOf("<style>"),
    mechanicsDeckSource.indexOf("</style>")
  );
  // The dead zone came from `.hero{min-height:88svh}` — no viewport-height
  // reservation may return anywhere in the page CSS.
  assert.doesNotMatch(css, /min-height:\s*[\d.]+(svh|vh|dvh|lvh)/);
  assert.doesNotMatch(css, /\.hero\s*\{[^}]*(svh|vh|dvh)/);
  // Every explicit px font size (bare or inside font:/clamp()) is >= 11px.
  const sizes: number[] = [];
  for (const m of css.matchAll(/font(?:-size)?:\s*([^;]+);/g)) {
    for (const px of m[1].matchAll(/(\d+(?:\.\d+)?)px/g)) sizes.push(Number(px[1]));
  }
  assert.ok(sizes.length > 10, "font sizes were parsed");
  for (const size of sizes) assert.ok(size >= 11, `font size ${size}px is under the 11px floor`);
});

test("the SYSTEM & MATH manual never renders founder earnings or founder figures", () => {
  assert.doesNotMatch(mechanicsDeckSource, /founder/i);
  assert.doesNotMatch(mechanicsDeckSource, /FOUNDER TOTAL/);
});

test("the manual honestly discloses the 2026-09-05 F-1/F-2 hardening, plainly and without hiding it could touch a solo player", () => {
  // Placed right under "Guaranteed vs varies" -- the exact promise these
  // two closed findings protect (solvency; no extra claim from splitting a
  // stake across wallets). Must state plainly this was a MULTI-WALLET
  // collusion loophole, not something a single honest player was exposed
  // to, and must not bury the date or pretend nothing happened.
  assert.match(mechanicsDeckSource, /class="audit-note"/);
  assert.match(mechanicsDeckSource, /2026-09-05/);
  assert.match(mechanicsDeckSource, /two coordinated wallets/);
  assert.match(mechanicsDeckSource, /Neither could touch a single honest\s*\n?\s*player's payout/);
  assert.match(mechanicsDeckSource, /closed the\s*\n?\s*same day/);
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
  assert.match(gumballSource, /b\.n===Number\(drawNumber\)/);
  assert.match(gumballSource, /Invalid committed lottery ball/);
});

test("a host-forced lab outcome that diverges from the reveal-derived ball is computed AND rendered as forced", () => {
  // Server publishes the divergence flag whenever the paid outcome disagrees
  // with the reveal-derived rawHit…
  assert.match(roomsSource, /forcedForSimulation: Boolean\(result\.lotteryDraw\?\.forced\)/);
  assert.match(roomsSource, /naturalHit: result\.lotteryDraw\?\.natural \?\? null/);
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
  const allowed = /readingLottery\.founderFeeBps|lotteryFounderFeeBps|crashFounderRake|lotteryFounderFees|privateMinimumLotteryGross|Founder fee \(bps\)|Cumulative founder rake|private-setting|private-admin/;
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

// ── FIX 2026-09-05: the ONE fact players couldn't find live ──
// Multiple live testers reported the pari-mutuel payout as "guaranteed
// diluted value" — the mechanism was already honestly disclosed
// (.payout-note / maxPayableDisclosure), but only as a small, dimmed,
// tooltip-style line explaining the FORMULA, never the one concrete,
// reassuring number: the guaranteed floor. This headline states it
// outright, loudly, at the exact bet-sizing decision point.

test("the guaranteed survivor floor is stated as a loud, plain-language headline, not just a dimmed formula note", () => {
  assert.match(arcadeSource, /class="payout-floor" id="payoutFloorHeadline"/);
  // Must be visually distinct from the dimmed/hover-only .payout-note style
  // used for the mechanism-explanation lines -- this is the one fact meant
  // to read at a glance, not on hover.
  assert.match(arcadeSource, /\.payout-floor \{[^}]*font-weight:\s*700/);
  assert.doesNotMatch(arcadeSource, /class="payout-floor payout-note"/);
});

test("the floor headline is populated from the real on-chain floorBps, never a hardcoded percentage", () => {
  // Same `floor` binding as capLine's existing disclosure — both must read
  // crash.floorBps(), so the headline can never drift from a future
  // deploy's real floor value.
  assert.match(arcadeSource, /crash\.floorBps\(\)/);
  const start = arcadeSource.indexOf('document.getElementById("payoutFloorHeadline")');
  assert.ok(start >= 0, "could not locate the floor headline population code");
  const end = arcadeSource.indexOf("\n", arcadeSource.indexOf("floorHeadline.innerHTML", start));
  const block = arcadeSource.slice(start, end);
  assert.match(block, /Number\(floor\)/, "the headline must read the same `floor` value fetched from the contract, not a literal percentage");
  assert.doesNotMatch(block, /guaranteed at least <b>75%/, "the percentage must be interpolated from the real floor value, never hardcoded to today's default");
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
  // Exercise the same integrator as the renderer across device cadences.
  assert.match(arcadeSource, /advanceFlightMotion\(flightProgress,flightVel,targetFlightProgress/);
  for (const dt of [1 / 120, 1 / 30, 1 / 2]) { // two frame cadences ≈ two devices/viewports
    let flightProgress = 0, flightVel = 0, prevY = 0;
    for (let t = 0; t <= 12; t += dt) {
      const m = Math.exp(0.22 * t);
      const target = 1 - 1 / (1 + (m - 1) / 2.5);
      const motion=advanceFlightMotion(flightProgress,flightVel,target,dt);
      flightProgress=motion.position;flightVel=motion.velocity;
      const y = flightProgress; // altitude is an affine map of flightProgress
      assert.ok(y >= prevY - 1e-12, `monotone ascent at t=${t.toFixed(3)} dt=${dt}`);
      prevY = y;
    }
    assert.equal(advanceFlightMotion(0,0,0,1).position,0);
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
  // The primary action (COMMIT / LOCK) is PINNED to the phone viewport above
  // the table bar in every phase — never sticky-in-deck (that left it below
  // the fold and under the table sheet on real iPhones).
  // Sticky, not fixed: fixed took the action out of flow, so at max scroll
  // the stake/target/AUTO-LOCK/REPEAT rows rested underneath it (untappable).
  assert.match(arcadeSource, /\.deck \.primary-btn\{position:sticky;[^}]*z-index:90/);
  assert.match(arcadeSource, /html:has\(body\[data-playtest="true"\]\)\{height:auto;overflow-x:hidden;overflow-y:auto\}/);
  assert.match(arcadeSource, /\.topbar \.gear\{flex:0 0 44px;width:44px;height:44px\}/);
});

test("the header speaks plain money: no ticket-weight jargon, and the economy panel shows credits · ETH · USD", () => {
  // The two header chips and their paint code: no "WT" voucher-weight
  // jargon anywhere in the playtest header path.
  const headerPaint = arcadeSource.slice(arcadeSource.indexOf("const economyHeader = privateEconomyHeader(snapshot);"), arcadeSource.indexOf("const effectiveRakeBps = Number(snapshot.evolution?.effectiveRakeBps"));
  assert.ok(headerPaint.length > 0, "header paint block present");
  assert.doesNotMatch(headerPaint, /\bWT\b/);
  assert.doesNotMatch(arcadeSource.slice(arcadeSource.indexOf("function privateEconomyHeader"), arcadeSource.indexOf("function privateEconomyHtml")), /\bWT\b/);
  assert.match(arcadeSource, /`LOTTERY \$\{lotteryLead\} · ODDS \$\{odds\}`/, "lottery chip = prize-or-funded% + your odds");
  assert.match(arcadeSource, /`\$\{privateCredits\(vault\.principal\)\} cr \(\$\{privateUsdShort\(vault\.principal\)\}\)`/, "vault chip = credits (USD)");
  // THE DISPLAY LAW (owner, 2026-09-04): "credits are least useful units".
  // USD leads, ETH second, credits parenthetical — and when no live quote
  // exists we say so rather than inventing a price, with exact ETH leading.
  assert.match(arcadeSource, /credits are least useful units/);
  assert.match(arcadeSource, /return `\$\{prefix\}\$\{privateCreditUsd\(magnitude\)\} · \$\{eth\} \(\$\{cr\}\)`/);
  assert.match(arcadeSource, /USD quote unavailable/);
  assert.match(arcadeSource, /const PRIVATE_CREDITS_PER_ETH = 1_000_000n;/, "1 cr = 1e-6 ETH");
  // The panel's required fields, in plain language.
  for (const field of [
    "Vault holds", "Added this round", "Where it comes from", "Contributed to games", "Lifetime added to vault", "Lifetime seeded into flights",
    "If you win you receive", "Prize on the board", "Banked right now", "This round added", "Chance per round", "Your odds next flight", "Expected time to a hit",
    "LIVE — every settled round is a draw among that round's seats", "FUNDING — the first funded round puts a prize on the board", "the seed buffer is still filling", "genesis round — vault starts at 0",
  ]) assert.ok(arcadeSource.includes(field), `economy panel field missing: ${field}`);
  // Every entry point: desktop chips, the mobile HUD button, the phone table
  // sheet section, and the reveal card's tiles.
  assert.match(arcadeSource, /\$\("vaultStat"\)\.addEventListener\("click", \(\) => togglePrivateEconomy\("vault"\)\)/);
  assert.match(arcadeSource, /if \(PLAYTEST_MODE\) \{ togglePrivateEconomy\("lottery"\); return; \}/);
  assert.match(arcadeSource, /economyButton\.id = "privateEconomyButton"/);
  assert.match(arcadeSource, /economySection\.id = "privateEconomySection"/);
  assert.match(arcadeSource, /tile\.addEventListener\("click", \(\) => openPrivateEconomy\(tile\.dataset\.econ\)\)/);
  // Policy-derived, never hardcoded: the 0.315% line is computed from ppm.
  assert.match(arcadeSource, /pot × \$\{privatePpmPct\(vault\.shareOfPotPpm\)\}/);
  assert.doesNotMatch(arcadeSource, /0\.315%/);
});

// The chain scoreboard is the only source of `plank:lottery-result`, and it
// never runs under PLAYTEST_MODE. So lottery-theatre's button could only ever
// reach its PREVIEW branch: a fabricated "Ball 1 - round odds 1 in 16" with no
// relation to the table's real draw. Verified against a live room before this
// test existed -- the button was visible and did exactly that.
test("the lottery-theatre button is hidden in playtest, where it could only show a fabricated draw", () => {
  const theatreSource = readFileSync(
    new URL("../../public/arcade/lottery-theatre.js", import.meta.url),
    "utf8"
  );
  // Guard the premise: if the button ever stops being appended unconditionally,
  // this test is asserting about something that no longer exists.
  assert.match(theatreSource, /class='lottery-open'|className='lottery-open'|classList\.add\('lottery-open'\)/,
    "lottery-theatre still appends a .lottery-open button; keep the playtest hide rule aligned with it");
  assert.match(
    arcadeSource,
    /body\[data-playtest="true"\][^{]*\.lottery-open[^{]*\{[^}]*display:\s*none/,
    "playtest must hide .lottery-open so no fabricated preview draw is reachable"
  );
});

// Context LOSS had a reconnect curtain; context NEVER-CREATED did not. A
// browser with WebGL blocked threw at module top level, aborting the module
// (including startPrivatePlaytest) and leaving a black frame with no reason.
test("a WebGL context that cannot be created explains itself instead of leaving a black frame", () => {
  const construction = arcadeSource.indexOf("new THREE.WebGLRenderer(");
  assert.ok(construction > 0, "the renderer construction site must exist to be guarded");
  const window = arcadeSource.slice(Math.max(0, construction - 400), construction + 900);
  assert.match(window, /try\s*\{/, "renderer construction must be inside a try block");
  assert.match(window, /setAttribute\(\s*["']role["']\s*,\s*["']alert["']\s*\)/, "the failure must announce itself to assistive tech");
  assert.match(window, /cannot open a 3D view/, "the message must state the actual cause");
});

// The owner's live table rate-limited itself mid-flight. The server's poll
// deadline was 2s while the surrounding comment and maxDuration=30 assumed
// 20-30s, and the client re-polls with no success-path delay -- so a LIVE
// round, where the version changes every tick and every poll returns at once,
// ran a fetch loop bounded only by RTT. At 100ms that is ~600 req/min against
// a 120/min ceiling, and the player got a "Table busy" blackout of up to 20s.
test("the room long-poll holds long enough that a live round cannot rate-limit itself", () => {
  const route = readFileSync(
    new URL("../../app/api/playtest/rooms/[roomId]/updates/route.ts", import.meta.url),
    "utf8"
  );
  const deadline = route.match(/const deadline = Date\.now\(\) \+ ([\d_]+);/);
  assert.ok(deadline, "the poll deadline must be explicit");
  const holdMs = Number(deadline[1].replace(/_/g, ""));
  const limit = route.match(/limit:\s*(\d+),\s*windowMs:\s*([\d_]+)/);
  assert.ok(limit, "the rate limit must be explicit");
  const perMinute = Number(limit[1]) / (Number(limit[2].replace(/_/g, "")) / 60_000);
  // The failure was never the idle rate -- 2s idles at 30/min, comfortably
  // under 120. It was the LIVE round: the version changes every tick, so every
  // poll returns immediately and the client (no success-path delay) re-polls at
  // RTT speed. What actually protects the table is the hold being long relative
  // to a round, so a burst of instant returns is bounded by ticks rather than
  // by network latency. A 20s round must not be able to spend the whole minute
  // budget, so require the hold to be a meaningful fraction of a round.
  const idleRequestsPerMinute = 60_000 / holdMs;
  assert.ok(
    idleRequestsPerMinute <= perMinute / 8,
    `idle poll rate ${idleRequestsPerMinute}/min must sit well under the ${perMinute}/min limit`
  );
  assert.ok(
    holdMs >= 10_000,
    `a ${holdMs}ms hold lets a live round re-poll at RTT speed and rate-limit itself mid-flight`
  );
});

// renderRatio bounds by TOTAL PIXELS, not just device ratio. Playtest skipped
// it and used a bare Math.min(devicePixelRatio, cap), so a 1440p desktop or a
// 3x phone rendered ~2.25x the pixels through bloom, god-rays and lens-flare.
test("the pixel budget applies to playtest, not only the public arcade", () => {
  const resizeAt = arcadeSource.indexOf("function resize()");
  assert.ok(resizeAt > 0, "resize() must exist");
  const body = arcadeSource.slice(resizeAt, resizeAt + 1400);
  const call = body.indexOf("renderRatio(");
  assert.ok(call > 0, "resize must run the pixel budget");
  // Discriminate on what precedes the call, not on a regex that a multi-line
  // `if (!PLAYTEST_MODE) { ... }` block can slip past: no unclosed
  // PLAYTEST_MODE guard may sit between the function head and the call.
  const before = body.slice(0, call);
  const guards = before.match(/!\s*PLAYTEST_MODE/g) || [];
  assert.equal(
    guards.length, 0,
    "renderRatio must not sit behind a !PLAYTEST_MODE guard -- playtest needs the pixel budget too"
  );
  assert.match(body, /PLAYTEST_MODE \? privateQualityCap\(\)/, "playtest must supply its tier as the cap");
});

// The sampler was gated on preference === "balanced", so a player who chose
// "high" -- the tier that most needs relief -- was never sampled at all.
test("the adaptive quality sampler can demote a high-tier playtest player", () => {
  assert.doesNotMatch(
    arcadeSource,
    /\} else if \(privateQualityPreference === "balanced"\) \{/,
    "sampling must not be restricted to the balanced preference -- 'high' needs relief most"
  );
  assert.match(
    arcadeSource,
    /\} else if \(privateQualityPreference !== "low"\) \{/,
    "every tier that is not already pinned low must be sampled"
  );
  assert.match(
    arcadeSource,
    /if \(effectiveRenderTier === "high"\) configureRenderQuality\("balanced"\)/,
    "a struggling high tier must step down to balanced"
  );
});

// Astra built the Rapier lottery drum and verified it with eight headless
// checks, but playtest only ever reached the 2D placeholder: the 3D machine
// was mounted exclusively through lottery-theatre, which is fed by the CHAIN
// scoreboard and so never opens here. The theatre was the chain-coupled part;
// the machine itself needs only a ball count and the committed ball, both of
// which the playtest snapshot already carries. Verified on a live local table:
// data-lottery-renderer="rapier-3d", physics="rapier", and the real phase
// sequence rolling -> orienting -> presented.
test("playtest presents the real 3D lottery machine, not the 2D placeholder", () => {
  assert.match(
    arcadeSource,
    /import \{ mountLotteryMachine \} from "\.\/lottery-machine-3d\.js"/,
    "the 3D machine must be imported"
  );
  const mountAt = arcadeSource.indexOf("function mountPrivateLotteryMachine(");
  assert.ok(mountAt > 0, "the playtest mount point must exist");
  const body = arcadeSource.slice(mountAt, mountAt + 2400);
  assert.match(body, /mountLotteryMachine\(canvas, \{/, "playtest must mount the 3D machine");
  // A committed ball is required to build the population, so a funding round
  // (no draw) legitimately keeps the placeholder -- but a real draw must not.
  assert.match(
    body,
    /if \(drawNumber === null \|\| drawNumber === undefined\)/,
    "only a draw-less funding round may fall back to the 2D machine"
  );
  // Rapier loads asynchronously: a failure arrives as an event after the call
  // returns, so a try/catch alone would leave a frozen drum on screen.
  assert.match(
    body,
    /addEventListener\("lottery-render-error"/,
    "an async physics failure must also fall back, not just a synchronous throw"
  );
});
