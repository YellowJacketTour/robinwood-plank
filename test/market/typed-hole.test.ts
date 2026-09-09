import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  chainHasNoSource,
  classifyHole,
  isSchedulable,
} from "../../components/market/TypedHole";

/**
 * Typed holes: the four kinds of "we do not have this", and why collapsing
 * them into one dash was the most expensive character on the site.
 *
 * Measured on production 2026-09-09, signed in through the backstage door:
 * 80 % of Global Market rows had no holder count, 85 % no listed count, 68 %
 * no creator badge, 68 % had real sales and a blank 24 h change. All rendered
 * as the same em-dash, which cannot be told apart from zero, from "not
 * fetched", from "this chain has no source", or from "we failed".
 *
 * The explanations already existed and were already honest -- emptyCellReason
 * in GlobalMarketHub.tsx, whose own comment records that those strings were
 * rewritten once to stop promising data the pipeline could not deliver. They
 * were delivered through a `title` attribute: invisible until hover, absent on
 * touch, unreliable to a screen reader.
 *
 * The classification is the load-bearing part, because it decides what the
 * scheduler does. Only `unfetched` is worth queueing.
 */

const SRC = readFileSync("components/market/TypedHole.tsx", "utf8").replace(/\r\n/g, "\n");
const HUB = readFileSync("components/market/GlobalMarketHub.tsx", "utf8").replace(/\r\n/g, "\n");

test("an observed zero is a FACT, not a hole", () => {
  // The subtlest of the four. A collection with genuinely zero listings must
  // show 0; a dash there implies we do not know, when in fact we do.
  assert.equal(
    classifyHole({ field: "listed", chainSlug: "eth-mainnet", observedZero: true }),
    "none"
  );
  assert.equal(isSchedulable("none"), false, "a known answer must not be re-queued");
});

test("a chain with no source is unsourced, and never scheduled", () => {
  // Holder counts on Solana/Bitcoin: no clean single-call endpoint exists on
  // Helius DAS or UniSat/Ordiscan. Queueing it would burn budget forever on
  // work that cannot succeed.
  const kind = classifyHole({
    field: "holders",
    chainSlug: "solana-mainnet",
    chainHasNoSource: true,
  });
  assert.equal(kind, "unsourced");
  assert.equal(isSchedulable(kind), false, "fetching harder will never help");
});

test("a change with real sales is UNDERIVED, not unfetched", () => {
  // The Beezie case, measured live: 1,468 sales and no 24 h change, because
  // the ledger holds no priced native fills in the prior window. That is the
  // pair invariant working. It needs TIME, not another request.
  const kind = classifyHole({ field: "change", chainSlug: "base-mainnet", hasSales: true });
  assert.equal(kind, "underived");
  assert.equal(isSchedulable(kind), false, "re-fetching cannot manufacture a prior window");
});

test("a change with no sales is simply unfetched", () => {
  const kind = classifyHole({ field: "change", chainSlug: "eth-mainnet", hasSales: false });
  assert.equal(kind, "unfetched");
  assert.equal(isSchedulable(kind), true);
});

test("unfetched is the ONLY schedulable kind", () => {
  // The bridge to the attention beam: a rendered hole becomes a work order
  // only when fetching could actually fill it.
  assert.equal(isSchedulable("unfetched"), true);
  for (const k of ["unsourced", "underived", "none"] as const) {
    assert.equal(isSchedulable(k), false, `${k} must not enter the queue`);
  }
});

test("observedZero wins over every other signal", () => {
  // Precedence matters: a chain with no source that nonetheless reported a
  // real zero has an answer, and the answer beats the excuse.
  assert.equal(
    classifyHole({
      field: "holders",
      chainSlug: "solana-mainnet",
      chainHasNoSource: true,
      observedZero: true,
    }),
    "none"
  );
});

test("the no-source map matches the hub's own per-chain reasoning", () => {
  // If these drift, the beam queues work the UI has already explained is
  // impossible -- or stops queueing work that is merely slow.
  assert.equal(chainHasNoSource("solana-mainnet", "holders"), true);
  assert.equal(chainHasNoSource("bitcoin-mainnet", "holders"), true);
  assert.equal(chainHasNoSource("eth-mainnet", "holders"), false, "EVM holders are fetchable");
  assert.equal(chainHasNoSource("solana-mainnet", "volume"), false, "only holders are unsourced");
  // The hub says exactly this, in prose, and has since before this component.
  assert.match(
    HUB,
    /Holder counts aren't sourced for this chain yet/,
    "the hub's own reason string must still back this map"
  );
});

