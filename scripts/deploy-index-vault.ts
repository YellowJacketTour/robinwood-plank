/**
 * ============================================================================
 *  deploy-index-vault — the real, runnable version of the atomic
 *  deploy-cut-finalize sequence `IndexDeployer.sol` proves in tests (design
 *  doc §7.8, item 2).
 *
 *  DELIBERATELY REUSES `deployIndexDiamond` FROM THE TEST HELPERS
 *  (`test/contracts/helpers/diamond.ts`) RATHER THAN REIMPLEMENTING THE
 *  SEQUENCE. That helper is exactly what `Diamond.finalize.test.ts` and
 *  every `GlobalIndexVault.*.test.ts` suite already exercises: deploy every
 *  facet, deploy `IndexDeployer` (which deploys the diamond, cuts every
 *  facet in, finalizes and self-checks — all inside ONE transaction, see
 *  `contracts/diamond/IndexDeployer.sol`'s header for why that atomicity is
 *  the whole point), and hand back the frozen diamond's address. Calling the
 *  SAME function real deploy tooling calls is what makes "not a divergent
 *  reimplementation" true by construction rather than by promise — a
 *  hand-copied second implementation is exactly the kind of drift that would
 *  make this script's sequence something OTHER than what the test suite
 *  proved correct.
 *
 *  The facet set is `INDEX_FACETS` from `test/contracts/helpers/index-vault.ts`
 *  — the single declaration site every existing suite already cuts from
 *  (`Diamond.selectors.test.ts` asserts its ABI union is 4-byte-unique). This
 *  script does not maintain its own facet list.
 *
 *  WHAT THIS SCRIPT DOES NOT DO: seed constituents, open the index, or queue
 *  any governed risk parameter. Those are separate, explicit steps —
 *  `scripts/seed-index-vault-genesis.ts` and
 *  `scripts/configure-index-vault-governance.ts` — on purpose, the same way
 *  `scripts/deploy-and-seed-v3.ts` keeps `openPool()` gated behind its own
 *  `CONFIRM_OPEN` flag: a diamond that is FINALIZED (uncuttable) is not the
 *  same decision as a basket that is OPEN (publicly tradable), and bundling
 *  them would remove the deliberate pause between them.
 *
 *  Usage:
 *    MARKET_INDEX_SEEDER=0x.. MARKET_INDEX_DIVIDEND_ASSET=0x.. \
 *    MARKET_INDEX_ROLE_ADMIN=0x.. MARKET_INDEX_ROLE_ADMISSION=0x.. \
 *    MARKET_INDEX_ROLE_RISK=0x.. MARKET_INDEX_ROLE_ALLOCATION=0x.. \
 *    DEPLOYER_PK=0x... ROBINHOOD_TESTNET_RPC_URL=... ROBINHOOD_TESTNET_CHAIN_ID=... \
 *    npx hardhat run scripts/deploy-index-vault.ts --network robinhood-testnet
 *
 *  Or, for the local verification harness this stage also ships
 *  (test/contracts/DeployIndexVault.script.test.ts):
 *    npx hardhat run scripts/deploy-index-vault.ts --network localhost
 * ============================================================================
 */
import hardhat from "hardhat";
import { writeFileSync, mkdirSync } from "node:fs";
import {
  loadCoreConfig,
  loadGenesisRoles,
  loadRiskParams,
  riskParamsTuple,
  rolesTuple,
} from "./config/index-vault-deploy-config";

// Imported, not reimplemented — see the file header for why this is load-
// bearing rather than a convenience.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { deployIndexDiamond } = require("../test/contracts/helpers/diamond") as typeof import("../test/contracts/helpers/diamond");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { INDEX_FACETS } = require("../test/contracts/helpers/index-vault") as typeof import("../test/contracts/helpers/index-vault");

export interface DeployIndexVaultResult {
  diamondAddress: string;
  deployerAddress: string;
  committedFacetSetHash: string;
  manifest: { name: string; facet: string; selectors: string[] }[];
  txHash: string;
}

/**
 * Runs the exact sequence `deployIndexDiamond` performs in every existing
 * suite, against whatever `hardhat`'s currently-configured network is
 * (`--network <name>` on the CLI, or the network `hardhat.config.ts`
 * resolves to for `hardhat.network.name`). Returns enough to verify the
 * result independently, the same way `Diamond.finalize.test.ts` does.
 */
export async function deployIndexVault(): Promise<DeployIndexVaultResult> {
  const core = loadCoreConfig();
  const roles = loadGenesisRoles();
  const params = loadRiskParams();

  console.log(`Deploying the index diamond to network "${hardhat.network.name}"...`);
  console.log(`  name/symbol: ${core.name} / ${core.symbol}`);
  console.log(`  seeder: ${core.seeder}`);
  console.log(`  dividendAsset: ${core.dividendAsset}`);
  console.log(`  timelockDelay: ${core.timelockDelay}s`);
  console.log(`  roles: ${JSON.stringify(roles)}`);
  console.log(`  facet count: ${INDEX_FACETS.length}`);

  const d = await deployIndexDiamond([...INDEX_FACETS], {
    timelockDelay: core.timelockDelay,
    seeder: core.seeder,
    dividendAsset: core.dividendAsset,
    name: core.name,
    symbol: core.symbol,
    roles: rolesTuple(roles),
    params: riskParamsTuple(params),
  });

  const txHash = d.deployer.deploymentTransaction()!.hash;
  console.log(`Diamond deployed and finalized in tx ${txHash}`);
  console.log(`  diamond: ${d.address}`);
  console.log(`  deployer (IndexDeployer): ${await d.deployer.getAddress()}`);
  console.log(`  committedFacetSetHash: ${d.committedHash}`);

  // Self-check mirrors what Diamond.finalize.test.ts asserts about every
  // diamond deployIndexDiamond produces — re-asserted here, against a real
  // network, so a divergence between "what the test suite proved" and "what
  // this script just did" fails loudly rather than silently.
  if (!(await d.loupe.isFinalized())) throw new Error("Deployed diamond is not finalized — refusing to report success.");
  if (await d.loupe.isDevMode()) throw new Error("Deployed diamond reports devMode — this is Tier B, not production. Refusing.");

  return {
    diamondAddress: d.address,
    deployerAddress: await d.deployer.getAddress(),
    committedFacetSetHash: d.committedHash,
    manifest: d.manifest.map((m: { name: string; facet: string; selectors: string[] }) => ({
      name: m.name,
      facet: m.facet,
      selectors: m.selectors,
    })),
    txHash,
  };
}

async function main() {
  const result = await deployIndexVault();
  mkdirSync("deploy-out", { recursive: true });
  const outPath = `deploy-out/index-vault.${hardhat.network.name}.json`;
  writeFileSync(outPath, JSON.stringify(result, null, 2));
  console.log(`Wrote ${outPath}`);
}

// Only auto-run when invoked directly (`hardhat run`) — importable by the
// local verification harness without side effects.
if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
