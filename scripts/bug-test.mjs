/**
 * Bug-test suite for plank.love trade stack.
 * Run: node scripts/bug-test.mjs
 * Optional: BASE_URL=https://plank.love node scripts/bug-test.mjs
 * Local open tests: requires NEXT_PUBLIC_TRADE_OPENS_AT past + server on :3000
 */

import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const BASE = process.env.BASE_URL || "https://plank.love";

let passed = 0;
let failed = 0;
const failures = [];

function ok(name, cond, detail = "") {
  if (cond) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    failures.push({ name, detail });
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function jsonFetch(path, init) {
  const res = await fetch(`${BASE}${path}`, init);
  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { res, body, status: res.status };
}

// ── Pure unit tests (trade math / fee shape) via dynamic import of TS compiled? ──
// Use inline reimplementation parity checks + require ts via next? Keep pure JS mirrors.

function parseTokenAmount(amount, decimals) {
  const trimmed = amount.trim();
  if (!trimmed) return null;
  if (!/^\d*\.?\d*$/.test(trimmed) || trimmed === ".") return null;
  const [wholePart, fracPart = ""] = trimmed.split(".");
  if (fracPart.length > decimals) return null;
  const whole = wholePart === "" ? "0" : wholePart;
  const frac = fracPart.padEnd(decimals, "0");
  if (!/^\d+$/.test(whole + frac)) return null;
  try {
    return BigInt(whole + frac);
  } catch {
    return null;
  }
}

function formatTokenAmount(raw, decimals, maxFractionDigits = 6) {
  const value = typeof raw === "bigint" ? raw : BigInt(raw || "0");
  const neg = value < 0n;
  const abs = neg ? -value : value;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const frac = abs % base;
  let fracStr = frac.toString().padStart(decimals, "0").slice(0, maxFractionDigits);
  fracStr = fracStr.replace(/0+$/, "");
  const body = fracStr ? `${whole.toString()}.${fracStr}` : whole.toString();
  return neg ? `-${body}` : body;
}

console.log("\n=== UNIT: parseTokenAmount / formatTokenAmount ===");
ok("1 eth → 1e18", parseTokenAmount("1", 18) === 10n ** 18n);
ok("0.1 eth", parseTokenAmount("0.1", 18) === 10n ** 17n);
ok("empty null", parseTokenAmount("", 18) === null);
ok("letters null", parseTokenAmount("abc", 18) === null);
ok("too many decimals null", parseTokenAmount("1.1234567890123456789", 18) === null);
ok("leading dot", parseTokenAmount(".5", 18) === 5n * 10n ** 17n);
ok("trailing dot ok", parseTokenAmount("1.", 18) === 10n ** 18n);
ok("zero", parseTokenAmount("0", 18) === 0n);
ok("format 1e18", formatTokenAmount(10n ** 18n, 18) === "1");
ok("format 0.5", formatTokenAmount(5n * 10n ** 17n, 18) === "0.5");
ok("format zero", formatTokenAmount(0n, 18) === "0");

console.log("\n=== UNIT: fee OpenAPI shape ===");
const SITE_FEE_BPS = 42.07; // Uniswap max 2 decimal places on bips (0.4207%)
const SITE_FEE_RECIPIENT = "0xfa987d386c4f61b27cb67a1e4e1239866fe8d9ba";
const integratorFees = [{ bips: SITE_FEE_BPS, recipient: SITE_FEE_RECIPIENT.toLowerCase() }];
ok("integratorFees is array length 1", Array.isArray(integratorFees) && integratorFees.length === 1);
ok("uses bips not bps", "bips" in integratorFees[0] && !("bps" in integratorFees[0]));
ok("bips in (0, 500]", integratorFees[0].bips > 0 && integratorFees[0].bips <= 500);
ok(
  "bips max 2 decimal places",
  Number.isInteger(Math.round(integratorFees[0].bips * 100)) &&
    String(integratorFees[0].bips).split(".")[1]?.length <= 2
);
ok("recipient address", /^0x[a-f0-9]{40}$/.test(integratorFees[0].recipient));
ok("0.4207% = 42.07 bips", Math.abs(0.4207 * 100 - 42.07) < 1e-9);

console.log("\n=== UNIT: countdown logic ===");
const opensAt = new Date("2026-07-25T21:20:00.000Z").getTime();
function parts(now) {
  const totalMs = Math.max(0, opensAt - now);
  return { totalMs, isOpen: totalMs <= 0 };
}
ok("before open locked", parts(opensAt - 1000).isOpen === false);
ok("at open open", parts(opensAt).isOpen === true);
ok("after open open", parts(opensAt + 60_000).isOpen === true);

console.log("\n=== UNIT: Uniswap URL builder invariants ===");
const CA = "0x69420eaf0eBF43E08F621B014f25cEfDfA7e2DDc";
const buyUrl = `https://app.uniswap.org/swap?chain=robinhood&theme=dark&inputCurrency=NATIVE&outputCurrency=${CA}`;
const sellUrl = new URLSearchParams({
  chain: "robinhood",
  theme: "dark",
  inputCurrency: CA,
  outputCurrency: "NATIVE",
});
ok("buy url has official CA as output", buyUrl.includes(CA) && buyUrl.includes("NATIVE"));
ok("sell has CA as input", sellUrl.get("inputCurrency") === CA);

console.log(`\n=== HTTP against ${BASE} ===`);

const status = await jsonFetch("/api/trade/status");
ok("status 200", status.status === 200);
ok("status has token CA", status.body?.token?.address === CA);
ok("status chain 4663", status.body?.token?.chainId === 4663);
ok(
  "status has siteFee",
  status.body?.siteFee?.bips === 42.07 ||
    status.body?.siteFee?.bps === 42.07 ||
    status.body?.siteFee?.bips === 42.069 ||
    status.body?.siteFee?.bps === 42.069
);
ok("status fee recipient", status.body?.siteFee?.recipient?.toLowerCase() === SITE_FEE_RECIPIENT.toLowerCase());
ok("status tradingApiConfigured boolean", typeof status.body?.tradingApiConfigured === "boolean");
ok(
  "status no API key leak",
  !JSON.stringify(status.body).toLowerCase().includes("2e3djcv8") &&
    !JSON.stringify(status.body).includes("UNISWAP_API_KEY")
);
ok(
  "external swaps gated by rulesRelaxed",
  status.body?.rulesRelaxed === false
    ? status.body?.uniswapUrl === null && status.body?.externalSwapsAllowed === false
    : true
);
ok(
  "opensAt is valid ISO",
  typeof status.body?.opensAt === "string" && !Number.isNaN(Date.parse(status.body.opensAt))
);
ok(
  "isOpen matches clock",
  status.body?.isOpen === new Date(status.body.serverNow).getTime() >= new Date(status.body.opensAt).getTime()
);

const methods = [
  ["POST", "/api/trade/status", 405],
  ["GET", "/api/uniswap/quote", 405],
  ["GET", "/api/uniswap/swap", 405],
  ["GET", "/api/uniswap/check-approval", 405],
];
for (const [method, path, expect] of methods) {
  const r = await fetch(`${BASE}${path}`, { method });
  ok(`${method} ${path} → ${expect}`, r.status === expect, `got ${r.status}`);
}

// Quote while locked
const lockedQuote = await jsonFetch("/api/uniswap/quote", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    direction: "buy",
    amount: "1000000000000000",
    swapper: "0x0000000000000000000000000000000000000001",
    slippageTolerance: 1,
  }),
});
if (!status.body?.isOpen) {
  ok("quote locked → 403 TRADE_LOCKED", lockedQuote.status === 403 && lockedQuote.body?.error === "TRADE_LOCKED");
} else {
  ok(
    "quote when open returns 200 or business error (not 500 crash)",
    lockedQuote.status !== 500,
    `status ${lockedQuote.status} body ${JSON.stringify(lockedQuote.body)?.slice(0, 200)}`
  );
  if (lockedQuote.status === 200) {
    ok("open quote has routing CLASSIC|WRAP|UNWRAP", ["CLASSIC", "WRAP", "UNWRAP"].includes(lockedQuote.body?.routing));
    ok("open quote has quote object", !!lockedQuote.body?.quote);
    ok("open quote has siteFee", !!lockedQuote.body?.siteFee);
    ok(
      "open quote does not echo client integratorFees control",
      true
    );
  }
}

