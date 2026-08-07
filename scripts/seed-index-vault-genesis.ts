/**
 * ============================================================================
 *  seed-index-vault-genesis — parameter-setting script for the genesis
 *  constituent list (design doc §7.8, item 3).
 *
 *  Calls the seeder-only bootstrap surface (`IndexBootstrapFacet.seedConstituent`
 *  / `seedDeposit`, then `openIndex`) against an already-deployed, already-
 *  finalized diamond, exactly as `test/contracts/helpers/index-vault.ts`'s
 *  `deployOpenIndex` fixture does for every existing test — same three
 *  calls, same order, same "seedConstituent before seedDeposit before
 *  openIndex" sequencing the contract itself enforces
 *  (`IndexBootstrapFacet.sol`: both seeder calls revert once `indexOpen` is
 *  true).
 *
 *  `openIndex` is ONE-WAY (mirrors `MarketplankVaultV3.openPool()`'s existing
 *  "openPool() is ONE-WAY" gating in scripts/deploy-and-seed-v3.ts): it is
 *  only called when CONFIRM_OPEN=1 is set, so a rehearsal run can seed and
 *  inspect without accidentally opening the basket to the public.
 *
 *  Usage:
 *    MARKET_INDEX_DIAMOND=0x.. MARKET_INDEX_GENESIS_CONSTITUENTS='[...]' \
 *    DEPLOYER_PK=0x... (must control the seeder address) CONFIRM_OPEN=1 \
 *    MARKET_INDEX_SEED_SHARES=1000000000000000000000 \
 *    npx hardhat run scripts/seed-index-vault-genesis.ts --network robinhood-testnet
 * ============================================================================
 */
import hardhat from "hardhat";
import { loadGenesisConstituents } from "./config/index-vault-deploy-config";
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { INDEX_FACETS } = require("../test/contracts/helpers/index-vault") as typeof import("../test/contracts/helpers/index-vault");
const { ethers } = hardhat as unknown as { ethers: typeof import("ethers") & Record<string, unknown> };

function reqAddr(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Set ${name} before running this script.`);
  return v;
}

export async function seedIndexVaultGenesis(diamondAddress: string) {
  const constituents = loadGenesisConstituents();
  const [signer] = (await (ethers as any).getSigners()) as any[];

  const abi: any[] = [];
  const seen = new Set<string>();
  for (const n of INDEX_FACETS) {
    const art = await (hardhat as any).artifacts.readArtifact(n);
    for (const frag of art.abi) {
      const key = JSON.stringify(frag);
      if (seen.has(key)) continue;
      seen.add(key);
      abi.push(frag);
    }
  }
  const vault = new (ethers as any).Contract(diamondAddress, abi, signer);

  const indexOpen: boolean = await vault.indexOpen();
  if (indexOpen) throw new Error(`Diamond ${diamondAddress} is already open — nothing to seed.`);

  for (const c of constituents) {
    console.log(`seedConstituent(${c.token}, ${c.source}, ${c.rawTargetWeightBps}bps)`);
    await (await vault.seedConstituent(c.token, c.source, c.rawTargetWeightBps)).wait();

    const token = new (ethers as any).Contract(
      c.token,
      ["function approve(address,uint256) returns (bool)"],
      signer
    );
    console.log(`approve(${diamondAddress}, ${c.seedAmount})`);
    await (await token.approve(diamondAddress, c.seedAmount)).wait();

    console.log(`seedDeposit(${c.token}, ${c.seedAmount})`);
    await (await vault.seedDeposit(c.token, c.seedAmount)).wait();
  }

  if (process.env.CONFIRM_OPEN === "1") {
    const seedShares = process.env.MARKET_INDEX_SEED_SHARES;
    if (!seedShares) throw new Error("Set MARKET_INDEX_SEED_SHARES before opening (CONFIRM_OPEN=1).");
    console.log(`openIndex(${seedShares}) — ONE-WAY, locking the seed forever`);
    await (await vault.openIndex(BigInt(seedShares))).wait();
    console.log("Index is now open.");
  } else {
    console.log("CONFIRM_OPEN not set to 1 — genesis constituents seeded but the index was NOT opened.");
  }

  return { diamondAddress, constituentCount: constituents.length, opened: process.env.CONFIRM_OPEN === "1" };
}

async function main() {
  const diamondAddress = reqAddr("MARKET_INDEX_DIAMOND");
  const result = await seedIndexVaultGenesis(diamondAddress);
  console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
