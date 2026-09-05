// Exports the CURRENT compiled ABIs the arcade wallet client and dev panels
// bind to. Source of truth: the hardhat artifacts of the canonical set
// (contracts/PlankCrash.sol, PlankLottery.sol, PlankBank.sol,
// PlankRakeRouter.sol, IDrandBeacon.sol). Run after every contract change:
//
//   npm run compile && node scripts/export-arcade-abi.mjs
//
// The market test test/market/arcade-abi.test.ts fails whenever these files
// drift from the artifacts, so the page can never bind to a retired ABI again.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
export const ARCADE_ABI_SET = [
  ["PlankCrash", "contracts/PlankCrash.sol/PlankCrash.json"],
  ["PlankLottery", "contracts/PlankLottery.sol/PlankLottery.json"],
  ["PlankBank", "contracts/PlankBank.sol/PlankBank.json"],
  ["PlankRakeRouter", "contracts/PlankRakeRouter.sol/PlankRakeRouter.json"],
  ["IDrandBeacon", "contracts/IDrandBeacon.sol/IDrandBeacon.json"],
];

export function artifactAbi(relative) {
  return JSON.parse(readFileSync(join(root, ".hardhat-artifacts", relative), "utf8")).abi;
}

export function exportArcadeAbis(outDir = join(root, "public", "arcade", "abi")) {
  mkdirSync(outDir, { recursive: true });
  const written = [];
  for (const [name, relative] of ARCADE_ABI_SET) {
    const abi = artifactAbi(relative);
    const file = join(outDir, `${name}.json`);
    writeFileSync(file, JSON.stringify(abi, null, 1) + "\n");
    written.push({ name, file, functions: abi.filter((x) => x.type === "function").length });
  }
  return written;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  for (const row of exportArcadeAbis()) console.log(`${row.name.padEnd(16)} ${row.functions} functions -> ${row.file}`);
}
