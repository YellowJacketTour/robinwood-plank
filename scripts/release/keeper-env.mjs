// Reads public/arcade/deploy-addresses.local.json (written fresh by
// local-casino-setup.ts every deploy -- see that script's own comment on
// why the frontend/keeper must never rely on a hardcoded, potentially
// stale address) and prints the exact KEEPER_* env vars casino-keeper.ts
// needs, as a single line START.bat can eval directly. Keeps START.bat
// itself dumb (no JSON parsing in batch) and this file as the one place
// that knows the manifest's shape.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const manifestPath = join(here, "..", "..", "public", "arcade", "deploy-addresses.local.json");

let manifest;
try {
  manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
} catch {
  console.error(`Could not read ${manifestPath} -- did local-casino-setup.ts run and finish successfully?`);
  process.exit(1);
}

// The well-known first Hardhat local test account -- same one crash.html's
// own LOCAL_ACCOUNTS[0] ("Deployer") uses, funded with 10000 fake ETH on
// every fresh local node by Hardhat itself, never a real key.
const KEEPER_PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

const lines = [
  `set KEEPER_RPC_URL=http://127.0.0.1:8545`,
  `set KEEPER_PK=${KEEPER_PK}`,
  `set CRASH_ADDRESS=${manifest.crash}`,
  `set POWERBOARD_ADDRESS=${manifest.powerboard}`,
  `set BEACON_ADDRESS=${manifest.beacon}`,
  `set DISTRIBUTOR_ADDRESS=${manifest.distributor}`,
  `set ORACLE_ADDRESS=${manifest.oracle}`,
  `set BURN_ENGINE_ADDRESS=${manifest.burnEngine}`,
  `set KEEPER_MOCK_BEACON=1`,
];
console.log(lines.join("\n"));
