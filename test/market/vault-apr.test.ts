import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";

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
 * These are source-level regression tests, matching the style of
 * vault-immutable-config.test.ts in this same directory — getVaultStats and
 * its helpers talk to live RPC/Blockscout and are not mocked anywhere in
 * this suite, so the invariants are pinned at the source instead.
 */

const statsUrl = new URL("../../lib/market/vault-stats.ts", import.meta.url);

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
  const end = source.indexOf("\nfunction ", start + 1);
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
  const end = source.indexOf("\nfunction ", start + 1);
  const body = source.slice(start, end > start ? end : undefined);

  assert.match(
    body,
    /ethReserveWei \* BigInt\(2\)/,
    "an LP is exposed to both sides of a constant-product pool; at the AMM's own spot price the two sides are worth the same by construction, so pool value is exactly 2x the ETH reserve"
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
  const end = source.indexOf("\nfunction ", start + 1);
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
