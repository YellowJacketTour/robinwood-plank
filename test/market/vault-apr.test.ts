import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import { computeLpApr, computeLpAprWindows } from "../../lib/market/vault-stats";
import type { VaultTradeEvent } from "../../lib/market/vault-activity";

/**
 * Two rounds of the same underlying bug.
 *
 * Round 1: "the APR is dynamic 'APR (24h basis)' so that should be more
 * accurate" — a fresh V3 vault (heldTokenCount: 16, depositCount: 16,
 * redeemCount: 0) was reporting aprPct: 645.19 at a fixed aprBasisHours: 24.
 * That came from mintFeeLowerBoundApr, which treated every NFT the pool has
 * ever held as a deposit that happened inside one 24-hour window —
 * heldTokenCount is not depositCount (NFTs can also arrive via LP
 * contribution, which pays no mint fee).
 *
 * Round 2: fixing the window (real observed span, or null) still measured
 * the wrong FEE. "for the V3 vault, I think it's v2 style so shouldn't
 * there be some sort of APR/APY like a uniswap v2 style pool?" — the owner
 * was right again. Verified in contracts/MarketplankVaultV3.sol: mint/redeem
 * fees always do `accruedFees += msg.value` and pay out ONLY to the
 * immutable treasury via withdrawFees() (lines 298/317/332/418/452) — they
 * never reach liquidity providers. The swap fee is the LP's actual yield
 * (line 478: "k strictly grows and LPs earn the fee"). Deposit/redeem fee
 * revenue over TVL was treasury income presented as a return to LPs — wrong
 * numerator, not just a stale window.
 *
 * Round 3: fixing the fee re-introduced the window bug in a smaller,
 * better-hidden form. `hoursObserved` was computed as
 * `Math.max(realSpan, MIN_HOURS_FOR_APR)` — a floor, not a gate. Two swaps
 * five minutes apart got clamped up to a reported 1-hour basis and
 * annualized as though the revenue had been earned over that hour. That is
 * structurally the same error as the old hardcoded 24: a window nobody
 * measured, asserted as fact — and it made annualizeApr's own
 * `hoursObserved < MIN_HOURS_FOR_APR` guard permanently dead code, since the
 * value passed in could never be smaller than the minimum. Fixed by using
 * the true measured span with no clamp, and returning the null shape
 * whenever that real span doesn't clear MIN_HOURS_FOR_APR.
 *
 * Round 4, two corrections at once, from the owner directly: "I do not want
 * to force something that is not possible and I want to display what its
 * supposed to be if valid... if not then we can skip it."
 *   - TVL denominator: briefly changed to ethReserveWei alone on a literal
 *     reading of a scoping message, which doubled the reported rate and
 *     disagreed with the "TVL" figure already shown elsewhere on the same
 *     page. Restored to 2 x ethReserveWei — an LP holds both sides of a
 *     constant-product pool, and at the AMM's own spot price the share side
 *     is worth exactly ethReserve too.
 *   - Added MIN_SWAPS_FOR_APR: a real 24+ hour window with only two trades
 *     in it is a thin number wearing a respectable window. All four "valid"
 *     conditions (swap fee exists, real volume, real window, enough events)
 *     now live in one documented place next to MIN_HOURS_FOR_APR/
 *     MIN_SWAPS_FOR_APR rather than being scattered checks.
 *
 * Most of this suite is source-level, matching the style of
 * vault-immutable-config.test.ts in this same directory — getVaultStats and
 * most of its helpers talk to live RPC/Blockscout and are not mocked
 * anywhere in this suite, so those invariants are pinned at the source
 * instead. computeLpApr is pure (no I/O) and exported specifically so the
 * round-3/round-4 regressions can be tested behaviorally instead — see below.
 */

const statsUrl = new URL("../../lib/market/vault-stats.ts", import.meta.url);

/**
 * Finds the end of the plain (non-exported) `function` declaration starting
 * at `start`, for tests that string-scan one function's body in isolation.
 * Bounded on whichever comes first: the function's own closing
 * brace-then-blank-line, or the next plain `function ` declaration (a
 * fallback for callers that predate computeLpAprWindows, which is an
 * `export function` a bare "\nfunction " marker wouldn't stop at). Without
 * this, a naive "\nfunction "-only boundary silently spills into
 * computeLpAprWindows' own body/doc-comment when computeLpApr is the LAST
 * plain function in the file. CRLF-tolerant since this repo's checked-out
 * line endings aren't guaranteed to be \n.
 */
