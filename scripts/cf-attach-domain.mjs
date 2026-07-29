/**
 * Clear conflicting DNS records for apex/www, then attach Worker custom domains.
 */
import fs from "node:fs";
import path from "node:path";

const ZID = "8491542c778c1f2325bcfe393d8eb587";
const ACCOUNT = "06475b600e80399c135115cc2d31eeb7";
const SERVICE = "plank-love";
const HOSTS = ["plank.love", "www.plank.love"];

function token() {
  const p = path.join(
    process.env.APPDATA,
    "xdg.config/.wrangler/config/default.toml"
  );
  const t = fs.readFileSync(p, "utf8");
  const m = t.match(/oauth_token\s*=\s*"([^"]+)"/);
  if (!m) throw new Error("no wrangler token");
  return m[1];
}

async function cf(pathname, { method = "GET", body } = {}) {
  const res = await fetch(`https://api.cloudflare.com/client/v4${pathname}`, {
    method,
    headers: {
      Authorization: `Bearer ${token()}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
}

// List all DNS records
const list = await cf(`/zones/${ZID}/dns_records?per_page=100`);
if (!list.success) {
  console.error("list dns failed", list.errors);
  process.exit(1);
}

const records = list.result || [];
console.log("DNS records (" + records.length + "):");
for (const r of records) {
  console.log(`  ${r.type} ${r.name} → ${r.content} (${r.id})`);
}

// Delete A/AAAA/CNAME that block custom domains for apex + www
const killTypes = new Set(["A", "AAAA", "CNAME"]);
const toDelete = records.filter(
  (r) =>
    killTypes.has(r.type) &&
    (r.name === "plank.love" ||
      r.name === "www.plank.love" ||
      r.name === "www")
);

for (const r of toDelete) {
  const del = await cf(`/zones/${ZID}/dns_records/${r.id}`, {
    method: "DELETE",
  });
  console.log(
    del.success
      ? `deleted ${r.type} ${r.name}`
      : `delete failed ${r.name}: ${del.errors?.[0]?.message}`
  );
}

// Attach worker custom domains
for (const hostname of HOSTS) {
  const put = await cf(`/accounts/${ACCOUNT}/workers/domains`, {
    method: "PUT",
    body: {
      hostname,
      service: SERVICE,
      environment: "production",
      zone_id: ZID,
    },
  });
  if (put.success) {
    console.log("attached:", hostname, "→", SERVICE);
  } else {
    console.log(
      "attach failed:",
      hostname,
      put.errors?.map((e) => e.message).join("; ")
    );
  }
}

// Show final DNS
const final = await cf(`/zones/${ZID}/dns_records?per_page=100`);
console.log("\nFinal DNS:");
for (const r of final.result || []) {
  console.log(`  ${r.type} ${r.name} → ${r.content}`);
}
