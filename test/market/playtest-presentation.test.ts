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
    /const selected=balls\.find\(\(ball\)=>ball\.number===Number\(drawNumber\)\);/
  );
  assert.match(
    arcadeSource,
    /mountPrivateLotteryMachine\(powerball\.querySelector\("\.private-powerball-canvas"\), card, draw\.drawnNumber, draw\.oddsOneIn\)/
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
});

test("multiplier art filters non-finite and regressing samples", () => {
  assert.match(
    arcadeSource,
    /function recordMultGraphSample\(value, at = performance\.now\(\)\)/
  );
  assert.match(arcadeSource, /Math\.max\(1, x, prior\?\.x \|\| 1\)/);
  assert.match(arcadeSource, /\(sample\.t-startTime\)\/\(endTime-startTime\)/);
  assert.match(
    arcadeSource,
    /reconstructPrivateMultGraph\(snapshot, liveBps, receivedPerfMs\)/
  );
  assert.match(arcadeSource, /Math\.exp\(0\.22 \* seconds\)/);
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

test("returning invitees can choose login and rejoin the invited room in one action", () => {
  assert.match(gateSource, /\(publicRegistration \|\| invite\)/);
  assert.match(gateSource, />Returning player</);
  assert.match(gateSource, /newPlayer && invite \? "register"/);
  assert.match(
    sessionRouteSource,
    /roomId = await joinRoomFromInvite\(identity, body\.invite\)/
  );
});