function findFunctionEnd(source: string, start: number): number {
  const fnBoundary = /\r?\nfunction /g;
  fnBoundary.lastIndex = start + 1;
  const fnMatch = fnBoundary.exec(source);
  const nextPlainFn = fnMatch ? fnMatch.index : -1;

  const closeBoundary = /\r?\n\}\r?\n/g;
  closeBoundary.lastIndex = start + 1;
  const closeMatch = closeBoundary.exec(source);
  const closeBrace = closeMatch ? closeMatch.index + closeMatch[0].length : -1;

  if (closeBrace > start && (nextPlainFn < 0 || closeBrace < nextPlainFn)) return closeBrace;
  return nextPlainFn;
}

test("no heldTokenCount-based APR fabrication exists anywhere in vault-stats.ts", async () => {
  const source = await fs.readFile(statsUrl, "utf8");
  assert.ok(
    !source.includes("mintFeeLowerBoundApr"),
    "mintFeeLowerBoundApr asserted a 24h window from heldTokenCount alone — it must not come back"
  );
});

test("LP APR is computed from Bought/Sold swap volume, not deposit/redeem fees", async () => {
  const source = await fs.readFile(statsUrl, "utf8");
  const start = source.indexOf("function computeLpApr(");
  assert.ok(start >= 0, "could not locate computeLpApr");
  // computeLpApr is the last plain (non-exported) `function` before
  // computeLpAprWindows (an `export function`, so a bare "function " marker
  // alone wouldn't stop there, and would otherwise spill into that sibling
  // helper's own body/leading doc-comment) — bound on this function's own
  // closing brace-then-blank-line instead. CRLF-tolerant: this repo's
  // checked-out line endings aren't guaranteed to be \n.
  const end = findFunctionEnd(source, start);
  const body = source.slice(start, end > start ? end : undefined);

  assert.match(
    body,
    /e\.kind !== "buy" && e\.kind !== "sell"/,
    "LP APR must scan Bought/Sold (buy/sell) swap events, the actual LP-yield mechanism"
  );
  assert.ok(
    !/e\.kind !== "deposit"/.test(body) && !/e\.kind !== "redeem"/.test(body),
    "LP APR must not be derived from deposit/redeem events — those fees go to the treasury, not LPs"
  );
  assert.match(
    body,
    /volumeWei \* BigInt\(swapFeeBps\)/,
    "fee revenue must be swap volume x swapFeeBps — the rate the AMM itself charges"
  );
});

test("LP APR's TVL denominator is the full two-sided pool value, exactly 2x the ETH reserve", async () => {
  const source = await fs.readFile(statsUrl, "utf8");
  const start = source.indexOf("function computeLpApr(");
  // computeLpApr is the last plain (non-exported) `function` before
  // computeLpAprWindows (an `export function`, so a bare "function " marker
  // alone wouldn't stop there, and would otherwise spill into that sibling
  // helper's own body/leading doc-comment) — bound on this function's own
  // closing brace-then-blank-line instead. CRLF-tolerant: this repo's
  // checked-out line endings aren't guaranteed to be \n.
  const end = findFunctionEnd(source, start);
  const body = source.slice(start, end > start ? end : undefined);

  assert.match(
    body,
    /ethReserveWei \* BigInt\(2\)/,
    "an LP holds both sides of a constant-product pool; at the AMM's own spot price the two sides are worth the same by construction, so pool value is exactly 2x the ETH reserve — dividing by one side alone overstates the rate by exactly 2x"
  );
  assert.match(
    body,
    /annualizeApr\(feeRevenueWei, poolValueWei, hoursObserved\)/,
    "annualizeApr must be called with the 2x pool value, not ethReserveWei directly"
  );
});

