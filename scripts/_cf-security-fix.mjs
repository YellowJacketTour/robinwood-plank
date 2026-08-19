import fs from "node:fs";
import path from "node:path";

const ZID = "8491542c778c1f2325bcfe393d8eb587";
const ACCOUNT = "06475b600e80399c135115cc2d31eeb7";

function token() {
  const p = path.join(
    process.env.APPDATA,
    "xdg.config/.wrangler/config/default.toml"
  );
  const t = fs.readFileSync(p, "utf8");
  const m = t.match(/oauth_token\s*=\s*"([^"]+)"/);
  if (!m) throw new Error("no token");
  return m[1];
}

async function cf(pathname, { method = "GET", body } = {}) {
  const res = await fetch(`https://api.cloudflare.com/client/v4${pathname}`, {
    method,
    headers: {
      Authorization: `Bearer ${token()}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { success: false, status: res.status, preview: text.slice(0, 400) };
  }
}

const settings = [
  "security_level",
  "browser_check",
  "challenge_ttl",
  "privacy_pass",
  "email_obfuscation",
  "server_side_exclude",
  "hotlink_protection",
  "ip_geolocation",
  "always_use_https",
  "automatic_https_rewrites",
  "opportunistic_encryption",
  "ssl",
  "tls_1_3",
  "min_tls_version",
  "always_online",
  "development_mode",
  "rocket_loader",
  "mirage",
  "polish",
  "minify",
  "http2",
  "http3",
  "0rtt",
  "websockets",
  "ip_geolocation",
  "pseudo_ipv4",
  "bot_management",
  "bot_fight_mode",
];

console.log("=== Zone settings ===");
for (const s of settings) {
  const r = await cf(`/zones/${ZID}/settings/${s}`);
  if (r.success) {
    console.log(s + ":", JSON.stringify(r.result?.value ?? r.result));
  } else {
    // skip missing
    if (r.errors?.[0]?.code !== 1000 && r.errors?.[0]?.code !== 7003) {
      console.log(s + ": FAIL", r.errors?.[0]?.message || r.status);
    }
  }
}

// WAF / rulesets packages
console.log("\n=== Firewall packages ===");
const packs = await cf(`/zones/${ZID}/firewall/waf/packages`);
console.log(JSON.stringify(packs.result || packs.errors, null, 2).slice(0, 1500));

console.log("\n=== Rulesets ===");
const rulesets = await cf(`/zones/${ZID}/rulesets`);
console.log(
  JSON.stringify(
    (rulesets.result || []).map((r) => ({
      id: r.id,
      name: r.name,
      phase: r.phase,
      kind: r.kind,
    })),
    null,
    2
  )
);

// Bot fight via zone settings bot_management
const bot = await cf(`/zones/${ZID}/bot_management`);
console.log("\n=== bot_management ===", JSON.stringify(bot.result || bot.errors, null, 2));

// Security level force essentially_off
console.log("\n=== Setting security_level=essentially_off ===");
const sec = await cf(`/zones/${ZID}/settings/security_level`, {
  method: "PATCH",
  body: { value: "essentially_off" },
});
console.log(sec.success, sec.errors || sec.result?.value);

console.log("\n=== browser_check off ===");
const bc = await cf(`/zones/${ZID}/settings/browser_check`, {
  method: "PATCH",
  body: { value: "off" },
});
console.log(bc.success, bc.errors || bc.result?.value);

// Disable bot fight if possible
console.log("\n=== bot_fight_mode off ===");
const bfm = await cf(`/zones/${ZID}/settings/bot_fight_mode`, {
  method: "PATCH",
  body: { value: "off" },
});
console.log(bfm.success, bfm.errors || bfm.result?.value);

// Super bot fight
const sbfm = await cf(`/zones/${ZID}/bot_management`, {
  method: "PUT",
  body: {
    fight_mode: false,
    sbfm_definitely_automated: "allow",
    sbfm_likely_automated: "allow",
    sbfm_verified_bots: "allow",
    sbfm_static_resource_protection: false,
    optimize_wordpress: false,
    suppress_session_score: true,
  },
});
console.log("bot_management put:", sbfm.success, sbfm.errors || "ok");

// List page rules
const pr = await cf(`/zones/${ZID}/pagerules`);
console.log("\n=== page rules ===", JSON.stringify(pr.result || pr.errors, null, 2).slice(0, 1000));

// Worker routes
const wr = await cf(`/zones/${ZID}/workers/routes`);
console.log("\n=== worker routes ===", JSON.stringify(wr.result || wr.errors, null, 2));

const domains = await cf(`/accounts/${ACCOUNT}/workers/domains`);
console.log(
  "\n=== worker custom domains ===",
  JSON.stringify(
    (domains.result || []).filter((d) => String(d.hostname || "").includes("plank")),
    null,
    2
  )
);

// Probe with mobile UA for challenge page
const ua =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
for (const url of [
  "https://plank.love/market",
  "https://plank-love.garden-equity-field-0042.workers.dev/market",
]) {
  const res = await fetch(url, {
    headers: { "User-Agent": ua, Accept: "text/html" },
    redirect: "manual",
  });
  const body = await res.text();
  const challenge =
    /cf-browser-verification|challenge-platform|Just a moment|Attention Required|cf-challenge/i.test(
      body
    );
  console.log(
    "\nPROBE",
    url,
    res.status,
    "challenge?",
    challenge,
    "len",
    body.length,
    "title",
    body.match(/<title>([^<]+)/)?.[1]
  );
}
