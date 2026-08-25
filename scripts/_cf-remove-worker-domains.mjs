import fs from "node:fs";
import path from "node:path";

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

const tok = token();
const r = await fetch(
  `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/workers/domains`,
  { headers: { Authorization: `Bearer ${tok}` } }
);
const j = await r.json();
const domains = (j.result || []).filter((d) =>
  /plank\.love$/i.test(d.hostname || "")
);
console.log(
  "found",
  domains.map((d) => `${d.hostname} ${d.id}`)
);

// Do NOT delete — user mobile might need CF. Print only unless --delete
const doDelete = process.argv.includes("--delete");
if (!doDelete) {
  console.log("Pass --delete to remove worker custom domains");
  process.exit(0);
}

for (const d of domains) {
  const del = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/workers/domains/${d.id}`,
    { method: "DELETE", headers: { Authorization: `Bearer ${tok}` } }
  );
  const text = await del.text();
  let dj = {};
  try {
    dj = text ? JSON.parse(text) : { success: del.ok };
  } catch {
    dj = { success: del.ok, raw: text.slice(0, 200) };
  }
  console.log("delete", d.hostname, del.status, dj.success, dj.errors || "");
}
