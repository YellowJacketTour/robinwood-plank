import fs from "node:fs";
import path from "node:path";
import os from "node:os";

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
const res = await fetch("https://api.cloudflare.com/client/v4/zones?per_page=50", {
  headers: { Authorization: `Bearer ${token}` },
});
const j = await res.json();
console.log("success", j.success, "count", j.result?.length);
for (const z of j.result || []) {
  console.log(z.name, z.id, z.status);
}
const hit = (j.result || []).find((z) => z.name === "plank.love");
console.log("plank.love zone:", hit ? hit.id : "NOT FOUND");