test("legacy (share-fee) vaults never get LP APR computed — they have no swap fee at all", async () => {
  const source = await fs.readFile(statsUrl, "utf8");
  const start = source.indexOf("export async function getVaultStats(");
  const end = source.indexOf("async function estimateMarketplaceFeeRevenue");
  assert.ok(start >= 0 && end > start, "could not locate getVaultStats");
  const body = source.slice(start, end);

  assert.match(
    body,
    /feeSchedule\.model === "eth"\s*\n\s*\? computeLpApr\(/,
    "computeLpApr must be gated to the eth-fee (V3) model — legacy buyShares/sellShares apply no fee, so there is no LP yield to compute for them"
  );
});

test("LP APR returns null, not a fabricated window, when there is no measurable swap volume", async () => {
  const source = await fs.readFile(statsUrl, "utf8");
  const start = source.indexOf("function computeLpApr(");
  // computeLpApr is the last plain (non-exported) `function` before
  // computeLpAprWindows (an `export function`, so a bare "function " marker
  // alone wouldn't stop there, and would otherwise spill into that sibling
  // helper's own body/leading doc-comment) — bound on this function's own
  // closing brace-then-blank-line instead. CRLF-tolerant: this repo's
  // checked-out line endings aren't guaranteed to be \n.
  const end = findFunctionEnd(source, start);
  const body = source.slice(start, end > start ? end : undefined);

  assert.match(
    body,
    /if \(volumeWei <= BigInt\(0\) \|\| earliest === Infinity\) return none;/,
    "no swap volume, or volume with no parseable timestamp, must both return the null shape rather than asserting a window"
  );

  // Outside of comments, the only literal "24" allowed is the hours-per-day
  // factor inside the real annualization math (24 * 365) — never a stand-in
  // window assigned to a variable like `hours` or `aprBasisHours`.
  const codeOnly = body
    .split("\n")
    .filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("*"))
    .join("\n");
  const literalHourWindows = codeOnly.match(/[^0-9]24(?!\s*\*\s*365)(?![0-9])/g) ?? [];
  assert.equal(
    literalHourWindows.length,
    0,
    `found a bare literal "24" outside the 24*365 annualization factor: ${JSON.stringify(literalHourWindows)}`
  );
});

test("REGRESSION (round 4): MIN_SWAPS_FOR_APR is a real gate, not a floor swapCount gets clamped up to", async () => {
  const source = await fs.readFile(statsUrl, "utf8");
  const start = source.indexOf("function computeLpApr(");
  // computeLpApr is the last plain (non-exported) `function` before
  // computeLpAprWindows (an `export function`, so a bare "function " marker
  // alone wouldn't stop there, and would otherwise spill into that sibling
  // helper's own body/leading doc-comment) — bound on this function's own
  // closing brace-then-blank-line instead. CRLF-tolerant: this repo's
  // checked-out line endings aren't guaranteed to be \n.
  const end = findFunctionEnd(source, start);
  const body = source.slice(start, end > start ? end : undefined);

  assert.match(
    body,
    /if \(swapCount < MIN_SWAPS_FOR_APR\) return none;/,
    "too few swap events must return the null shape outright, not get topped up to the minimum count"
  );
  assert.ok(
    !/Math\.max\([^)]*swapCount/.test(body),
    "swapCount must never be clamped up with Math.max — that is the exact round-3 bug applied to a second variable"
  );
});

test("all four 'valid' LP APR conditions are documented in one place, not scattered", async () => {
  const source = await fs.readFile(statsUrl, "utf8");
  const start = source.indexOf("const MIN_HOURS_FOR_APR");
  assert.ok(start >= 0, "could not locate the MIN_HOURS_FOR_APR declaration");
  const docStart = source.lastIndexOf("/**", start);
  const doc = source.slice(docStart, start);

  for (const condition of [
    "swapFeeBps > 0",
    "parseable timestamp",
    "MIN_HOURS_FOR_APR",
    "MIN_SWAPS_FOR_APR",
  ]) {
    assert.ok(
      doc.includes(condition),
      `the "valid" definition docstring must mention "${condition}" — all four conditions belong in this one place`
    );
  }
});

function swapEvent(kind: "buy" | "sell", ethWei: string, isoTimestamp: string): VaultTradeEvent {
  return {
    kind,
    address: "0x1111111111111111111111111111111111111111",
    ethWei,
    sharesWei: "1000000000000000000",
    tokenId: null,
    txHash: `0x${"a".repeat(64)}`,
    blockNumber: 1,
    logIndex: 0,
    timestamp: isoTimestamp,
    vaultAddress: "0x2222222222222222222222222222222222222222",
  };
}

/** N swap events of 0.1 ETH each, evenly spaced across `hours` — enough to
 *  isolate "is the window long enough" from "are there enough swaps" in
 *  tests below by holding the other variable comfortably clear of its bar. */
