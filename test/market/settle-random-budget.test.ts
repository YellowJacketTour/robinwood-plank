import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

/**
 * `?public=1` was an unconditional bypass of CRON_SECRET.
 *
 * Found by a parallel security audit. The check read:
 *
 *     const url = new URL(req.url);
 *     if (url.searchParams.get("public") === "1") return true;
 *
 * -- returning true BEFORE the secret could matter. So anyone, anywhere, could
 * make the server spend RELAYER_PRIVATE_KEY gas, bounded only by a per-IP rate
 * limit that a distributed caller ignores, against a relayer wallet with no
 * spend cap at all.
 *
 * Deliberately NOT called theft: the on-chain action is permissionless, the
 * relayer only spends when a real pendingRequester() exists, and nothing is
 * stolen. It is unbounded gas griefing of our own wallet, which is a real
 * operational risk and not a fund-safety one. Calling it worse than it is
 * would be its own kind of dishonesty.
 *
 * The path itself is legitimate and must survive: a visitor finishing their
 * own redeem right after clicking, without the site handing a secret to the
 * browser. So it is bounded rather than removed.
 */

const SRC = readFileSync(
  "app/api/market/vault/settle-random/route.ts",
  "utf8"
).replace(/\r\n/g, "\n");

test("the public flag no longer returns true before the secret is checked", () => {
  // The exact bug. An unconditional early true, above the Bearer comparison.
  assert.ok(
    !/if \(url\.searchParams\.get\("public"\) === "1"\) return true;/.test(SRC),
    "?public=1 must not be an unconditional bypass"
  );
  assert.match(
    SRC,
    /if \(url\.searchParams\.get\("public"\) !== "1"\) return false;/,
    "the public path must be a narrowing, not a widening"
  );
});

test("the public path requires same-origin", () => {
  // A scripted caller has no Origin and no Referer; a click on our own page
  // always has at least one.
  assert.match(SRC, /return isSameOrigin\(req\);/, "the public path must check the origin");
  const at = SRC.indexOf("function isSameOrigin");
  assert.ok(at > 0, "the check must exist");
  // Bound on the function's own closing brace at column 0, not the first
  // newline-brace -- which is the inner catch block. Slicing there read
  // half the function and failed while the code was correct.
  const body = SRC.slice(at, SRC.indexOf("\n}\n", at) + 2);
  assert.match(body, /req\.headers\.get\("origin"\)/, "Origin is sent on cross-origin fetches");
  assert.match(body, /req\.headers\.get\("referer"\)/, "Referer on same-origin ones");
  // The default when neither header is present. A scripted caller sends
  // neither, so this is the branch that does the real work.
  const lines = body.trim().split("\n");
  assert.equal(
    lines[lines.length - 2]!.trim(),
    "return false;",
    "absent BOTH headers must be refused, not trusted"
  );
});

test("the day's public settlements are capped", () => {
  // Same-origin alone is not enough: an XSS, or a determined browser loop,
  // would still be same-origin. The cap is the second, independent bound.
  assert.match(SRC, /PUBLIC_SETTLE_DAILY_CAP/, "a daily cap must exist");
  const m = SRC.match(/const PUBLIC_SETTLE_DAILY_CAP = (\d+);/);
  assert.ok(m, "the cap must be a real number");
  const cap = Number(m[1]);
  assert.ok(cap > 0 && cap <= 5_000, `the cap must bound real spend (saw ${cap})`);
});

test("the budget is durable, not per-instance", () => {
  // The rate limiter is in-process, so on a multi-instance deploy an
  // in-memory counter is silently multiplied by the instance count -- which
  // is exactly the bound an attacker would be defeating.
  const at = SRC.indexOf("async function takePublicSettleBudget");
  assert.ok(at > 0, "the budget helper must exist");
  const body = SRC.slice(at, SRC.indexOf("\n}", SRC.indexOf("durableKv.set", at)));
  assert.match(body, /durableKv\.get/, "the count must be read from shared storage");
  assert.match(body, /durableKv\.set/, "and written back there");
  assert.ok(!/new Map|let count/.test(body), "an in-process counter would not bound anything");
});

test("the budget is keyed per UTC day", () => {
  // A cap with no reset is a one-way door: once spent, the feature is dead
  // for every future visitor.
  assert.match(SRC, /toISOString\(\)\.slice\(0, 10\)/, "the key must roll daily");
  assert.match(SRC, /\{ ex: 2 \* 24 \* 3600 \}/, "and expire so the table does not grow forever");
});

test("a missing cache fails OPEN, not closed", () => {
  // A legitimate user's redeem must not break because a cache is unavailable
  // -- and the same-origin check still stands in front of it, so failing open
  // here does not remove the bound, it removes the SECOND bound.
  const at = SRC.indexOf("async function takePublicSettleBudget");
  const body = SRC.slice(at, SRC.indexOf("\n}\n", at));
  assert.match(body, /if \(!hasDurableKv\(\)\) return true;/, "no KV means no cap, not no service");
  assert.match(body, /catch \{\s*\n\s*return true;/, "and a KV error must not block a redeem");
});

test("only the public path spends the budget", () => {
  // An authenticated cron caller is trusted and uncapped -- that is the whole
  // point of holding the secret. Capping it would break scheduled settlement.
  assert.match(SRC, /const isPublicPath = /, "the two paths must be distinguished");
  assert.match(
    SRC,
    /if \(isPublicPath && !\(await takePublicSettleBudget\(\)\)\)/,
    "the budget must apply to the public path only"
  );
});

test("a spent budget answers 429, not a silent no-op", () => {
  // A refusal the caller cannot see is indistinguishable from a broken
  // feature, and 429 is the status a client should retry against later.
  assert.match(SRC, /SETTLE_BUDGET_SPENT/, "the refusal must be named");
  assert.match(SRC, /\},\s*429,\s*\)/, "and returned as 429");
});

test("the authenticated paths still work", () => {
  // The fix must not break cron. Both header forms must survive.
  assert.match(SRC, /Bearer \$\{secret\}/, "the Bearer path must remain");
  assert.match(SRC, /x-plank-settle/, "and the header path");
});
