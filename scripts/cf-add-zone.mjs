/**
 * Create Cloudflare zone for plank.love (if missing) and print nameservers.
 * Usage: node scripts/cf-add-zone.mjs
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const ACCOUNT_ID = "06475b600e80399c135115cc2d31eeb7";
const DOMAIN = "plank.love";

function oauthToken() {
  const p = path.join(
    process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"),
    "xdg.config",
    ".wrangler",
    "config",
    "default.toml"
  );
  const t = fs.readFileSync(p, "utf8");
  const m = t.match(/oauth_token\s*=\s*"([^"]+)"/);
  if (!m) throw new Error("No wrangler oauth token — run: npx wrangler login");
  return m[1];
}

async function cf(pathname, { method = "GET", body } = {}) {
  const res = await fetch(`https://api.cloudflare.com/client/v4${pathname}`, {
    method,
    headers: {
      Authorization: `Bearer ${oauthToken()}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await res.json();
  if (!j.success) {
    const err = j.errors?.map((e) => e.message).join("; ") || res.statusText;
    throw new Error(err);
  }
  return j.result;
}

const zones = await cf(`/zones?name=${DOMAIN}`);
let zone = Array.isArray(zones) ? zones[0] : null;

if (!zone) {
  console.log(`Creating zone ${DOMAIN} on account ${ACCOUNT_ID}...`);
  zone = await cf("/zones", {
    method: "POST",
    body: {
      name: DOMAIN,
      account: { id: ACCOUNT_ID },
      type: "full",
      jump_start: false,
    },
  });
  console.log("Zone created:", zone.id, zone.status);
} else {
  console.log("Zone exists:", zone.id, zone.status);
}

console.log("\nNameservers (set these at Porkbun):");
for (const ns of zone.name_servers || []) {
  console.log("  ", ns);
}

console.log("\nStatus:", zone.status);
if (zone.status !== "active") {
  console.log(
    "\nNext: In Porkbun → Domain → Nameservers, replace Porkbun NS with the two Cloudflare nameservers above."
  );
  console.log("Then wait for active status and run: npm run deploy");
}
