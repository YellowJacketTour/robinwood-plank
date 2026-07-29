/**
 * Build full rarity from IPFS metadata (post-reveal traits) and write Upstash.
 * Run when Blockscout index is incomplete so redeem odds score every held id.
 *
 *   node scripts/seed-rarity-ipfs.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

function parseEnv(filePath) {
  const map = {};
  if (!fs.existsSync(filePath)) return map;
  for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    if (!line || line.startsWith("#")) continue;
    const i = line.indexOf("=");
    if (i < 1) continue;
    let v = line.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    map[line.slice(0, i).trim()] = v;
  }
  return map;
}

const env = {
  ...parseEnv(path.join(root, ".env.local")),
  ...parseEnv(path.join(root, ".dev.vars")),
  ...process.env,
};
const kvUrl = env.KV_REST_API_URL;
const kvTok = env.KV_REST_API_TOKEN;
if (!kvUrl || !kvTok) {
  console.error("Missing KV_REST_API_URL / KV_REST_API_TOKEN");
  process.exit(1);
}

const META_CID = "bafybeictcaptbfswgepv2icnuw5wdhfjvvamwlcoza2p4qw3zbq2hqd6b4";
const SUPPLY = 1542;
const GATEWAYS = [
  `https://gateway.pinata.cloud/ipfs/${META_CID}/`,
  `https://ipfs.io/ipfs/${META_CID}/`,
  `https://dweb.link/ipfs/${META_CID}/`,
];

async function fetchMeta(id) {
  let lastErr;
  for (const base of GATEWAYS) {
    try {
      const res = await fetch(base + id, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(12_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = await res.json();
      const attrs = (j.attributes || []).map((a) => ({
        trait_type: String(a.trait_type || ""),
        value: a.value,
      }));
      if (attrs.length === 0) throw new Error("no attrs");
      return attrs;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error("fail");
}

// Load computeRaritySnapshot via tsx
await import("tsx/esm");
const { computeRaritySnapshot } = await import(
  pathToFileURL(path.join(root, "lib/rarity.ts")).href
);

const inputs = [];
const CONCURRENCY = 16;
for (let start = 1; start <= SUPPLY; start += CONCURRENCY) {
  const batch = [];
  for (let id = start; id < start + CONCURRENCY && id <= SUPPLY; id++) batch.push(id);
  const results = await Promise.all(
    batch.map(async (tokenId) => {
      try {
        const attributes = await fetchMeta(tokenId);
        return { tokenId, attributes, loaded: true };
      } catch {
        return { tokenId, attributes: [], loaded: false };
      }
    })
  );
  inputs.push(...results);
  const ok = inputs.filter((i) => i.loaded).length;
  process.stdout.write(`\r fetched ${inputs.length}/${SUPPLY} loaded ${ok}`);
}
console.log("");

const snapshot = computeRaritySnapshot(inputs);
console.log("scored", snapshot.scoredCount, "tiers", snapshot.tierCounts);

const byTokenId = {};
for (const [id, r] of snapshot.byTokenId) {
  byTokenId[String(id)] = {
    name: r.name,
    tier: r.tier,
    rank: r.rank,
    percentile: r.percentile,
    normalizedScore: r.normalizedScore,
    score: r.score,
  };
}
const blob = {
  sampleSize: snapshot.sampleSize,
  scoredCount: snapshot.scoredCount,
  tierCounts: snapshot.tierCounts,
  byTokenId,
};

// Upstash REST pipeline form (same as seed-vault-cache.mjs) — NOT the
// /set/key?body={value,ex} shape, which double-wraps and breaks @vercel/kv get.
const put = await fetch(kvUrl, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${kvTok}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify([
    "SET",
    "plank:market:rarity-snapshot-v4",
    JSON.stringify(blob),
    "EX",
    String(6 * 60 * 60),
  ]),
});
if (!put.ok) {
  console.error("KV write failed", put.status, await put.text());
  process.exit(1);
}
console.log("KV wrote plank:market:rarity-snapshot-v4", put.status, await put.text());