function evenlySpacedSwaps(count: number, hours: number): VaultTradeEvent[] {
  const startMs = Date.parse("2026-08-01T00:00:00.000Z");
  const stepMs = count > 1 ? (hours * 3600 * 1000) / (count - 1) : 0;
  return Array.from({ length: count }, (_, i) =>
    swapEvent(i % 2 === 0 ? "buy" : "sell", "100000000000000000", new Date(startMs + i * stepMs).toISOString())
  );
}

const VAULT = "0x2222222222222222222222222222222222222222";
const ETH_RESERVE = BigInt(1_000_000_000_000_000_000); // 1 ETH
const SWAP_FEE_BPS = 30; // 0.3%

test("REGRESSION (round 3): a real window thinner than MIN_HOURS_FOR_APR returns the null shape, not a clamped one", () => {
  // 5 swaps (clears MIN_SWAPS_FOR_APR) but only 5 minutes apart —
  // Math.max(realSpan, MIN_HOURS_FOR_APR) used to clamp this up to a
  // reported 1h basis and annualize against it. The true measured span here
  // is 5 minutes, far short of the 24h minimum — isolating the window gate
  // from the swap-count gate below.
  const events = evenlySpacedSwaps(5, 5 / 60);
  const result = computeLpApr(events, ETH_RESERVE, SWAP_FEE_BPS, VAULT);
  assert.equal(result.aprPct, null, "a 5-minute window must not produce a rate");
  assert.equal(result.aprBasisHours, null, "a 5-minute window must not be reported as a basis at all");
});

test("REGRESSION (round 3): a real window just under 24h also returns null, not a boundary-adjacent number", () => {
  const events = evenlySpacedSwaps(5, 23 + 59 / 60); // 23h59m, 5 swaps
  const result = computeLpApr(events, ETH_RESERVE, SWAP_FEE_BPS, VAULT);
  assert.equal(result.aprPct, null);
  assert.equal(result.aprBasisHours, null);
});

test("REGRESSION (round 4): a real 24h+ window with fewer than MIN_SWAPS_FOR_APR events also returns null", () => {
  // The window alone clearing 24h is not enough — a pool can sit for a day
  // and take two trades. Four swaps, comfortably over 24h, must still be
  // rejected: 24 elapsed hours with a four-event sample is a thin number
  // wearing a respectable window.
  const events = evenlySpacedSwaps(4, 48);
  const result = computeLpApr(events, ETH_RESERVE, SWAP_FEE_BPS, VAULT);
  assert.equal(result.aprPct, null, "fewer than MIN_SWAPS_FOR_APR events must not produce a rate, however long the window");
  assert.equal(result.aprBasisHours, null);
});

test("a real window at/above MIN_HOURS_FOR_APR with at least MIN_SWAPS_FOR_APR events returns a genuine measured rate and basis", () => {
  // 5 swaps of 0.1 ETH each (0.5 ETH total volume) over exactly 24h, against
  // a 1 ETH reserve — both conditions clear their bar simultaneously. The
  // exact aprPct figure isn't the point of this test (annualizeApr's math is
  // covered elsewhere) — that it's a REAL, non-null, non-clamped number with
  // the true 24h span reported is.
  const events = evenlySpacedSwaps(5, 24);
  const result = computeLpApr(events, ETH_RESERVE, SWAP_FEE_BPS, VAULT);
  assert.notEqual(result.aprPct, null, "a genuine 24h window with 5 swaps must produce a rate");
  assert.equal(result.aprBasisHours, 24, "the reported basis must be the true measured span, not a clamped one");
});

/**
 * computeLpAprWindows: the 24h/7d figures shown alongside the full-history
 * one on the dashboard (owner request, 2026-09-05 — "keep full but also
 * include 24 hour and 7 day"). Same gates as computeLpApr throughout —
 * these tests exist to prove the windowing itself (which events fall
 * inside a cutoff) is correct, not to re-litigate annualizeApr's math.
 */
