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
    v = v.replace(/\\n/g, "").trim();
    map[line.slice(0, i)] = v;
  }
  return map;
}

const env = parseEnv(path.join(root, ".env.local"));
const vault = env.NEXT_PUBLIC_MARKET_VAULT_ADDRESS;
const kvUrl = env.KV_REST_API_URL;
const kvTok = env.KV_REST_API_TOKEN;
if (!vault || !kvUrl || !kvTok) {
  console.error("Missing vault or KV env");
  process.exit(1);
}

const iface = new Interface(abi);
const rpc = "https://rpc.mainnet.chain.robinhood.com";

async function ethCall(data) {
  const r = await fetch(rpc, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_call",
      params: [{ to: vault, data }, "latest"],
    }),
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message);
  return j.result;
}

const names = [
  ["ethReserve", []],
  ["balanceOf", [vault]],
  ["heldTokenCount", []],
  ["poolOpen", []],
  ["mintFeeBps", []],
  ["redeemFeeBps", []],
  ["targetPremiumBps", []],
];

const hexes = [];
for (const [name, args] of names) {
  hexes.push(await ethCall(iface.encodeFunctionData(name, args)));
}

const ethReserveWei = BigInt(iface.decodeFunctionResult("ethReserve", hexes[0])[0]);
const shareReserveWei = BigInt(iface.decodeFunctionResult("balanceOf", hexes[1])[0]);
const heldTokenCount = Number(iface.decodeFunctionResult("heldTokenCount", hexes[2])[0]);
const poolOpen = Boolean(iface.decodeFunctionResult("poolOpen", hexes[3])[0]);
const mintFeeBps = Number(iface.decodeFunctionResult("mintFeeBps", hexes[4])[0]);
const redeemFeeBps = Number(iface.decodeFunctionResult("redeemFeeBps", hexes[5])[0]);
const targetPremiumBps = Number(iface.decodeFunctionResult("targetPremiumBps", hexes[6])[0]);
const sharePriceWei =
  shareReserveWei > 0n ? (ethReserveWei * 10n ** 18n) / shareReserveWei : null;

let ethUsd = null;
try {
  const cg = await fetch(
    "https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd"
  );
  const j = await cg.json();
  ethUsd = j?.ethereum?.usd ?? null;
} catch {
  /* optional */
}

const stats = {
  poolOpen,
  ethReserveWei: ethReserveWei.toString(),
  shareReserveWei: shareReserveWei.toString(),
  heldTokenCount,
  heldTokenIds: [],
  sharePriceWei: sharePriceWei?.toString() ?? null,
  mintFeeBps,
  redeemFeeBps,
  targetPremiumBps,
  ethUsd,
  aprPct: null,
  aprBasisHours: null,
  depositCount: 0,
  redeemCount: 0,
  vaultFeeRevenueWei: "0",
  marketplaceFeeRevenueEstWei: "0",
};

const blob = { at: Date.now(), stats };
const setRes = await fetch(kvUrl, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${kvTok}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify(["SET", "plank:market:vault-stats", JSON.stringify(blob), "EX", "900"]),
});
console.log("kv", setRes.status, await setRes.text());
console.log("seeded", {
  poolOpen,
  heldTokenCount,
  sharePriceWei: sharePriceWei?.toString(),
  ethUsd,
});
