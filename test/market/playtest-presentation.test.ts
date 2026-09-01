import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { connectionState, presentedMultiplierBps, signedNet } from "../../lib/playtest-presentation";

const arcadeSource = readFileSync(new URL("../../public/arcade/crash.html", import.meta.url), "utf8");

test("the visible multiplier freezes at the committed crash point", () => {
  assert.equal(presentedMultiplierBps({ phase: "running", liveBps: 42_000, crashBps: "23500", deadlinePassed: false }), 23_500);
  assert.equal(presentedMultiplierBps({ phase: "running", liveBps: 90_000, crashBps: "23500", deadlinePassed: true }), 23_500);
  assert.equal(presentedMultiplierBps({ phase: "settled", liveBps: null, crashBps: "23500", deadlinePassed: true }), 23_500);
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
  assert.match(arcadeSource, /continueButton\.onclick = \(event\) => \{ event\.preventDefault\(\); event\.stopPropagation\(\); acknowledgePrivateSettlement\(\); \}/);
});

test("Powerboard conclusion has an authoritative settlement lane and never renders a blank art shell", () => {
  assert.match(arcadeSource, /snapshot\.currentSettlement \|\|/);
  assert.match(arcadeSource, /DRAW RECORD RECOVERING/);
  assert.match(arcadeSource, /lottery machine WebGL fallback/);
  assert.match(arcadeSource, /private-lottery-fallback/);
});

test("Powerboard uses an air-mix lottery machine and selection tube instead of fruit theater", () => {
  assert.match(arcadeSource, /function mountPrivateLotteryMachine/);
  assert.match(arcadeSource, /transparent air chamber/);
  assert.match(arcadeSource, /selection tube/);
  assert.match(arcadeSource, /for\(let i=1;i<=16;i\+\+\)/);
  assert.doesNotMatch(arcadeSource, /THE ORANGE KNOWS THE NUMBER/);
});

test("an unsealed next prize cannot be rounded up and presented as funded", () => {
  assert.match(arcadeSource, /available < required \? Math\.min\(99\.9, pct\) : 100/);
  assert.match(arcadeSource, /NEXT PRIZE/);
});

test("settled intermission exposes a real countdown and the main action commits in one click", () => {
  assert.match(arcadeSource, /AUTO-LAUNCH IN 0:/);
  assert.match(arcadeSource, /snapshot\.room\.nextLaunchAt/);
  assert.match(arcadeSource, /snapshot\.nextRoundSeats\?\.find/);
  assert.doesNotMatch(arcadeSource, /primaryBtn\.addEventListener\("click", async \(\) => \{\s*if \(PLAYTEST_MODE && privateSnapshot\?\.room\.phase === "settled"/);
});

test("multiplier art filters non-finite and regressing samples", () => {
  assert.match(arcadeSource, /if \(!Number\.isFinite\(value\)\) continue/);
  assert.match(arcadeSource, /Math\.max\(1, value, samples\.length \? samples\[samples\.length - 1\] : 1\)/);
});

test("fixed result overlays reset the base centered-card transform", () => {
  const fixedResultRules = arcadeSource.match(/\.result-card\.private-result\.show\{position:fixed[^}]+transform:none\}/g) || [];
  assert.equal(fixedResultRules.length, 3, "phone, desktop, and landscape overlays must not inherit translate(-50%, -50%)");
});
