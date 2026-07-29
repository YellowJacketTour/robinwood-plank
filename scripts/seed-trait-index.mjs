/**
 * Build trait → token-id index from Blockscout (+ IPFS gaps) and write to
 * Upstash so Cloudflare Workers don't time out on first /api/market/traits.
 *
 * Usage: node scripts/seed-trait-index.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const NFT = "0x327ceaaedbbCf55F40d6F1aBc71bd9bC8ADCb156";
const BASE = "https://robinhoodchain.blockscout.com";
const SUPPLY = 1542;
const CID = "bafybeictcaptbfswgepv2icnuw5wdhfjvvamwlcoza2p4qw3zbq2hqd6b4";
const KV_KEY = "plank:market:trait-index-v1:robinwood";

function parseEnv(filePath) {
  const map = {};
  if (!fs.existsSync(filePath)) return map;
  for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    if (!line || line.startsWith("#")) continue;
    const i = line.indexOf("=");
    if (i < 1) continue;
    let v = line.slice(i + 1).trim();
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    map[line.slice(0, i).trim()] = v.replace(/\\n/g, "").trim();
  }
  return map;
}

const env = {
  ...parseEnv(path.join(root, ".env.local")),
  ...parseEnv(path.join(root, ".env.production")),
  ...process.env,
};
const kvUrl = env.KV_REST_API_URL;
const kvTok = env.KV_REST_API_TOKEN;
if (!kvUrl || !kvTok) {
  console.error("Missing KV_REST_API_URL / KV_REST_API_TOKEN");
  process.exit(1);
}

function clean(s) {
  const v = String(s ?? "").trim();
  if (!v || v.length > 64) return null;
  return v;
}

function add(traits, tokenId, attributes) {
  for (const a of attributes || []) {
    const traitType = clean(a.trait_type);
    const value = clean(a.value);
    if (!traitType || !value) continue;
    const byValue = (traits[traitType] ??= {});
    const list = (byValue[value] ??= []);
    if (!list.includes(tokenId)) list.push(tokenId);
  }
}

function covered(traits) {
  const set = new Set();
  for (const by of Object.values(traits)) {
    for (const list of Object.values(by)) {
      for (const id of list) set.add(id);
    }
  }
  return set;
}

async function fetchAllInstances() {
  const items = [];
  let pathUrl = `/api/v2/tokens/${NFT}/instances`;
  for (let page = 0; page < 50; page++) {
    process.stdout.write(`\r Blockscout page ${page + 1} items ${items.length}`);
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

async function ipfsAttrs(tokenId) {
  const gateways = [
    `https://gateway.pinata.cloud/ipfs/${CID}/${tokenId}`,
    `https://ipfs.io/ipfs/${CID}/${tokenId}`,
  ];
  for (const url of gateways) {
    try {
      const res = await fetch(url, { headers: { Accept: "application/json" } });
      if (!res.ok) continue;
      const meta = await res.json();
      if (Array.isArray(meta.attributes) && meta.attributes.length) return meta.attributes;
    } catch {
      /* try next */
    }
  }
  return [];
}

const traits = {};
const items = await fetchAllInstances();
for (const it of items) {
  const id = String(it.id);
  add(traits, id, it.metadata?.attributes || []);
}

const have = covered(traits);
const missing = [];
for (let id = 1; id <= SUPPLY; id++) {
  if (!have.has(String(id))) missing.push(id);
}
console.log("have", have.size, "missing", missing.length);

const CONC = 16;
for (let i = 0; i < missing.length; i += CONC) {
  const slice = missing.slice(i, i + CONC);
  process.stdout.write(`\r IPFS ${i + slice.length}/${missing.length}`);
  await Promise.all(
    slice.map(async (id) => {
      const attrs = await ipfsAttrs(id);
      if (attrs.length) add(traits, String(id), attrs);
    })
  );
}
console.log("");

// sort lists
for (const by of Object.values(traits)) {
  for (const k of Object.keys(by)) {
    by[k].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1));
  }
}

const scanned = covered(traits).size;
const failed = [];
for (let id = 1; id <= SUPPLY; id++) {
  if (!covered(traits).has(String(id))) failed.push(id);
}

const index = {
  collectionSlug: "robinwood",
  totalSupply: SUPPLY,
  scanned,
  failed,
  traits,
  builtAt: Date.now(),
};

console.log("scanned", scanned, "failed", failed.length);
console.log(
  "trait types",
  Object.keys(traits).map((t) => `${t}:${Object.keys(traits[t]).length}`).join(", ")
);

// Write via @vercel/kv so the stored value matches runtime reads (not a nested {value,ex} body).
process.env.KV_REST_API_URL = kvUrl;
process.env.KV_REST_API_TOKEN = kvTok;
const { kv } = await import("@vercel/kv");
await kv.set(KV_KEY, index, { ex: 7 * 24 * 60 * 60 });
const check = await kv.get(KV_KEY);
console.log(
  "KV set ok scanned=",
  check?.scanned,
  "failed=",
  check?.failed?.length,
  "complete=",
  check?.failed?.length === 0 && check?.scanned >= SUPPLY
);
