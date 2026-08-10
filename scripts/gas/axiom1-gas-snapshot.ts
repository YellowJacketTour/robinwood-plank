/**
 * ============================================================================
 *  axiom1-gas-snapshot — PR11 (TEST-MATRIX-AXIOM-1-ADVERSARIAL.md §8, "Gas
 *  budgets (document, not hard fail initially)").
 *
 *  Measures real, on-chain-observed gas for `EnergyBus.route()` in the two
 *  cases the matrix asks for:
 *    1. route() with EMPTY weights — no admitted collections, every pipe
 *       either has no work (Pipes L/X/P/R/D still run, but Pipe I's own
 *       internal per-leg loop is zero-length) or gracefully skips.
 *    2. route() with 2 SEEDED vaults — the real two-collection deploy
 *       ceremony `scripts/deploy/axiom1-local.ts` already proves end to end
 *       (`deployAxiom1Local`), reused here rather than reimplemented, funded
 *       with a fresh routable WETH balance post-deploy.
 *
 *  This is DOCUMENTATION, not a hard-fail gate (matrix §8's own framing) —
 *  it writes `docs/GAS-SNAPSHOT-AXIOM-1.md` with the real numbers observed on
 *  this run, against the soft targets the matrix already states.
 *
 *  Usage:
 *    npx hardhat run scripts/gas/axiom1-gas-snapshot.ts --network hardhat
 * ============================================================================
 */
import hardhat from "hardhat";
import { writeFileSync } from "node:fs";

const { ethers } = hardhat;

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { deployAxiom1Local } = require("../deploy/axiom1-local") as typeof import("../deploy/axiom1-local");

async function gasEmptyWeights(): Promise<bigint> {
  const [deployer] = await ethers.getSigners();

  const weth: any = await (await ethers.getContractFactory("MockWeth")).deploy();
  const wethAddr = await weth.getAddress();

  // A real WeightModule with NO admitted vaults (empty weights()), a real
  // InventoryBuyAdapter against it (so Pipe I's own real "n == 0 -> safe
  // skip" branch runs, not a mock stand-in), and 5 MockEnergyAdapter
  // SPEND_ALL stand-ins for the other pipes (this measurement is about the
  // Bus's own route() overhead with nothing for Pipe I to actually buy, not
  // about re-measuring the other 5 pipes' own adapter-specific gas).
  const factory: any = await (
    await ethers.getContractFactory("CollectionVaultFactory")
  ).deploy(deployer.address, wethAddr, 48 * 3600);
  const weightModule: any = await (
    await ethers.getContractFactory("WeightModule")
  ).deploy(await factory.getAddress());

  const busDeployerNonce = await ethers.provider.getTransactionCount(deployer.address);
  const predictedBus = ethers.getCreateAddress({ from: deployer.address, nonce: busDeployerNonce + 6 });

  const InvAdapterF = await ethers.getContractFactory("InventoryBuyAdapter");
  const inv: any = await InvAdapterF.deploy(wethAddr, deployer.address, predictedBus, await weightModule.getAddress());
  const MockAdapterFactory = await ethers.getContractFactory("MockEnergyAdapter");
  const clp: any = await MockAdapterFactory.deploy(wethAddr);
  const idxBurn: any = await MockAdapterFactory.deploy(wethAddr);
  const plankBurn: any = await MockAdapterFactory.deploy(wethAddr);
  const plankLp: any = await MockAdapterFactory.deploy(wethAddr);
  const div: any = await MockAdapterFactory.deploy(wethAddr);

  const bus: any = await (
    await ethers.getContractFactory("EnergyBus")
  ).deploy(
    wethAddr,
    [
      await inv.getAddress(),
      await clp.getAddress(),
      await idxBurn.getAddress(),
      await plankBurn.getAddress(),
      await plankLp.getAddress(),
      await div.getAddress(),
    ],
    [3_500, 1_500, 1_500, 1_000, 1_000, 1_500]
  );
  const busAddr = await bus.getAddress();
  if (busAddr !== predictedBus) {
    throw new Error(`gas snapshot: Bus landed at ${busAddr}, predicted ${predictedBus}`);
  }

  await (await weth.mint(busAddr, ethers.parseEther("1"))).wait();

  const tx = await bus.route();
  const receipt = await tx.wait();
  return receipt!.gasUsed as bigint;
}

