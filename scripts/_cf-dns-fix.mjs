import fs from "node:fs";
import path from "node:path";
import dns from "node:dns/promises";

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
    return { success: false, status: res.status, preview: text.slice(0, 300) };
  }
}

async function doh(name, type, endpoint) {
  const url = endpoint.includes("google")
    ? `${endpoint}?name=${name}&type=${type}`
    : `${endpoint}?name=${name}&type=${type}`;
  const r = await fetch(url, { headers: { Accept: "application/dns-json" } });
  return r.json();
}

const zone = await cf(`/zones/${ZID}`);
console.log(
  "zone:",
  zone.result?.status,
  "paused:",
  zone.result?.paused,
  "ns:",
  zone.result?.name_servers,
  "orig:",
  zone.result?.original_name_servers
);

const dnsList = await cf(`/zones/${ZID}/dns_records?per_page=100`);
console.log("dns list success:", dnsList.success, dnsList.errors);
for (const r of dnsList.result || []) {
  console.log(
    `${r.type}\t${r.name}\t${r.content}\tproxied=${r.proxied}\tid=${r.id}`
  );
}

// Ensure worker custom domains
const domains = await cf(`/accounts/${ACCOUNT}/workers/domains`);
console.log(
  "worker domains:",
  (domains.result || [])
    .filter((d) => String(d.hostname || "").includes("plank"))
    .map((d) => `${d.hostname} enabled=${d.enabled} service=${d.service}`)
);

// Re-attach custom domains if needed
for (const hostname of ["plank.love", "www.plank.love"]) {
  const existing = (domains.result || []).find((d) => d.hostname === hostname);
  if (existing?.enabled && existing.service === "plank-love") {
    console.log("ok already attached:", hostname);
    continue;
  }
  const put = await cf(`/accounts/${ACCOUNT}/workers/domains`, {
    method: "PUT",
    body: {
      hostname,
      service: "plank-love",
      environment: "production",
      zone_id: ZID,
    },
  });
  console.log(
    "attach",
    hostname,
    put.success,
    put.errors?.[0]?.message || put.result?.id
  );
}

// Public DNS checks
for (const endpoint of [
  "https://cloudflare-dns.com/dns-query",
  "https://dns.google/resolve",
]) {
  for (const name of ["plank.love", "www.plank.love"]) {
    for (const type of ["A", "AAAA", "NS", "CNAME"]) {
      const j = await doh(name, type, endpoint);
      const ans = (j.Answer || []).map((a) => a.data).join(" | ");
      if (ans)
        console.log(
          `${endpoint.includes("google") ? "G" : "CF"} ${name} ${type}: ${ans}`
        );
    }
  }
}

// Node resolve
try {
  const a = await dns.resolve4("plank.love");
  console.log("node resolve4:", a);
} catch (e) {
  console.log("node resolve4 err", e.message);
}
try {
  const ns = await dns.resolveNs("plank.love");
  console.log("node resolveNs:", ns);
} catch (e) {
  console.log("node resolveNs err", e.message);
}

// Probe each resolved IP with SNI Host plank.love
const ips = new Set();
try {
  for (const ip of await dns.resolve4("plank.love")) ips.add(ip);
} catch {}
// also known vercel
try {
  for (const ip of await dns.resolve4("robinwood-plank.vercel.app"))
    ips.add(`vercel:${ip}`);
} catch {}

console.log("\nProbing IPs with Host plank.love:");
for (const entry of ips) {
  const isVercel = String(entry).startsWith("vercel:");
  const ip = String(entry).replace(/^vercel:/, "");
  try {
    // Use curl via child process for --resolve
    const { execFileSync } = await import("node:child_process");
    const out = execFileSync(
      "curl.exe",
      [
        "-sI",
        "--max-time",
        "10",
        "--resolve",
        `plank.love:443:${ip}`,
        "https://plank.love/",
      ],
      { encoding: "utf8" }
    );
    const server = out.match(/^[Ss]erver:\s*(.+)$/m)?.[1];
    const status = out.match(/^HTTP\/[\d.]+\s+(\d+)/m)?.[1];
    const vercel = out.match(/^[Xx]-[Vv]ercel-[Ee]rror:\s*(.+)$/m)?.[1];
    console.log(
      isVercel ? "VERCEL-IP" : "DNS-IP",
      ip,
      "status",
      status,
      "server",
      server?.trim(),
      "vercel-err",
      vercel?.trim()
    );
  } catch (e) {
    console.log("probe fail", ip, e.message);
  }
}