test("computeLpAprWindows: a real 24h window with enough swaps reports a genuine 24h figure, independent of full history", () => {
  // 30 days of steady trading (comfortably clears the full-history gates on
  // its own), PLUS exactly 5 more swaps packed into the most recent 24h —
  // the 24h figure must be computed from ONLY those 5 recent swaps, not
  // diluted by (or blind to) the other 25 days of volume.
  const oldEvents = evenlySpacedSwaps(20, 30 * 24);
  const recentEvents = evenlySpacedSwaps(5, 24).map((e) => ({
    ...e,
    // Shift so these 5 land in the most recent 24h relative to "now" below.
    timestamp: new Date(Date.parse(e.timestamp!) + 29 * 24 * 3600 * 1000).toISOString(),
  }));
  const events = [...oldEvents, ...recentEvents];
  const nowSec = Date.parse(recentEvents[recentEvents.length - 1].timestamp!) / 1000;

  const { full, windows } = computeLpAprWindows(events, ETH_RESERVE, SWAP_FEE_BPS, VAULT, nowSec);
  assert.notEqual(full.aprPct, null, "full-history figure must be real given 25 real swaps over 30 real days");
  assert.notEqual(windows["24h"].aprPct, null, "24h figure must be real given exactly 5 real swaps inside the last 24h");
  assert.ok(windows["24h"].aprBasisHours! <= 24, "the 24h figure's own measured span must not exceed the 24h cutoff");
});

test("computeLpAprWindows: a quiet vault's 24h/7d figures correctly return null next to a real full-history figure", () => {
  // 25 real swaps over 30 real days clears the full-history gates, but
  // nothing at all happened in the last 24h or 7d — those windows must be
  // null, not a stale/carried-over copy of the full-history number, and
  // not a fabricated one either.
  const events = evenlySpacedSwaps(25, 30 * 24);
  const nowSec = Date.parse(events[events.length - 1].timestamp!) / 1000 + 40 * 24 * 3600; // 40 real days after the last swap

  const { full, windows } = computeLpAprWindows(events, ETH_RESERVE, SWAP_FEE_BPS, VAULT, nowSec);
  assert.notEqual(full.aprPct, null, "full-history figure must still be real — this vault genuinely traded");
  assert.equal(windows["24h"].aprPct, null, "no swaps at all in the last 24h must report null, not a stale copy");
  assert.equal(windows["7d"].aprPct, null, "no swaps at all in the last 7d must report null, not a stale copy");
});

test("computeLpAprWindows: an event with no parseable timestamp is dropped from a windowed figure, not guessed into it", () => {
  const events = evenlySpacedSwaps(5, 24);
  events[2] = { ...events[2], timestamp: null };
  const nowSec = Date.parse(events[events.length - 1].timestamp!) / 1000;

  const { windows } = computeLpAprWindows(events, ETH_RESERVE, SWAP_FEE_BPS, VAULT, nowSec);
  // Only 4 of the 5 events carry a usable timestamp once one is stripped —
  // MIN_SWAPS_FOR_APR (5) is no longer cleared inside the window, so this
  // must come back null, not silently include the undated event to keep
  // the count up.
  assert.equal(windows["24h"].aprPct, null, "an undated event must not be counted into a windowed figure either way");
});

test("getVaultStats seeds both treasury revenue and LP APR as null/zero before the activity replay runs", async () => {
  const source = await fs.readFile(statsUrl, "utf8");
  const start = source.indexOf("export async function getVaultStats(");
  const end = source.indexOf("async function estimateMarketplaceFeeRevenue");
  assert.ok(start >= 0 && end > start, "could not locate getVaultStats");
  const body = source.slice(start, end);

  assert.ok(
    !body.includes("heldTokenCount > 0 && depositFeeWei"),
    "getVaultStats must not pre-seed APR from heldTokenCount before the real replay result is known"
  );
  assert.match(
    body,
    /const noLpApr = \{ aprPct: null as number \| null, aprBasisHours: null as number \| null \};/,
    "the pre-replay/fallback LP APR value must be the null shape"
  );
});

test("treasury fee revenue (deposit/redeem) is never labeled or treated as LP APR in its own docstring", async () => {
  const source = await fs.readFile(statsUrl, "utf8");
  const start = source.indexOf("function computeTreasuryFeeActivity(");
  assert.ok(start >= 0, "could not locate computeTreasuryFeeActivity");
  const docStart = source.lastIndexOf("/**", start);
  const doc = source.slice(docStart, start);

  assert.match(
    doc,
    /TREASURY revenue/,
    "computeTreasuryFeeActivity's docstring must call out that this is treasury income, not LP yield"
  );
});