async function gasTwoVaults(): Promise<{ gasUsed: bigint; collections: number }> {
  const result = await deployAxiom1Local();
  const [deployer] = await ethers.getSigners();

  const weth: any = await ethers.getContractAt("MockWeth", result.weth);
  const bus: any = await ethers.getContractAt("EnergyBus", result.bus);

  // Fund the (already finalized) Bus with a fresh routable WETH balance —
  // finalize() carries no privilege over route(), so this is exactly the
  // ordinary permissionless post-launch flow.
  await (await weth.mint(result.bus, ethers.parseEther("1"))).wait();

  const tx = await bus.connect(deployer).route();
  const receipt = await tx.wait();
  return { gasUsed: receipt!.gasUsed as bigint, collections: result.collections.length };
}

async function main() {
  console.log("Measuring EnergyBus.route() gas — empty weights...");
  const emptyGas = await gasEmptyWeights();
  console.log(`  route() empty weights: ${emptyGas} gas`);

  console.log("Measuring EnergyBus.route() gas — 2 seeded vaults (real axiom1-local deploy)...");
  const { gasUsed: twoVaultGas, collections } = await gasTwoVaults();
  console.log(`  route() ${collections} vaults: ${twoVaultGas} gas`);

  const now = new Date().toISOString();
  const md = `# GAS SNAPSHOT — AXIOM-1 EnergyBus.route()

**Generated:** ${now}
**Network:** ${hardhat.network.name}
**Source:** \`scripts/gas/axiom1-gas-snapshot.ts\` (run via \`npx hardhat run scripts/gas/axiom1-gas-snapshot.ts --network hardhat\`)

Per \`docs/TEST-MATRIX-AXIOM-1-ADVERSARIAL.md\` §8 — documentation only, not a
hard-fail gate.

| Op | Soft target (matrix §8) | Observed |
|----|--------------------------|----------|
| \`route()\` empty weights | < 200k | ${emptyGas.toString()} |
| \`route()\` 2 seeded vaults (real \`axiom1-local.ts\` deploy, real 6 adapters, real WeightModule/index) | < 2.5M (matrix's own row is stated for 8 vaults; 2 vaults is this repo's real \`axiom1-local.ts\` seed count) | ${twoVaultGas.toString()} |

## Notes

- "Empty weights" measures a real \`EnergyBus.route()\` against a real
  \`InventoryBuyAdapter\` whose \`WeightModule\` has zero admitted vaults (Pipe
  I's own \`n == 0\` safe-skip branch), with \`MockEnergyAdapter\` (SPEND_ALL)
  standing in for the other five pipes — this isolates the Bus's own
  six-pipe dispatch overhead from any one pipe's adapter-specific cost.
- "2 seeded vaults" runs the ACTUAL \`deployAxiom1Local()\` ceremony
  (\`scripts/deploy/axiom1-local.ts\`) — every adapter, the real
  \`WeightModule\`, the real index Diamond, two real \`CollectionVault\`s, both
  admitted into weights — then funds the (already-\`finalize()\`d) Bus with
  fresh WETH and measures one real \`route()\` call across all 6 real pipes.
- Gas numbers on a local Hardhat network are a reasonable proxy for L1/L2
  mainnet cost ordering, not a guaranteed absolute figure — re-run this
  script after any change to the adapters, \`EnergyBus\`, \`WeightModule\`, or
  the index Diamond's \`creditInventory\`/\`reconcile\` path to refresh it.
`;

  writeFileSync("docs/GAS-SNAPSHOT-AXIOM-1.md", md);
  console.log("\nWrote docs/GAS-SNAPSHOT-AXIOM-1.md");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}

export { gasEmptyWeights, gasTwoVaults };