test("the four kinds are distinct and exhaustive", () => {
  // If two kinds ever render identically we are back to the dash.
  const kinds = ["unfetched", "unsourced", "underived", "none"] as const;
  const shorts = kinds.map((k) => SRC.match(new RegExp(`${k}:\\s*"([^"]+)"`))?.[1]);
  assert.equal(new Set(shorts).size, kinds.length, `each kind needs its own label, saw ${shorts}`);
  assert.ok(shorts.every(Boolean), "every kind must have a label");
});

test("a hole is never rendered as a bare dash", () => {
  // The regression that would undo the whole point.
  assert.ok(!/>\s*—\s*</.test(SRC), "the component must not emit an em-dash");
  assert.ok(!/"—"/.test(SRC), "nor carry one as a label");
});

test("the explanation reaches assistive tech, not just a hover", () => {
  // `title` alone is not announced reliably and does not exist on touch. A
  // bare dash announces as nothing at all, which is how most of the table was
  // silent to a screen reader.
  assert.match(SRC, /aria-label=/, "the reason must be exposed to a screen reader");
  assert.match(SRC, /title=\{reason\}/, "and still available on hover for sighted users");
});

test("the kind is exposed to the DOM so the scheduler can find it", () => {
  // A rendered hole IS the demand signal. It has to be selectable.
  assert.match(SRC, /data-hole=\{kind\}/, "the kind must be queryable from the page");
});

test("a hole never outshouts a real value", () => {
  // A table that is mostly holes must still read as a table of numbers, or
  // the honesty costs more than the dash did.
  const tone = SRC.slice(SRC.indexOf("const TONE"), SRC.indexOf("export function TypedHole"));
  assert.match(tone, /unfetched:.*\/4\d/, "muted opacity for absent values");
  assert.ok(
    !/text-red|font-bold|animate-/.test(tone),
    "a hole is not an error and must not be styled as one"
  );
});

/**
 * The wiring. A component nobody renders is a document, not a feature -- and
 * this repo has already shipped a complete, tested module whose production
 * path was a no-op because one branch was missing.
 */
test("every dash cell in the hub is now a typed hole", () => {
  // The five columns measured as mostly-empty on production: change, volume,
  // sales, listed, holders.
  for (const field of ["change", "volume", "sales", "listed", "holders"]) {
    assert.ok(
      HUB.includes(`holeFor(c, "${field}")`),
      `${field} must render a typed hole, not a dash`
    );
  }
});

test("no bare em-dash survives in a rankings cell", () => {
  // The regression this whole change exists to prevent.
  //
  // TWO earlier versions of this test were mirrors. The first matched the
  // exact original formatting, so reverting a cell with different whitespace
  // passed. The second counted emptyCellReason callers, which a mutation that
  // swaps holeFor for a direct call leaves unchanged -- one removed, one
  // added, net zero.
  //
  // The real invariant is not a count. It is that emptyCellReason has exactly
  // ONE caller and that caller is holeFor, so every reason reaches the screen
  // through a typed hole. Asserted structurally rather than numerically.
  const decl = HUB.indexOf("function emptyCellReason");
  assert.ok(decl > 0, "emptyCellReason must exist");

  // Every call site, excluding the declaration itself.
  const callSites: string[] = [];
  const re = /emptyCellReason\(c,\s*(?:field|"[a-z]+")\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(HUB)) !== null) {
    if (m.index === HUB.indexOf("emptyCellReason", decl) && m.index < decl + 40) continue;
    callSites.push(HUB.slice(Math.max(0, m.index - 120), m.index + m[0].length));
  }
  assert.ok(callSites.length > 0, "the reason must be used somewhere");
  for (const site of callSites) {
    assert.ok(
      /reason=\{emptyCellReason/.test(site),
      `emptyCellReason must only be read as a TypedHole's reason prop, saw:
${site.trim().slice(-100)}`
    );
  }

  // And no span anywhere may render a bare em-dash. This assertion found a
  // SIXTH dash cell (the floor column, which never carried a reason) and a
  // SEVENTH (a multi-line one that single-line greps missed).
  assert.ok(!/>\s*—\s*<\/span>/.test(HUB), "and no span may render a bare em-dash");
});
test("the hub classifies rather than hardcoding a kind", () => {
  // If the hub picked a kind itself, it would drift from classifyHole and the
  // scheduler would queue work the UI called impossible.
  assert.match(HUB, /classifyHole\(\{/, "the hub must classify, not assume");
  assert.match(HUB, /chainHasNoSource\(c\.chainSlug, field\)/, "and pass the real chain");
  assert.match(HUB, /hasSales: \(c\.sales24h \?\? 0\) > 0/, "and the real sales signal");
});

test("emptyCellReason is still the source of the explanation", () => {
  // The prose was already right. This change makes it visible; it must not
  // replace it with something new and worse.
  assert.match(HUB, /reason=\{emptyCellReason\(c, field\)\}/, "the existing reason must be used");
});
