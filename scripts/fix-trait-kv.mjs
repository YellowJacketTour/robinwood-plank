import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
function parseEnv(p) {
  const m = {};
  if (!fs.existsSync(p)) return m;
  for (const line of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
    if (!line || line.startsWith("#")) continue;
    const i = line.indexOf("=");
    if (i < 1) continue;
    let v = line.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    m[line.slice(0, i).trim()] = v;
  }
  return m;
}
const env = parseEnv(path.join(root, ".env.local"));
process.env.KV_REST_API_URL = env.KV_REST_API_URL;
process.env.KV_REST_API_TOKEN = env.KV_REST_API_TOKEN;
const { kv } = await import("@vercel/kv");
const key = "plank:market:trait-index-v1:robinwood";
const raw = await kv.get(key);
const index = raw && typeof raw === "object" && raw.value?.traits ? raw.value : raw;
if (!index?.traits || !index.scanned) {
  console.error("unexpected shape", raw && Object.keys(raw));
  process.exit(1);
}
await kv.set(key, index, { ex: 7 * 24 * 60 * 60 });
const check = await kv.get(key);
console.log(
  "ok scanned",
  check.scanned,
  "failed",
  check.failed?.length,
  "types",
  Object.keys(check.traits || {})
);
