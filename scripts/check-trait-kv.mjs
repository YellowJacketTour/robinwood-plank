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
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    m[line.slice(0, i).trim()] = v;
  }
  return m;
}
const env = parseEnv(path.join(root, ".env.local"));
process.env.KV_REST_API_URL = env.KV_REST_API_URL;
process.env.KV_REST_API_TOKEN = env.KV_REST_API_TOKEN;
const { kv } = await import("@vercel/kv");
const key = "plank:market:trait-index-v1:robinwood";
const v = await kv.get(key);
console.log("type", typeof v);
if (!v) {
  console.log("null");
  process.exit(0);
}
if (typeof v === "string") {
  console.log("string len", v.length, v.slice(0, 120));
  try {
    const p = JSON.parse(v);
    console.log("parsed scanned", p.scanned, "failed", p.failed?.length);
  } catch (e) {
    console.log("parse fail", e.message);
  }
} else {
  console.log("scanned", v.scanned, "failed", v.failed?.length, "slug", v.collectionSlug);
  console.log("traits", v.traits && Object.keys(v.traits));
  console.log("complete?", v.failed?.length === 0 && v.scanned >= v.totalSupply && v.builtAt > 0);
}
