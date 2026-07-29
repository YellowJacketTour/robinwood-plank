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

async function cf(pathname) {
  const res = await fetch(`https://api.cloudflare.com/client/v4${pathname}`, {
    headers: { Authorization: `Bearer ${token()}` },
  });
  return res.json();
}

const z = await cf(`/zones/${ZID}`);
console.log("zone:", z.result?.status, z.result?.name);

const dns = await cf(`/zones/${ZID}/dns_records?per_page=100`);
console.log("dns success:", dns.success, dns.errors?.[0]?.message || "");
if (dns.result) {
  for (const r of dns.result) {
    console.log(
      `  ${r.type.padEnd(6)} ${r.name.padEnd(24)} ${r.content} proxied=${r.proxied}`
    );
  }
}

const domains = await cf(
  `/accounts/${ACCOUNT}/workers/domains?zone_id=${ZID}`
);
console.log("workers domains success:", domains.success);
for (const d of domains.result || []) {
  console.log(
    `  ${d.hostname} → ${d.service} (${d.id}) zone=${d.zone_name}`
  );
}

// list all worker domains on account
const all = await cf(`/accounts/${ACCOUNT}/workers/domains`);
console.log("all worker domains:");
for (const d of all.result || []) {
  console.log(`  ${d.hostname} → ${d.service}`);
}
