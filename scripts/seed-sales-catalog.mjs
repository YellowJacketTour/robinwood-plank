/**
 * Walk RobinWood NFT transfers on Blockscout, price marketplace fills
 * (native ETH + WETH), write to Upstash for Cloudflare Workers.
 *
 * Usage: node scripts/seed-sales-catalog.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const NFT = "0x327ceaaedbbCf55F40d6F1aBc71bd9bC8ADCb156".toLowerCase();
const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73".toLowerCase();
const BASE = "https://robinhoodchain.blockscout.com";
const KV_KEY = "plank:market:sales-catalog-v1";

function parseEnv(p) {
  const m = {};
  if (!fs.existsSync(p)) return m;
  for (const line of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
    if (!line || line.startsWith("#")) continue;
    const i = line.indexOf("=");
    if (i < 1) continue;
    let v = line.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))
      v = v.slice(1, -1);
    m[line.slice(0, i).trim()] = v;
  }
  return m;
}
const env = { ...parseEnv(path.join(root, ".env.local")), ...process.env };
process.env.KV_REST_API_URL = env.KV_REST_API_URL;
process.env.KV_REST_API_TOKEN = env.KV_REST_API_TOKEN;

function isMarket(method) {
  const m = (method || "").toLowerCase();
  return /fulfill|match|sweep|buyfrom|buy_|take|accept|purchase|order/.test(m);
}

async function fetchTransfers() {
  const items = [];
  let p = `/api/v2/tokens/${NFT}/transfers`;
  for (let page = 0; page < 40; page++) {
    process.stdout.write(`\r transfers page ${page + 1} n=${items.length}`);
    const res = await fetch(BASE + p, { headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    items.push(...(data.items || []));
    const next = data.next_page_params;
    if (!next || !Object.keys(next).length) break;
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(next)) qs.set(k, String(v));
    p = `/api/v2/tokens/${NFT}/transfers?${qs}`;
  }
  console.log("\ntransfers", items.length);
  return items;
}

async function priceTx(hash) {
  const [txRes, tokRes] = await Promise.all([
    fetch(`${BASE}/api/v2/transactions/${hash}`, { headers: { Accept: "application/json" } }),
    fetch(`${BASE}/api/v2/transactions/${hash}/token-transfers`, {
      headers: { Accept: "application/json" },
    }),
  ]);
  if (!txRes.ok || !tokRes.ok) return null;
  const tx = await txRes.json();
  const moves = (await tokRes.json()).items || [];
  const nfts = moves.filter(
    (m) => (m.token?.address_hash || "").toLowerCase() === NFT && m.total?.token_id != null
  );
  if (!nfts.length) return null;
  let total = BigInt(tx.value || "0");
  let weth = 0n;
  for (const m of moves) {
    const addr = (m.token?.address_hash || "").toLowerCase();
    if (addr !== WETH) continue;
    try {
      weth += BigInt(m.total?.value || "0");
    } catch {
      /* */
    }
  }
  if (total === 0n && weth > 0n) total = weth;
  if (total <= 0n) return null;
  const per = total / BigInt(nfts.length);
  const out = {};
  for (const m of nfts) {
    out[`${hash}:${m.total.token_id}`] = {
      priceWei: per.toString(),
      tokenId: String(m.total.token_id),
      ts: m.timestamp || tx.timestamp || null,
    };
  }
  return out;
}

const transfers = await fetchTransfers();
const saleHashes = [
  ...new Set(
    transfers.filter((t) => isMarket(t.method)).map((t) => t.transaction_hash).filter(Boolean)
  ),
];
console.log("sale txs", saleHashes.length);

const catalog = {};
const CONC = 8;
for (let i = 0; i < saleHashes.length; i += CONC) {
  const slice = saleHashes.slice(i, i + CONC);
  process.stdout.write(`\r pricing ${Math.min(i + CONC, saleHashes.length)}/${saleHashes.length}`);
  const parts = await Promise.all(slice.map((h) => priceTx(h).catch(() => null)));
  for (const p of parts) {
    if (!p) continue;
    for (const [k, v] of Object.entries(p)) catalog[k] = v.priceWei;
  }
}
console.log("\npriced keys", Object.keys(catalog).length);

let max = 0n;
let maxKey = "";
for (const [k, v] of Object.entries(catalog)) {
  const n = BigInt(v);
  if (n > max) {
    max = n;
    maxKey = k;
  }
}
console.log(
  "highest",
  Number(max) / 1e18,
  "eth",
  maxKey,
  "sales",
  Object.keys(catalog).length
);

const { kv } = await import("@vercel/kv");
await kv.set(KV_KEY, catalog, { ex: 7 * 24 * 60 * 60 });
console.log("KV ok", KV_KEY);
