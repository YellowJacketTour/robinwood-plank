import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  connectionState,
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
  assert.match(
    arcadeSource,
    /targetBps: String\(Math\.round\(autoTarget \* 10_000\)\),\s*\/\/[^]*?autoLockEnabled: true/
  );
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
  assert.match(arcadeSource, /privateGraphNextPaintAt = liveGraphNow \+ 50/);
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

test("the live curve advances across a stable time horizon and the launch complex is complete", () => {
  assert.match(arcadeSource, /const horizonMs = Math\.max\(4_000/);
  assert.match(arcadeSource, /const horizonMultiplier = Math\.exp\(0\.22 \* horizonMs \/ 1000\)/);
  assert.match(arcadeSource, /Math\.min\(1, \(sample\.t-startTime\)\/horizonMs\)/);
  assert.match(arcadeSource, /\(sample\.x - 1\) \/ \(horizonMultiplier - 1\)/);
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
