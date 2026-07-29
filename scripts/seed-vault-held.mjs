/**
 * Seed vault held-token IDs into Upstash so Cloudflare can serve the fence
 * even while public RPC is rate-limiting Worker egress.
 */
import { Interface } from "ethers";
import abi from "../lib/market/vault-abi.json" with { type: "json" };
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
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
const vault = env.NEXT_PUBLIC_MARKET_VAULT_ADDRESS;
const kvUrl = env.KV_REST_API_URL;
const kvTok = env.KV_REST_API_TOKEN;
const iface = new Interface(abi);
const rpc = "https://rpc.mainnet.chain.robinhood.com";
const TOTAL = 1542;
const BATCH = 100;

async function callMany(calls) {
  const batch = calls.map((c, i) => ({
    jsonrpc: "2.0",
    id: i + 1,
    method: "eth_call",
    params: [{ to: c.to, data: c.data }, "latest"],
  }));
  const r = await fetch(rpc, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(batch),
  });
  const j = await r.json();
  if (!Array.isArray(j)) throw new Error("batch failed");
  return j.sort((a, b) => a.id - b.id).map((row) => row.result);
}

const held = [];
for (let start = 0; start <= TOTAL; start += BATCH) {
  const ids = [];
  for (let id = start; id < start + BATCH && id <= TOTAL; id++) ids.push(id);
  const results = await callMany(
    ids.map((id) => ({
      to: vault,
      data: iface.encodeFunctionData("isTokenHeld", [BigInt(id)]),
    }))
  );
  for (let i = 0; i < ids.length; i++) {
    const hex = results[i];
    if (!hex) continue;
    if (Boolean(iface.decodeFunctionResult("isTokenHeld", hex)[0])) {
      held.push(String(ids[i]));
    }
  }
  process.stdout.write(`\r scanned ${Math.min(start + BATCH, TOTAL)} / ${TOTAL} held=${held.length}`);
}
console.log("\nheld", held.length);

const blob = { at: Date.now(), ids: held };
const setRes = await fetch(kvUrl, {
  method: "POST",
  headers: { Authorization: `Bearer ${kvTok}`, "Content-Type": "application/json" },
  body: JSON.stringify(["SET", "plank:market:vault-held-ids", JSON.stringify(blob), "EX", "900"]),
});
console.log("kv", setRes.status, await setRes.text());