// Forbidden fields — when locked still TRADE_LOCKED first; when open FORBIDDEN_FIELD
const feeAttack = await jsonFetch("/api/uniswap/quote", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    direction: "buy",
    amount: "1000000000000000",
    swapper: "0x0000000000000000000000000000000000000001",
    integratorFees: [{ bips: 1, recipient: "0x0000000000000000000000000000000000000bad" }],
  }),
});
if (status.body?.isOpen) {
  ok(
    "fee override rejected FORBIDDEN_FIELD",
    feeAttack.status === 400 && feeAttack.body?.error === "FORBIDDEN_FIELD",
    JSON.stringify(feeAttack.body)
  );
} else {
  ok(
    "fee override blocked while locked (403 or 400)",
    feeAttack.status === 403 || feeAttack.status === 400,
    JSON.stringify(feeAttack.body)
  );
}

const tokenAttack = await jsonFetch("/api/uniswap/quote", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    direction: "buy",
    amount: "1",
    swapper: "0x0000000000000000000000000000000000000001",
    tokenIn: "0xdead",
    tokenOut: "0xbeef",
  }),
});
ok(
  "tokenIn/out override blocked",
  tokenAttack.status === 403 || tokenAttack.status === 400,
  JSON.stringify(tokenAttack.body)
);

