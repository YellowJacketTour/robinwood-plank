import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// Same local wrangler OAuth auth as cf-zones.mjs
const p = path.join(
  process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"),
  "xdg.config",
  ".wrangler",
  "config",
  "default.toml"
);
const t = fs.readFileSync(p, "utf8");
const m = t.match(/oauth_token\s*=\s*"([^"]+)"/);
if (!m) {
  console.error("no oauth token");
  process.exit(1);
}
const token = m[1];
const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

const zones = await (
  await fetch("https://api.cloudflare.com/client/v4/zones?name=plank.love", { headers })
).json();
const zone = zones.result?.[0];
if (!zone) {
  console.error("plank.love zone not found");
  process.exit(1);
}
console.log("zone:", zone.name, zone.id);

const res = await fetch(
  `https://api.cloudflare.com/client/v4/zones/${zone.id}/purge_cache`,
  { method: "POST", headers, body: JSON.stringify({ purge_everything: true }) }
);
const j = await res.json();
console.log("purge success:", j.success, JSON.stringify(j.errors || []));
