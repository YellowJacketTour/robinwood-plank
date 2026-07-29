/**
 * Seed vault buy/sell/deposit/redeem history into Upstash for CF Workers.
 * Usage: node scripts/seed-vault-activity.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Interface } from "ethers";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const VAULT = "0xb2019Fd4cA24502e812C0C73b751Fa49979BF708";
const BASE = "https://robinhoodchain.blockscout.com";
const KV_KEY = "plank:market:vault-activity-v1";
const abi = JSON.parse(fs.readFileSync(path.join(root, "lib/market/vault-abi.json"), "utf8"));
const IFACE = new Interface(abi);
const TOPICS = {
  Bought: IFACE.getEvent("Bought").topicHash.toLowerCase(),
  Sold: IFACE.getEvent("Sold").topicHash.toLowerCase(),
  Deposited: IFACE.getEvent("Deposited").topicHash.toLowerCase(),
  Redeemed: IFACE.getEvent("Redeemed").topicHash.toLowerCase(),
};
const SET = new Set(Object.values(TOPICS));

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

function decode(log) {
  const topics = (log.topics || [])
    .filter((t) => typeof t === "string" && t.length > 0)
    .map((t) => (t.startsWith("0x") ? t : `0x${t}`).toLowerCase());
  const topic0 = topics[0];
  if (!topic0 || !SET.has(topic0)) return null;
  const data = log.data && log.data !== "0x" ? log.data : "0x";
  const base = {
    txHash: log.transaction_hash || log.transactionHash || "",
    blockNumber: Number(log.block_number || log.blockNumber || 0),
    logIndex: Number(log.index ?? log.logIndex ?? 0),
    timestamp: log.block_timestamp || log.timestamp || null,
  };
  try {
    if (topic0 === TOPICS.Deposited) {
      const p = IFACE.decodeEventLog("Deposited", data, topics);
      return { ...base, kind: "deposit", address: String(p.from), ethWei: null, sharesWei: null, tokenId: p.tokenId.toString() };
    }
    if (topic0 === TOPICS.Redeemed) {
      const p = IFACE.decodeEventLog("Redeemed", data, topics);
      return { ...base, kind: "redeem", address: String(p.to), ethWei: null, sharesWei: null, tokenId: p.tokenId.toString() };
    }
    if (topic0 === TOPICS.Bought) {
      const p = IFACE.decodeEventLog("Bought", data, topics);
      return { ...base, kind: "buy", address: String(p.buyer), ethWei: p.ethIn.toString(), sharesWei: p.sharesOut.toString(), tokenId: null };
    }
    if (topic0 === TOPICS.Sold) {
      const p = IFACE.decodeEventLog("Sold", data, topics);
      return { ...base, kind: "sell", address: String(p.seller), ethWei: p.ethOut.toString(), sharesWei: p.sharesIn.toString(), tokenId: null };
    }
  } catch {
    return null;
  }
  return null;
}

const events = [];
let pathUrl = `/api/v2/addresses/${VAULT}/logs`;
for (let page = 0; page < 40; page++) {
  process.stdout.write(`\r logs page ${page + 1} events ${events.length}`);
  const res = await fetch(BASE + pathUrl, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  for (const log of data.items || []) {
    const ev = decode(log);
    if (ev) events.push(ev);
  }
  const next = data.next_page_params;
  if (!next || !Object.keys(next).length) break;
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(next)) qs.set(k, String(v));
  pathUrl = `/api/v2/addresses/${VAULT}/logs?${qs}`;
}
console.log("\ndecoded", events.length);
const byKind = {};
for (const e of events) byKind[e.kind] = (byKind[e.kind] || 0) + 1;
console.log(byKind);

events.sort((a, b) => b.blockNumber - a.blockNumber || b.logIndex - a.logIndex);
const { kv } = await import("@vercel/kv");
await kv.set(KV_KEY, events.slice(0, 500), { ex: 7 * 24 * 60 * 60 });
console.log("KV ok", KV_KEY, "stored", Math.min(500, events.length));
