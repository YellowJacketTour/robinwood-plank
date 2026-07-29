/**
 * Build rarity snapshot from Blockscout and write to Upstash so Cloudflare
 * Workers don't time out on the first cold /api/market/rarity request.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

// Reuse compiled rarity math by spawning the same algorithm via dynamic import of TS is hard;
// instead compute with a minimal port: call the live build path after seeding raw inputs...
// Simpler: hit Blockscout, run compute via node loading the ts through tsx if available.

function parseEnv(filePath) {
  const map = {};
  for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    if (!line || line.startsWith("#")) continue;
    const i = line.indexOf("=");
    if (i < 1) continue;
    let v = line.slice(i + 1).trim();
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    map[line.slice(0, i)] = v.replace(/\\n/g, "").trim();
  }
  return map;
}

const env = parseEnv(path.join(root, ".env.local"));
const kvUrl = env.KV_REST_API_URL;
const kvTok = env.KV_REST_API_TOKEN;
const NFT = "0x327ceaaedbbCf55F40d6F1aBc71bd9bC8ADCb156";
const BASE = "https://robinhoodchain.blockscout.com";

async function fetchAllInstances() {
  const items = [];
  let pathUrl = `/api/v2/tokens/${NFT}/instances`;
  for (let page = 0; page < 40; page++) {
    process.stdout.write(`\r page ${page + 1} items ${items.length}`);
    const res = await fetch(BASE + pathUrl, { headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    items.push(...(data.items || []));
    const next = data.next_page_params;
    if (!next || !Object.keys(next).length) break;
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(next)) qs.set(k, String(v));
    pathUrl = `/api/v2/tokens/${NFT}/instances?${qs}`;
  }
  console.log("\ninstances", items.length);
  return items;
}

// Inline minimal rarity so we don't need tsx — import compiled rarity via jiti if present
async function loadCompute() {
  try {
    const { register } = await import("node:module");
    // use tsx
    const { pathToFileURL } = await import("node:url");
    await import("tsx/esm");
    const mod = await import(pathToFileURL(path.join(root, "lib/rarity.ts")).href);
    return mod.computeRaritySnapshot;
  } catch {
    // fallback: spawn npx tsx
    return null;
  }
}

const items = await fetchAllInstances();
const inputs = items.map((it) => {
  const tokenId = Number(it.id);
  const attrs = (it.metadata?.attributes || []).map((a) => ({
    trait_type: String(a.trait_type || ""),
    value: a.value,
  }));
  return { tokenId, attributes: attrs, loaded: attrs.length > 0 };
});
const seen = new Set(inputs.map((i) => i.tokenId));
for (let id = 1; id <= 1542; id++) {
  if (!seen.has(id)) inputs.push({ tokenId: id, attributes: [], loaded: false });
}

// Prefer tsx
import { spawnSync } from "node:child_process";
const tmpIn = path.join(root, ".tmp-rarity-inputs.json");
const tmpOut = path.join(root, ".tmp-rarity-out.json");
fs.writeFileSync(tmpIn, JSON.stringify(inputs));
const runner = `
import { computeRaritySnapshot } from './lib/rarity.ts';
import fs from 'fs';
const inputs = JSON.parse(fs.readFileSync('.tmp-rarity-inputs.json','utf8'));
const snap = computeRaritySnapshot(inputs);
const byTokenId = {};
for (const [id, r] of snap.byTokenId) {
  byTokenId[String(id)] = { name: r.name, tier: r.tier, rank: r.rank, percentile: r.percentile, normalizedScore: r.normalizedScore, score: r.score };
}
fs.writeFileSync('.tmp-rarity-out.json', JSON.stringify({
  sampleSize: snap.sampleSize,
  scoredCount: snap.scoredCount,
  tierCounts: snap.tierCounts,
  byTokenId,
}));
console.log('scored', snap.scoredCount, 'sample', snap.sampleSize);
`;
fs.writeFileSync(path.join(root, ".tmp-rarity-run.mts"), runner);
const r = spawnSync("npx", ["tsx", ".tmp-rarity-run.mts"], { cwd: root, encoding: "utf8", shell: true });
console.log(r.stdout);
if (r.status !== 0) {
  console.error(r.stderr);
  process.exit(1);
}
const blob = JSON.parse(fs.readFileSync(tmpOut, "utf8"));
const setRes = await fetch(kvUrl, {
  method: "POST",
  headers: { Authorization: `Bearer ${kvTok}`, "Content-Type": "application/json" },
  body: JSON.stringify(["SET", "plank:market:rarity-snapshot-v1", JSON.stringify(blob), "EX", String(6 * 3600)]),
});
console.log("kv", setRes.status, await setRes.text());
// cleanup
for (const f of [".tmp-rarity-inputs.json", ".tmp-rarity-out.json", ".tmp-rarity-run.mts"]) {
  try { fs.unlinkSync(path.join(root, f)); } catch {}
}
