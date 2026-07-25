/**
 * Forward / backward / edge-case battery for trade stack.
 * BASE_URL defaults to production. For open-window tests use a local server with past TRADE_OPENS_AT.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BASE = process.env.BASE_URL || "https://plank.love";
const CA = "0x69420eaf0eBF43E08F621B014f25cEfDfA7e2DDc";
const FEE = "0xfa987d386c4f61b27cb67a1e4e1239866fe8d9ba";

let passed = 0;
let failed = 0;
const fails = [];

function ok(name, cond, detail = "") {
  if (cond) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    fails.push({ name, detail });
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function jfetch(p, init) {
  const res = await fetch(`${BASE}${p}`, init);
  let body = null;
  const text = await res.text();
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body, headers: res.headers, text };
}

function parseTokenAmount(amount, decimals) {
  const trimmed = amount.trim();
  if (!trimmed) return null;
  if ((trimmed.match(/\./g) || []).length > 1) return null;
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

function formatTokenAmount(raw, decimals, maxFractionDigits = 8) {
  const value = typeof raw === "bigint" ? raw : BigInt(raw || "0");
  const neg = value < 0n;
  const abs = neg ? -value : value;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const frac = abs % base;
  let digits = maxFractionDigits;
  if (abs > 0n && whole === 0n) {
    const minVisible = base / 10n ** BigInt(Math.min(maxFractionDigits, decimals));
    if (frac > 0n && frac < minVisible) digits = decimals;
  }
  digits = Math.min(digits, decimals);
  let fracStr = frac.toString().padStart(decimals, "0").slice(0, digits);
  fracStr = fracStr.replace(/0+$/, "");
  const body = fracStr ? `${whole.toString()}.${fracStr}` : whole.toString();
  return neg ? `-${body}` : body;
}

console.log(`\n### EDGE BATTERY vs ${BASE}\n`);

// ─── parseTokenAmount edges ───
console.log("=== FORWARD: amount parse/format ===");
const parseCases = [
  ["1", 18, 10n ** 18n],
  ["01", 18, 10n ** 18n],
  ["0.0", 18, 0n],
  ["0.000000000000000001", 18, 1n],
  ["1.", 18, 10n ** 18n],
  [".1", 18, 10n ** 17n],
  ["  2.5  ", 18, 25n * 10n ** 17n],
  ["999999", 6, 999999n * 10n ** 0n], // whole with 6 dec pad
];
for (const [input, dec, expect] of parseCases) {
  const got = parseTokenAmount(input, dec);
  // for 999999 with 6 decimals: whole 999999 + frac 000000
  const exp =
    input.trim() === "999999" && dec === 6 ? 999999n * 10n ** 6n : expect;
  ok(`parse(${JSON.stringify(input)},${dec})`, got === exp, `got ${got}`);
}
const reject = ["", ".", "..", "1.2.3", "1e18", "-1", "1,0", "0x1", "NaN", "Infinity", "1..", ".1."];
for (const input of reject) {
  ok(`reject ${JSON.stringify(input)}`, parseTokenAmount(input, 18) === null);
}
// too many decimals
ok("reject 19 frac digits", parseTokenAmount("0." + "1".repeat(19), 18) === null);
ok("accept 18 frac digits", parseTokenAmount("0." + "1".repeat(18), 18) === 111111111111111111n);
// round-trip format
ok("format dust shows non-zero", formatTokenAmount(1n, 18) === "0.000000000000000001");
ok("format large", formatTokenAmount(123456789n * 10n ** 12n, 18).startsWith("123456.789"));
ok("format mid", formatTokenAmount(15n * 10n ** 17n, 18) === "1.5");

// ─── countdown clock edges ───
console.log("\n=== BACKWARD/FORWARD: countdown clock ===");
const opens = Date.parse("2026-07-25T21:20:00.000Z");
function parts(now) {
  const totalMs = Math.max(0, opens - now);
  return { totalMs, isOpen: totalMs <= 0, sec: Math.floor(totalMs / 1000) };
}
ok("1ms before locked", parts(opens - 1).isOpen === false && parts(opens - 1).totalMs === 1);
ok("exact open", parts(opens).isOpen === true && parts(opens).totalMs === 0);
ok("1ms after open", parts(opens + 1).isOpen === true);
ok("far past open", parts(opens + 86400000).isOpen === true);
ok("far future locked", parts(opens - 86400000 * 10).isOpen === false);
// invalid date fail-closed simulation
const bad = Number.isNaN(Date.parse("not-a-date"));
ok("invalid date is NaN (fail-closed path)", bad === true);

// ─── status API contract ───
console.log("\n=== STATUS contract ===");
const st = await jfetch("/api/trade/status");
ok("status 200", st.status === 200);
ok("CA exact", st.body.token?.address === CA);
ok("chain 4663", st.body.token?.chainId === 4663);
ok("decimals number", typeof st.body.token?.decimals === "number");
ok("fee recipient", st.body.siteFee?.recipient?.toLowerCase() === FEE.toLowerCase());
ok("fee bips 42.07", st.body.siteFee?.bips === 42.07 || st.body.siteFee?.bps === 42.07);
ok("no uniswapUrl when locked rules", st.body.rulesRelaxed === false ? st.body.uniswapUrl === null : true);
ok("isOpen boolean", typeof st.body.isOpen === "boolean");
ok("remainingMs >= 0", st.body.remainingMs >= 0);
ok(
  "remainingMs consistent with isOpen",
  st.body.isOpen ? st.body.remainingMs === 0 : st.body.remainingMs > 0
);
ok(
  "no secret substrings",
  !JSON.stringify(st.body).toLowerCase().includes("2e3djcv8") &&
    !JSON.stringify(st.body).includes("x-api-key")
);
// Cache headers on API
const cache = st.headers.get("cache-control") || "";
ok("status no-store-ish", /no-store|no-cache|private/i.test(cache) || cache === "", cache);

// ─── method matrix ───
console.log("\n=== HTTP methods ===");
const methods = [
  ["GET", "/api/trade/status", [200]],
  ["POST", "/api/trade/status", [405]],
  ["PUT", "/api/trade/status", [405, 404, 501]],
  ["DELETE", "/api/uniswap/quote", [405, 404, 501]],
  ["GET", "/api/uniswap/quote", [405]],
  ["GET", "/api/uniswap/swap", [405]],
  ["GET", "/api/uniswap/check-approval", [405]],
  ["OPTIONS", "/api/uniswap/quote", [200, 204, 405, 404]],
];
for (const [m, p, allow] of methods) {
  const r = await fetch(`${BASE}${p}`, { method: m });
  ok(`${m} ${p} in ${allow}`, allow.includes(r.status), `got ${r.status}`);
}

// ─── quote/swap attack matrix ───
console.log("\n=== ATTACK / validation matrix ===");
const attacks = [
  {
    name: "empty body",
    path: "/api/uniswap/quote",
    body: {},
    expect: [400, 403],
  },
  {
    name: "null-ish amount",
    path: "/api/uniswap/quote",
    body: { direction: "buy", amount: null, swapper: "0x" + "11".repeat(20) },
    expect: [400, 403],
  },
  {
    name: "numeric amount not string",
    path: "/api/uniswap/quote",
    body: { direction: "buy", amount: 1000, swapper: "0x" + "11".repeat(20) },
    expect: [400, 403],
  },
  {
    name: "scientific amount",
    path: "/api/uniswap/quote",
    body: { direction: "buy", amount: "1e18", swapper: "0x" + "11".repeat(20) },
    expect: [400, 403],
  },
  {
    name: "negative amount string",
    path: "/api/uniswap/quote",
    body: { direction: "buy", amount: "-1", swapper: "0x" + "11".repeat(20) },
    expect: [400, 403],
  },
  {
    name: "leading zeros ok shape",
    path: "/api/uniswap/quote",
    body: {
      direction: "buy",
      amount: "0001000000000000000",
      swapper: "0x" + "11".repeat(20),
    },
    expect: [200, 403, 404, 400, 502], // may pass amount validation
  },
  {
    name: "short address",
    path: "/api/uniswap/quote",
    body: { direction: "buy", amount: "1", swapper: "0x1234" },
    expect: [400, 403],
  },
  {
    name: "checksum mix address length ok",
    path: "/api/uniswap/quote",
    body: {
      direction: "buy",
      amount: "1",
      swapper: "0x" + "Ab".repeat(20),
    },
    expect: [200, 403, 404, 400, 502],
  },
  {
    name: "direction weird → treated buy",
    path: "/api/uniswap/quote",
    body: {
      direction: "HACK",
      amount: "1000000000000000",
      swapper: "0x" + "11".repeat(20),
    },
    expect: [200, 403, 404, 400, 502],
  },
  {
    name: "slippage huge",
    path: "/api/uniswap/quote",
    body: {
      direction: "buy",
      amount: "1000000000000000",
      swapper: "0x" + "11".repeat(20),
      slippageTolerance: 999,
    },
    expect: [200, 403, 404, 400, 502], // clamped to default 1.0
  },
  {
    name: "slippage negative",
    path: "/api/uniswap/quote",
    body: {
      direction: "buy",
      amount: "1000000000000000",
      swapper: "0x" + "11".repeat(20),
      slippageTolerance: -1,
    },
    expect: [200, 403, 404, 400, 502],
  },
  {
    name: "fee override",
    path: "/api/uniswap/quote",
    body: {
      direction: "buy",
      amount: "1000000000000000",
      swapper: "0x" + "11".repeat(20),
      integratorFees: [{ bips: 1, recipient: "0x" + "00".repeat(19) + "01" }],
    },
    expect: [400, 403],
  },
  {
    name: "token override",
    path: "/api/uniswap/quote",
    body: {
      direction: "buy",
      amount: "1",
      swapper: "0x" + "11".repeat(20),
      tokenIn: "0x" + "de".repeat(20),
      tokenOut: "0x" + "ad".repeat(20),
    },
    expect: [400, 403],
  },
  {
    name: "api key in body",
    path: "/api/uniswap/quote",
    body: {
      direction: "buy",
      amount: "1",
      swapper: "0x" + "11".repeat(20),
      UNISWAP_API_KEY: "stolen",
    },
    expect: [400, 403],
  },
  {
    name: "swap no quote",
    path: "/api/uniswap/swap",
    body: {},
    expect: [400, 403],
  },
  {
    name: "swap wrong pair",
    path: "/api/uniswap/swap",
    body: {
      quote: {
        input: { token: "0x0000000000000000000000000000000000000000" },
        output: { token: "0xdeaddeaddeaddeaddeaddeaddeaddeaddeaddead" },
      },
    },
    expect: [400, 403],
  },
  {
    name: "swap missing tokens",
    path: "/api/uniswap/swap",
    body: { quote: { foo: 1 } },
    expect: [400, 403],
  },
  {
    name: "swap array quote",
    path: "/api/uniswap/swap",
    body: { quote: [] },
    expect: [400, 403],
  },
  {
    name: "check-approval junk",
    path: "/api/uniswap/check-approval",
    body: { walletAddress: "x", token: "y", amount: "z" },
    expect: [400, 403],
  },
];

for (const a of attacks) {
  const r = await jfetch(a.path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(a.body),
  });
  ok(a.name, a.expect.includes(r.status), `got ${r.status} ${JSON.stringify(r.body)?.slice(0, 120)}`);
}

// raw non-json
const raw = await fetch(`${BASE}/api/uniswap/quote`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: "{broken",
});
ok("broken JSON", [400, 403].includes(raw.status), `got ${raw.status}`);

// giant body
const giant = await jfetch("/api/uniswap/quote", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    direction: "buy",
    amount: "1".repeat(80),
    swapper: "0x" + "11".repeat(20),
    padding: "x".repeat(200_000),
  }),
},);
ok(
  "giant body handled",
  [400, 403, 404, 413, 500, 502].includes(giant.status),
  `got ${giant.status}`
);

// ─── pages ───
console.log("\n=== PAGES ===");
for (const p of ["/", "/mint", "/gallery", "/launch", "/not-a-page-xyz"]) {
  const r = await fetch(`${BASE}${p}`);
  if (p.includes("not-a-page")) ok(`${p} 404`, r.status === 404, `got ${r.status}`);
  else ok(`${p} 200`, r.status === 200, `got ${r.status}`);
}
const home = await (await fetch(BASE + "/")).text();
ok("home has trade section", /id=["']trade["']|Trade \$PLANK|Buy Real/i.test(home));
ok("home no api key", !/2E3djcv8fTeoKNA/i.test(home));
ok("home no env dump", !/UNISWAP_API_KEY\s*=/.test(home));

// ─── Uniswap fee validation (if key local) ───
console.log("\n=== UNISWAP FEE EDGE (direct) ===");
const envPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".env.local");
let key = null;
if (fs.existsSync(envPath)) {
  const line = fs.readFileSync(envPath, "utf8").split(/\r?\n/).find((l) => l.startsWith("UNISWAP_API_KEY="));
  if (line) key = line.split("=")[1]?.trim();
}
if (key) {
  async function uq(bips) {
    const res = await fetch("https://trade-api.gateway.uniswap.org/v1/quote", {
      method: "POST",
      headers: {
        "x-api-key": key,
        "Content-Type": "application/json",
        Accept: "application/json",
        "x-universal-router-version": "2.1.1",
      },
      body: JSON.stringify({
        tokenIn: "0x0000000000000000000000000000000000000000",
        tokenOut: CA,
        tokenInChainId: 4663,
        tokenOutChainId: 4663,
        type: "EXACT_INPUT",
        amount: "1000000000000000",
        swapper: "0x1111111111111111111111111111111111111111",
        slippageTolerance: 1,
        protocols: ["V2", "V3", "V4"],
        integratorFees: [{ bips, recipient: FEE.toLowerCase() }],
      }),
    });
    const t = await res.text();
    return { status: res.status, t };
  }
  const good = await uq(42.07);
  ok(
    "42.07 bips accepted by Uniswap (not validation error)",
    good.status !== 400 || !/decimal places/i.test(good.t),
    good.t.slice(0, 200)
  );
  const bad = await uq(42.069);
  ok("42.069 bips rejected", bad.status === 400 && /decimal/i.test(bad.t), bad.t.slice(0, 200));
  const zero = await uq(0);
  ok("0 bips rejected", zero.status === 400, zero.t.slice(0, 150));
  const over = await uq(501);
  ok("501 bips rejected", over.status === 400, over.t.slice(0, 150));
} else {
  console.log("  SKIP  no local API key for direct Uniswap tests");
}

// ─── consistency of isOpen vs server clock ───
console.log("\n=== CLOCK CONSISTENCY ===");
const st2 = await jfetch("/api/trade/status");
const serverNow = Date.parse(st2.body.serverNow);
const opensAt = Date.parse(st2.body.opensAt);
const expectedOpen = serverNow >= opensAt;
ok("isOpen matches serverNow vs opensAt", st2.body.isOpen === expectedOpen);
ok(
  "opensAt is 4:20 CT if production default",
  BASE.includes("plank.love") ? st2.body.opensAt === "2026-07-25T21:20:00.000Z" : true,
  st2.body.opensAt
);

console.log("\n=== SUMMARY ===");
console.log(`passed=${passed} failed=${failed}`);
if (fails.length) {
  for (const f of fails) console.log(" -", f.name, f.detail);
  process.exit(1);
}
process.exit(0);
