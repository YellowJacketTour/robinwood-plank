import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const ACCOUNT = "06475b600e80399c135115cc2d31eeb7";
const ZID = "8491542c778c1f2325bcfe393d8eb587";
const SCRIPT = "plank-love";

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

function dig(name, type = "A") {
  try {
    return execFileSync(
      "nslookup",
      [`-type=${type}`, name, "8.8.8.8"],
      { encoding: "utf8" }
    );
  } catch (e) {
    return String(e.stdout || e.message);
  }
}

function probe(url, resolveIp) {
  const args = ["-sI", "--max-time", "12"];
  if (resolveIp) {
    const host = new URL(url).hostname;
    args.push("--resolve", `${host}:443:${resolveIp}`, url);
  } else {
    args.push(url);
  }
  try {
    return execFileSync("curl.exe", args, { encoding: "utf8" });
  } catch (e) {
    return String(e.stdout || e.message);
  }
}

// Attach clean hostnames that never lived on Vercel
for (const hostname of ["app.plank.love", "m.plank.love", "www.plank.love", "plank.love"]) {
  const put = await cf(`/accounts/${ACCOUNT}/workers/domains`, {
    method: "PUT",
    body: {
      hostname,
      service: SCRIPT,
      environment: "production",
      zone_id: ZID,
    },
  });
  console.log(
    "attach",
    hostname,
    put.success ? "OK" : "FAIL",
    put.errors?.[0]?.message || put.result?.id || ""
  );
}

const domains = await cf(`/accounts/${ACCOUNT}/workers/domains`);
console.log(
  "\nworker domains:",
  (domains.result || [])
    .filter((d) => String(d.hostname || "").includes("plank"))
    .map((d) => `${d.hostname} enabled=${d.enabled}`)
    .join("\n")
);

console.log("\n=== DNS Google ===");
for (const name of ["plank.love", "www.plank.love", "app.plank.love", "m.plank.love"]) {
  const a = await fetch(
    `https://dns.google/resolve?name=${name}&type=A`
  ).then((r) => r.json());
  const aaaa = await fetch(
    `https://dns.google/resolve?name=${name}&type=AAAA`
  ).then((r) => r.json());
  console.log(
    name,
    "A:",
    (a.Answer || []).map((x) => x.data).join(",") || "(none)",
    "AAAA:",
    (aaaa.Answer || []).map((x) => x.data).join(",") || "(none)"
  );
}

console.log("\n=== Porkbun leftover check ===");
for (const ns of ["curitiba.ns.porkbun.com", "fortaleza.ns.porkbun.com"]) {
  for (const name of ["plank.love", "app.plank.love"]) {
    try {
      const out = execFileSync("nslookup", ["-type=A", name, ns], {
        encoding: "utf8",
      });
      const hasVercel =
        /76\.76\.|64\.29\.|216\.198\.|cname\.vercel/i.test(out);
      console.log(ns, name, hasVercel ? "HAS_VERCEL_IP" : "clean-or-empty");
      if (hasVercel) console.log(out);
    } catch (e) {
      console.log(ns, name, "err/nx", String(e.stdout || "").slice(0, 120));
    }
  }
}

console.log("\n=== HTTP probes ===");
for (const url of [
  "https://plank.love/market",
  "https://www.plank.love/market",
  "https://app.plank.love/market",
  "https://m.plank.love/market",
  "https://plank-love.garden-equity-field-0042.workers.dev/market",
]) {
  const out = probe(url);
  const status = out.match(/^HTTP\/[\d.]+\s+(\d+)/m)?.[1];
  const server = out.match(/^[Ss]erver:\s*(.+)$/m)?.[1]?.trim();
  const vercel = out.match(/^[Xx]-[Vv]ercel/m);
  console.log(url, "→", status, server, vercel ? "VERCEL_HEADERS" : "ok");
}

// Known bad IPs still accept Host?
console.log("\n=== Stale Vercel IPs still answer Host: plank.love? ===");
for (const ip of ["76.76.21.21", "76.76.21.93", "216.198.79.131", "64.29.17.131"]) {
  const out = probe("https://plank.love/", ip);
  const status = out.match(/^HTTP\/[\d.]+\s+(\d+)/m)?.[1];
  const err = out.match(/^[Xx]-[Vv]ercel-[Ee]rror:\s*(.+)$/m)?.[1]?.trim();
  console.log(ip, "→", status, err || "");
}