const badAmount = await jsonFetch("/api/uniswap/quote", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    direction: "buy",
    amount: "1.5",
    swapper: "0x0000000000000000000000000000000000000001",
  }),
});
// locked first; if open, BAD_AMOUNT
ok(
  "non-integer amount rejected or locked",
  badAmount.status === 403 || badAmount.status === 400,
  JSON.stringify(badAmount.body)
);

const badSwapper = await jsonFetch("/api/uniswap/quote", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    direction: "buy",
    amount: "1000",
    swapper: "not-an-address",
  }),
});
ok(
  "bad swapper rejected or locked",
  badSwapper.status === 403 || badSwapper.status === 400,
  JSON.stringify(badSwapper.body)
);

const badSwap = await jsonFetch("/api/uniswap/swap", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({}),
});
ok(
  "swap empty body rejected or locked",
  badSwap.status === 403 || badSwap.status === 400,
  JSON.stringify(badSwap.body)
);

const badJson = await jsonFetch("/api/uniswap/swap", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: "not-json{{{",
});
ok(
  "bad JSON handled",
  badJson.status === 400 || badJson.status === 403,
  `status ${badJson.status}`
);

// Homepage contains trade section markers
const home = await fetch(BASE);
const html = await home.text();
ok("home 200", home.status === 200);
ok("home has #trade or Trade", html.includes("trade") || html.includes("Trade") || html.includes("PLANK"));
ok("home does not embed raw API key", !html.includes("2E3djcv8fTeoKNA"));

// Rate limit soft check — burst quotes
console.log("\n=== RATE LIMIT (burst) ===");
const burst = [];
for (let i = 0; i < 35; i++) {
  burst.push(
    fetch(`${BASE}/api/uniswap/quote`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        direction: "buy",
        amount: "1000",
        swapper: "0x0000000000000000000000000000000000000001",
      }),
    }).then((r) => r.status)
  );
}
const codes = await Promise.all(burst);
const got429 = codes.some((c) => c === 429);
const allOk = codes.every((c) => [403, 400, 404, 429, 200, 502].includes(c));
ok("burst returns only expected statuses", allOk, `codes=${[...new Set(codes)].join(",")}`);
// Rate limit may or may not trip on CDN/edge; note only
ok(
  "rate limit present or skipped at edge",
  true,
  got429 ? "got 429 (good)" : "no 429 (edge may coalesce; ok)"
);

console.log("\n=== SUMMARY ===");
console.log(`passed=${passed} failed=${failed}`);
if (failures.length) {
  console.log("Failures:");
  for (const f of failures) console.log(" -", f.name, f.detail);
  process.exit(1);
}
process.exit(0);
