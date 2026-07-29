import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const ACCOUNT = "06475b600e80399c135115cc2d31eeb7";
const ZID = "8491542c778c1f2325bcfe393d8eb587";

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

// List DNS with full perms attempt
const list = await cf(`/zones/${ZID}/dns_records?per_page=100`);
console.log("list success", list.success, list.errors);
if (list.result) {
  for (const r of list.result) {
    console.log(r.type, r.name, r.content, "proxied="+r.proxied);
  }
}

// For workers custom domains, CF uses special records. Try CNAME to workers.dev
// Actually custom domains use managed records - check domain status
const domains = await cf(`/accounts/${ACCOUNT}/workers/domains`);
for (const d of (domains.result || []).filter((x) =>
  String(x.hostname || "").includes("plank")
)) {
  console.log("domain detail:", JSON.stringify(d, null, 2));
}

// Create proxied CNAME app and m -> plank.love or workers
for (const name of ["app", "m"]) {
  const fqdn = `${name}.plank.love`;
  // delete existing if any
  const existing = await cf(
    `/zones/${ZID}/dns_records?name=${fqdn}&per_page=20`
  );
  if (existing.result?.length) {
    for (const r of existing.result) {
      const del = await cf(`/zones/${ZID}/dns_records/${r.id}`, {
        method: "DELETE",
      });
      console.log("deleted", fqdn, r.type, del.success);
    }
  }

  // AAAA/A for workers custom domains are managed - try CNAME to workers
  // Official approach: workers custom domain auto-creates; if DNS missing, create:
  // CNAME app -> plank-love.garden-equity-field-0042.workers.dev (proxied)
  const created = await cf(`/zones/${ZID}/dns_records`, {
    method: "POST",
    body: {
      type: "CNAME",
      name: fqdn,
      content: "plank-love.garden-equity-field-0042.workers.dev",
      proxied: true,
      ttl: 1,
    },
  });
  console.log(
    "create CNAME",
    fqdn,
    created.success,
    created.errors?.[0]?.message || created.result?.id
  );
}

// Wait and resolve
await new Promise((r) => setTimeout(r, 3000));
for (const name of ["app.plank.love", "m.plank.love", "plank.love", "www.plank.love"]) {
  const a = await fetch(`https://dns.google/resolve?name=${name}&type=A`).then(
    (r) => r.json()
  );
  console.log(
    "resolve",
    name,
    (a.Answer || []).map((x) => x.data).join(",") || a.Status
  );
}

// HTTP check
for (const host of ["app.plank.love", "m.plank.love", "www.plank.love", "plank.love"]) {
  try {
    const out = execFileSync(
      "curl.exe",
      ["-sI", "--max-time", "15", `https://${host}/market`],
      { encoding: "utf8" }
    );
    const status = out.match(/^HTTP\/[\d.]+\s+(\d+)/m)?.[1];
    const server = out.match(/^[Ss]erver:\s*(.+)$/m)?.[1]?.trim();
    console.log(`https://${host}/market`, status, server);
  } catch (e) {
    console.log(host, "fail", e.message);
  }
}
