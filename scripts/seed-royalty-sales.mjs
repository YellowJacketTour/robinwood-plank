/**
 * Build royalty-paid marketplace sales catalog (any platform) → Upstash.
 * Highest sale only counts when EIP-2981 royalty receiver was paid (or
 * Seaport fulfill with estimated royalty on native fills).
 *
 * Usage: node scripts/seed-royalty-sales.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const NFT = "0x327ceaaedbbCf55F40d6F1aBc71bd9bC8ADCb156".toLowerCase();
const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73".toLowerCase();
const ROY = "0x269a93ec8486fbc3a82e352430e84fd8af8ebb0d".toLowerCase();
const ROYALTY_BPS = 810n;
const BASE = "https://robinhoodchain.blockscout.com";
const KV_KEY = "plank:market:sales-catalog-v2";
// Also keep v1 flat map for any leftover readers
const KV_KEY_V1 = "plank:market:sales-catalog-v1";

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

function platform(method) {
  const m = (method || "").toLowerCase();
  if (m.includes("fulfill") || m.includes("match")) return "seaport";
  if (m.includes("buyfrom")) return "listing-market";
  return m ? m.slice(0, 32) : "marketplace";
}

async function fetchTransfers() {
  const items = [];
  let p = `/api/v2/tokens/${NFT}/transfers`;
  for (let page = 0; page < 45; page++) {
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

async function priceTx(hash, method) {
  const [txRes, tokRes] = await Promise.all([
    fetch(`${BASE}/api/v2/transactions/${hash}`, { headers: { Accept: "application/json" } }),
    fetch(`${BASE}/api/v2/transactions/${hash}/token-transfers`, {
      headers: { Accept: "application/json" },
    }),
  ]);
  if (!txRes.ok || !tokRes.ok) return [];
  const tx = await txRes.json();
  const moves = (await tokRes.json()).items || [];
  const nfts = moves.filter(
    (m) => (m.token?.address_hash || "").toLowerCase() === NFT && m.total?.token_id != null
  );
  if (!nfts.length) return [];

  let native = 0n;
  try {
    native = BigInt(tx.value || "0");
  } catch {
    native = 0n;
  }
  let wethTotal = 0n;
  let royaltyWei = 0n;
  for (const m of moves) {
    const addr = (m.token?.address_hash || "").toLowerCase();
    const typ = (m.token?.type || "").toUpperCase();
    if (typ === "ERC-721" || typ === "ERC-1155") continue;
    try {
      const amt = BigInt(m.total?.value || "0");
      if (amt <= 0n) continue;
      if (addr === WETH) {
        wethTotal += amt;
        if ((m.to?.hash || "").toLowerCase() === ROY) royaltyWei += amt;
      }
    } catch {
      /* */
    }
  }
  let total = wethTotal > 0n ? wethTotal : native;
  if (total <= 0n) return [];

  const expectedRoy = (total * ROYALTY_BPS) / 10000n;
  const m = (method || tx.method || "").toLowerCase();
  const seaportLike = /fulfill|match|buyfrom/.test(m);
  const hasRoy = royaltyWei > 0n;

  if (!hasRoy && !seaportLike) return [];
  if (wethTotal > 0n && !hasRoy && !seaportLike) return [];
  if (!hasRoy && seaportLike) royaltyWei = expectedRoy;
  if (royaltyWei <= 0n && !seaportLike) return [];

  const per = total / BigInt(nfts.length);
  const royPer = royaltyWei / BigInt(nfts.length);
  if (per <= 0n) return [];
  return nfts.map((n) => ({
    txHash: hash,
    tokenId: String(n.total.token_id),
    priceWei: per.toString(),
    royaltyWei: royPer.toString(),
    platform: platform(m),
    timestamp: n.timestamp || tx.timestamp || null,
    blockNumber: n.block_number || tx.block_number || 0,
  }));
}

const transfers = await fetchTransfers();
const methodByHash = new Map();
const hashSet = new Set();
for (const t of transfers) {
  if (!isMarket(t.method) || !t.transaction_hash) continue;
  if (!methodByHash.has(t.transaction_hash)) {
    methodByHash.set(t.transaction_hash, t.method || "");
  }
  hashSet.add(t.transaction_hash);
}

// Reverse index: every WETH payment TO the royalty receiver is a royalty-
// paid sale candidate (catches OpenSea fills our method filter might miss).
console.log("\nscanning royalty receiver WETH receipts…");
{
  let p = `/api/v2/addresses/${ROY}/token-transfers`;
  for (let page = 0; page < 25; page++) {
    const res = await fetch(BASE + p, { headers: { Accept: "application/json" } });
    if (!res.ok) break;
    const data = await res.json();
    for (const it of data.items || []) {
      const addr = (it.token?.address_hash || "").toLowerCase();
      if (addr !== WETH) continue;
      const h = it.transaction_hash;
      if (!h) continue;
      hashSet.add(h);
      if (!methodByHash.has(h)) methodByHash.set(h, "royalty-receipt");
    }
    const next = data.next_page_params;
    if (!next || !Object.keys(next).length) break;
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(next)) qs.set(k, String(v));
    p = `/api/v2/addresses/${ROY}/token-transfers?${qs}`;
  }
}

const hashes = [...hashSet];
console.log("sale txs (market + royalty reverse)", hashes.length);

const sales = [];
const seen = new Set();
const CONC = 8;
for (let i = 0; i < hashes.length; i += CONC) {
  const slice = hashes.slice(i, i + CONC);
  process.stdout.write(`\r pricing ${Math.min(i + CONC, hashes.length)}/${hashes.length}`);
  const parts = await Promise.all(
    slice.map((h) => priceTx(h, methodByHash.get(h)).catch(() => []))
  );
  for (const list of parts) {
    for (const s of list) {
      const k = `${s.txHash}:${s.tokenId}`;
      if (seen.has(k)) continue;
      seen.add(k);
      sales.push(s);
    }
  }
}
console.log("\nsales with royalty gate", sales.length);

sales.sort((a, b) => {
  const aw = BigInt(a.priceWei);
  const bw = BigInt(b.priceWei);
  return aw === bw ? 0 : aw > bw ? -1 : 1;
});

if (sales[0]) {
  console.log(
    "HIGHEST",
    Number(sales[0].priceWei) / 1e18,
    "eth token",
    sales[0].tokenId,
    "platform",
    sales[0].platform,
    "tx",
    sales[0].txHash
  );
  console.log("top 10:");
  for (const s of sales.slice(0, 10)) {
    console.log(
      " ",
      (Number(s.priceWei) / 1e18).toFixed(6),
      "Ξ",
      `#${s.tokenId}`,
      s.platform,
      `roy ${(Number(s.royaltyWei) / 1e18).toFixed(6)}`
    );
  }
}

const blob = { version: 2, sales, updatedAt: Date.now() };
const { kv } = await import("@vercel/kv");
await kv.set(KV_KEY, blob, { ex: 7 * 24 * 60 * 60 });
// v1 flat map for any leftover consumers
const flat = {};
for (const s of sales) flat[`${s.txHash}:${s.tokenId}`] = s.priceWei;
await kv.set(KV_KEY_V1, flat, { ex: 7 * 24 * 60 * 60 });
console.log("KV ok", KV_KEY, "and", KV_KEY_V1);
