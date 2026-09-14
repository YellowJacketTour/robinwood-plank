import assert from "node:assert/strict";
import test, { after } from "node:test";
import { readFileSync } from "node:fs";
import { hasPostgresConfig, closePostgres } from "../../lib/postgres";
import { getChainCounts, getChainLiveFloorCounts } from "../../lib/market/multichain/store";

const HUB = readFileSync("components/market/GlobalMarketHub.tsx", "utf8");
const HOOK = readFileSync("hooks/useLiveChainCounts.ts", "utf8");
const ROUTE = readFileSync("app/api/market/multichain/chain-counts/route.ts", "utf8");
const SKIP = { skip: !hasPostgresConfig() };

test("the hub ranks by 24h volume by default, not by a grade that is uniform at the top", () => {
  assert.match(HUB, /const DEFAULT_SORT_COLUMN: SortColumn = "volume";/);
  assert.match(HUB, /useState<SortColumn>\(\(\) => \(searchParams\.get\("sort"\) as SortColumn\) \|\| DEFAULT_SORT_COLUMN\)/);
  // The URL sync omits exactly the default -- a link with no ?sort= must
  // restore the same view the default renders.
  assert.match(HUB, /if \(sortColumn !== DEFAULT_SORT_COLUMN\) params\.set\("sort", sortColumn\);/);
  assert.doesNotMatch(HUB, /sortColumn !== "grade"\)/, "the URL sync must not assume a stale default");
  assert.doesNotMatch(HUB, /\|\| "grade"\)/, "grade must not be the default");
});

test("a grade column that is one letter throughout the view says so in its header", () => {
  assert.match(HUB, /const uniformGrade = useMemo\(/);
  assert.match(HUB, /letters\.size === 1 \? \[\.\.\.letters\]\[0\] : null/);
  assert.match(HUB, /Grade <span className="font-normal opacity-60">· all \{uniformGrade\}<\/span>/);
});

test("the volume sort prices USD-only volumes (a USDC-settled collection must not sort last)", () => {
  // The comparator goes through volumeUsdForSort, which reads the display
  // helper's kind: native wei through the live rate, or the stored USD.
  const at = HUB.indexOf('case "volume": {');
  assert.ok(at >= 0);
  const block = HUB.slice(at, HUB.indexOf('case "sales":', at));
  assert.match(block, /volumeUsdForSort\(a, window, toUsd\)/);
  assert.match(block, /volumeUsdForSort\(b, window, toUsd\)/);
  assert.doesNotMatch(block, /toUsd\(windowVolumeWei\(/, "the wei-only comparator is gone");
  const fn = HUB.slice(HUB.indexOf("export function volumeUsdForSort"), HUB.indexOf("function displayChangePct"));
  assert.match(fn, /display\.kind === "native"/);
  assert.match(fn, /display\.kind === "usd"\) return Number\(display\.usd\)/);
});

test("the chain chips lead with live-floor counts and keep the tracked total in the 'of' idiom", () => {
  assert.match(ROUTE, /Promise\.all\(\[getChainCounts\(\), getChainLiveFloorCounts\(\)\]\)/);
  assert.match(ROUTE, /\{ counts, withFloor, total, asOf/);
  assert.match(HOOK, /withFloor: data\.withFloor \?\? \{\}/);
  assert.match(HUB, /chainLiveFloors\?\.\[slug\] != null \?/);
  assert.match(HUB, /of \{count\.toLocaleString\(\)\}/);
});

test("live-floor counts are a subset of tracked counts, per chain", SKIP, async () => {
  const [tracked, live] = await Promise.all([getChainCounts(), getChainLiveFloorCounts()]);
  for (const [chain, n] of Object.entries(live)) {
    assert.ok(Number.isInteger(n) && n >= 0, `${chain}: ${n}`);
    assert.ok(n <= (tracked[chain] ?? 0), `${chain}: ${n} with a floor cannot exceed ${tracked[chain] ?? 0} tracked`);
  }
});

after(closePostgres);
