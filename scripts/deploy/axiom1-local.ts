/**
 * ============================================================================
 *  axiom1-local — PR10 (ONESHOT §5.5, §7 PR10 row, §9 deploy ceremony).
 *
 *  Runs the ACTUAL 12-step AXIOM-1 deploy ceremony from ONESHOT §9 against a
 *  local Hardhat network, deploying every real contract PR1-9 shipped (no
 *  mocks for anything on the energy/vault/index critical path — only WETH,
 *  the NFT collections, and the external PLANK venue are test doubles,
 *  exactly as every existing suite already treats them).
 *
 *  This is DELIBERATELY the same wiring
 *  `test/contracts/energy/FactorySinkBusIntegration.test.ts` (PR8) already
 *  proved correct — same predicted-Bus-address trick, same fixed adapter
 *  deploy order, same factory/vault/index/bus wiring calls — turned into a
 *  runnable script rather than a divergent reimplementation. Where PR8's test
 *  used ONE collection, this script seeds TWO (ONESHOT §9 step 10: "Seed >=2
 *  collections"), and it actually calls `EnergyBus.finalize()` (§9 step 11),
 *  which PR8's test never needed to exercise.
 *
 *  ONESHOT §5.5 step 5 "InventoryStake per vault template / beacon if
 *  needed" is SKIPPED here on purpose: `InventoryStake.sol` was deleted in
 *  the share-atom correction (commit 179f96f, DESIGN-CAKE-EAT-IT-SHARE-ATOM-
 *  2026-08-08.md) — `CollectionVault`'s own single share `S` already IS the
 *  compounding unit (fees raise the vault's own reserve ratio behind `S`,
 *  see `CollectionVault.sol`'s Stream A/B fee routing), so there is no
 *  separate xToken-over-vToken wrapper left to deploy. Likewise ONESHOT §9
 *  step 10's "optional xToken seed" is satisfied by seeding real vault
 *  deposits (`S`) directly into the index (step below), not a second token.
 *
 *  Usage:
 *    npx hardhat run scripts/deploy/axiom1-local.ts --network hardhat
 *    npx hardhat run scripts/deploy/axiom1-local.ts --network localhost
 * ============================================================================
 */
import hardhat from "hardhat";
import { writeFileSync, mkdirSync } from "node:fs";

const { ethers } = hardhat;

// Reused, not reimplemented — same doctrine as scripts/deploy-index-vault.ts.
import { time } from "@nomicfoundation/hardhat-network-helpers";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { deployIndexVault, defaultParams, paramsTuple, TIMELOCK } =
  require("../../test/contracts/helpers/index-vault") as typeof import("../../test/contracts/helpers/index-vault");

const INV_BPS = 3_500n;
const CLP_BPS = 1_500n;
const IDX_BURN_BPS = 1_500n;
const PLANK_BURN_BPS = 1_000n;
const PLANK_LP_BPS = 1_000n;
const DIV_BPS = 1_500n;
const MINT_REDEEM_SINK_BPS = 3_000;
const F_MIN_WEI = ethers.parseEther("0.05");

export interface Axiom1DeployResult {
  weth: string;
  plank: string;
  factory: string;
  weightModule: string;
  index: string;
  bus: string;
  adapters: {
    inv: string;
    clp: string;
    idxBurn: string;
    plankBurn: string;
    plankLp: string;
    div: string;
  };
  collections: { nft: string; vault: string }[];
  finalized: boolean;
  txHashes: Record<string, string>;
}

export async function deployAxiom1Local(): Promise<Axiom1DeployResult> {
  console.log(`Deploying AXIOM-1 stack to network "${hardhat.network.name}"...`);
  const [deployer, treasury, seeder, roleAdmin, admission, risk, allocation, alice, bob, busDeployer, governance] =
    await ethers.getSigners();

  const txHashes: Record<string, string> = {};

  // ── STEP 1: WETH (+ mock NFTs for 2 collections, PLANK venue mocks) ──────
  const weth: any = await (await ethers.getContractFactory("MockWeth")).deploy();
  const wethAddr = await weth.getAddress();
  console.log(`1. WETH deployed at ${wethAddr}`);

  const nftA: any = await (await ethers.getContractFactory("MockRobinWoodNft")).deploy();
  const nftB: any = await (await ethers.getContractFactory("MockRobinWoodNft")).deploy();
  console.log(`   Collection A NFT: ${await nftA.getAddress()}`);
  console.log(`   Collection B NFT: ${await nftB.getAddress()}`);

  const swapRouter: any = await (await ethers.getContractFactory("MockExternalSwapRouter")).deploy(ethers.parseEther("1"));
  const swapRouterAddr = await swapRouter.getAddress();
  const plankAddr = await swapRouter.plank();
  const plankLpRouter: any = await (
    await ethers.getContractFactory("MockExternalPlankLpRouter")
  ).deploy(plankAddr, wethAddr);
  const plankLpRouterAddr = await plankLpRouter.getAddress();
  console.log(`   PLANK swap router: ${swapRouterAddr} (PLANK token: ${plankAddr})`);
  console.log(`   PLANK/WETH LP router: ${plankLpRouterAddr}`);

  // ── Predict the Bus address (step 7) so the factory (step 8's dependency,
  //    but deployed here per PR8's own proven ordering) can point its
  //    immutable upstreamSink directly at it. busDeployer is dedicated to
  //    exactly the 6 adapter deploys + the Bus deploy below, nonce 0..6. ────
  const predictedBus = ethers.getCreateAddress({ from: busDeployer.address, nonce: 6 });
  console.log(`   Predicted EnergyBus address: ${predictedBus}`);

  // ── STEP 2: WeightModule needs the factory address; factory needs the
  //    predicted Bus. Deploy factory first (its upstreamSink is set once,
  //    immutably, at construction), then WeightModule against it. ─────────
  const factory: any = await (
    await ethers.getContractFactory("CollectionVaultFactory")
  ).deploy(predictedBus, wethAddr, TIMELOCK);
  const factoryAddr = await factory.getAddress();
  console.log(`8. CollectionVaultFactory deployed at ${factoryAddr} (upstreamSink=${predictedBus})`);

  const weightModule: any = await (await ethers.getContractFactory("WeightModule")).deploy(factoryAddr);
  const weightModuleAddr = await weightModule.getAddress();
  console.log(`2. WeightModule deployed at ${weightModuleAddr}`);

  // ── Deploy 2 real CollectionVaults via the factory, wire WeightModule ────
  async function deployCollection(nft: any, label: string) {
    const nftAddr = await nft.getAddress();
    const vaultAddr = await factory.deployVault.staticCall(nftAddr, treasury.address, MINT_REDEEM_SINK_BPS);
    const tx = await factory.deployVault(nftAddr, treasury.address, MINT_REDEEM_SINK_BPS);
    await tx.wait();
    const vault: any = await ethers.getContractAt("CollectionVault", vaultAddr);
    await (await vault.connect(treasury).setWeightModule(weightModuleAddr)).wait();
    console.log(`   Collection ${label} vault deployed at ${vaultAddr}`);
    return { nft, nftAddr, vault, vaultAddr };
  }

  const collA = await deployCollection(nftA, "A");
  const collB = await deployCollection(nftB, "B");

  // ── STEP 3+4: Diamond pure-mode facet set + finalize + IndexCoinPool.
  //    deployIndexVault performs the atomic deploy-cut-finalize sequence
  //    (IndexDeployer) already proven by scripts/deploy-index-vault.ts. ────
  const Source = await ethers.getContractFactory("MockIndexPriceSource");
  const sourceA: any = await Source.deploy(ethers.parseEther("1"), ethers.parseEther("1"));
  const sourceB: any = await Source.deploy(ethers.parseEther("1"), ethers.parseEther("1"));

  const { vault: index, vaultAddr: indexAddr } = await deployIndexVault({
    name: "AXIOM-1 Index",
    symbol: "IDX",
    roles: [roleAdmin.address, admission.address, risk.address, allocation.address, admission.address],
    seeder: seeder.address,
    timelockDelay: TIMELOCK,
    params: paramsTuple(defaultParams),
    dividendAsset: collA.vaultAddr,
  });
  console.log(`3/4. Index diamond deployed and finalized at ${indexAddr}`);

  // ── STEP 5: InventoryStake — SKIPPED, see file header. CollectionVault's
  //    own share S is the compounding unit. ────────────────────────────────
  console.log(`5. InventoryStake step skipped (deleted in share-atom correction; S is the compounding unit).`);

  // ── STEP 6+7: Six real adapters, then the real EnergyBus at the predicted
  //    address. ──────────────────────────────────────────────────────────
  const clp: any = await (
    await ethers.getContractFactory("CollectionLpAdapter")
  )
    .connect(busDeployer)
    .deploy(wethAddr, predictedBus, weightModuleAddr);
  const idxBurn: any = await (
    await ethers.getContractFactory("IdxBurnAdapter")
  )
    .connect(busDeployer)
    .deploy(wethAddr, indexAddr, predictedBus);
  const plankBurn: any = await (
    await ethers.getContractFactory("PlankBurnAdapter")
  )
    .connect(busDeployer)
    .deploy(wethAddr, predictedBus, governance.address, TIMELOCK);
  const plankLp: any = await (
    await ethers.getContractFactory("PlankLpRenounceAdapter")
  )
    .connect(busDeployer)
    .deploy(wethAddr, predictedBus, governance.address, TIMELOCK);
  const div: any = await (
    await ethers.getContractFactory("DividendAdapter")
  )
    .connect(busDeployer)
    .deploy(wethAddr, indexAddr, predictedBus);
  const inv: any = await (
    await ethers.getContractFactory("InventoryBuyAdapter")
  )
    .connect(busDeployer)
    .deploy(wethAddr, indexAddr, predictedBus, weightModuleAddr);
  console.log(`6. Six adapters deployed: I=${await inv.getAddress()} L=${await clp.getAddress()} X=${await idxBurn.getAddress()} P=${await plankBurn.getAddress()} R=${await plankLp.getAddress()} D=${await div.getAddress()}`);

  const bus: any = await (
    await ethers.getContractFactory("EnergyBus")
  )
    .connect(busDeployer)
    .deploy(
      wethAddr,
      [
        await inv.getAddress(),
        await clp.getAddress(),
        await idxBurn.getAddress(),
        await plankBurn.getAddress(),
        await plankLp.getAddress(),
        await div.getAddress(),
      ],
      [INV_BPS, CLP_BPS, IDX_BURN_BPS, PLANK_BURN_BPS, PLANK_LP_BPS, DIV_BPS]
    );
  const busAddr = await bus.getAddress();
  if (busAddr !== predictedBus) {
    throw new Error(`Bus landed at ${busAddr}, predicted ${predictedBus} — nonce assumption broke.`);
  }
  console.log(`7. EnergyBus deployed at ${busAddr} (matches predicted address, factory.upstreamSink already points here)`);

  // ── Configure real PLANK routers pre-finalize (governed, timelocked) so
  //    Pipes P and R do real work in the smoke test, not just graceful
  //    skips. ─────────────────────────────────────────────────────────────
  await (await plankBurn.connect(governance).queueRouter(swapRouterAddr)).wait();
  await (await plankLp.connect(governance).queueConfig(swapRouterAddr, plankAddr, plankLpRouterAddr)).wait();
  await time.increase(TIMELOCK + 1);
  await (await plankBurn.executeRouter()).wait();
  await (await plankLp.executeConfig()).wait();
  console.log(`   Pipe P router + Pipe R config executed (real mock PLANK venue wired pre-finalize).`);

  // ── STEP 9: Wire onlyEnergyBus on the index, factory registry / noteFee
  //    auth already immutable from deployVault (upstreamSink set at
  //    construction, per CollectionVaultFactory's own design). ─────────────
  await (await index.connect(risk).queueEnergyBus(busAddr)).wait();
  await time.increase(TIMELOCK + 1);
  await (await index.executeEnergyBus()).wait();
  console.log(`9. index.energyBus() wired to ${await index.energyBus()}`);

  // ── STEP 10: Seed >=2 collections + pool liquidity + real deposits into
  //    the index (the corrected single-share-model's "xToken seed"). ──────
  async function seedCollection(c: typeof collA, source: any, tokenId1: number, tokenId2: number) {
    const tokenId3 = tokenId2 + 1000; // dedicated: minted, deposited, NEVER redeemed — this is the balance alice seeds the index with below
    await (await weth.mint(alice.address, ethers.parseEther("200"))).wait();
    await (await weth.connect(alice).approve(c.vaultAddr, ethers.MaxUint256)).wait();
    await (await c.nft.mint(alice.address, tokenId1)).wait();
    await (await c.nft.mint(alice.address, tokenId2)).wait();
    await (await c.nft.connect(alice).approve(c.vaultAddr, tokenId1)).wait();
    await (await c.nft.connect(alice).approve(c.vaultAddr, tokenId2)).wait();
    await (await c.vault.connect(alice).deposit(tokenId1)).wait(); // mints 1e18 S, real Stream A fee event
    
    const seedPayment = ethers.parseEther("2");
    await (await weth.mint(treasury.address, seedPayment)).wait();
    await (await weth.connect(treasury).approve(c.vaultAddr, seedPayment)).wait();
    await (await c.vault.connect(treasury).seedLiquidity(seedPayment)).wait();
    await (await c.vault.connect(alice).transfer(treasury.address, ethers.parseEther("1"))).wait();
    await (await c.vault.connect(treasury).seedShares(ethers.parseEther("1"))).wait();
    await (await c.vault.connect(treasury).openPool()).wait();
    
    // Cycle fee activity until this vault clears WeightModule's F_MIN_WEI
    // admit floor, then admit it (permissionless autogenesis, INT-3).
    let cumulativeSink = 0n;
    let cycles = 0;
    while (cumulativeSink < F_MIN_WEI && cycles < 60) {
      await (await c.nft.connect(alice).approve(c.vaultAddr, tokenId2)).wait();
      await (await c.vault.connect(alice).deposit(tokenId2)).wait();
      await (await c.vault.connect(alice).redeem(tokenId2)).wait();
      cycles += 1;
      cumulativeSink = (await weightModule.scores(c.vaultAddr)).feeWethCumulative;
    }
    await (await weightModule.checkAdmit(c.vaultAddr)).wait();

    // Real swap-fee activity (Stream B) via bob.
    await (await weth.mint(bob.address, ethers.parseEther("5"))).wait();
    await (await weth.connect(bob).approve(c.vaultAddr, ethers.MaxUint256)).wait();
    await (await c.vault.connect(bob).buyShares(ethers.parseEther("1"), 0n)).wait();
    const bobShares: bigint = await c.vault.balanceOf(bob.address);
    await (await c.vault.connect(bob).approve(c.vaultAddr, bobShares)).wait();
    await (await c.vault.connect(bob).sellShares(bobShares / 2n, 0n)).wait();

    // A real, un-redeemed deposit — this is the balance alice will seed the
    // index constituent with, below.
    await (await c.nft.mint(alice.address, tokenId3)).wait();
    await (await c.nft.connect(alice).approve(c.vaultAddr, tokenId3)).wait();
    await (await c.vault.connect(alice).deposit(tokenId3)).wait();
    
    return source;
  }

  await seedCollection(collA, sourceA, 1, 2);
  await seedCollection(collB, sourceB, 1, 2);

  await (await index.connect(seeder).seedConstituent(collA.vaultAddr, await sourceA.getAddress(), 6_000)).wait();
  await (await index.connect(seeder).seedConstituent(collB.vaultAddr, await sourceB.getAddress(), 4_000)).wait();

  for (const c of [collA, collB]) {
    const aliceBal: bigint = await c.vault.balanceOf(alice.address);
        const seedAmt = aliceBal / 4n;
    await (await c.vault.connect(alice).transfer(seeder.address, seedAmt)).wait();
    await (await c.vault.connect(seeder).approve(indexAddr, seedAmt)).wait();
    await (await index.connect(seeder).seedDeposit(c.vaultAddr, seedAmt)).wait();
  }
  await (await index.connect(seeder).openIndex(1_000n * 10n ** 18n)).wait();
  console.log(`10. Both collections admitted into weights + seeded into the index; index opened.`);

  const { vaults: wVaults, wBps } = await weightModule.weights();
  console.log(`    weights: ${wVaults.join(", ")} => ${wBps.join(", ")}`);

  // Real user mint into the opened index.
  for (const c of [collA, collB]) {
    const remaining: bigint = await c.vault.balanceOf(alice.address);
    await (await c.vault.connect(alice).approve(indexAddr, remaining)).wait();
  }
  await (await index.connect(alice).mintProRata(10n * 10n ** 18n, [ethers.MaxUint256, ethers.MaxUint256])).wait();
  console.log(`    Alice minted 10 IDX pro-rata against both constituents.`);

  // ── STEP 11: EnergyBus.finalize() ────────────────────────────────────────
  const finalizeTx = await bus.finalize();
  await finalizeTx.wait();
  txHashes.busFinalize = finalizeTx.hash;
  console.log(`11. bus.finalize() -> finalized=${await bus.finalized()}`);

  const result: Axiom1DeployResult = {
    weth: wethAddr,
    plank: plankAddr,
    factory: factoryAddr,
    weightModule: weightModuleAddr,
    index: indexAddr,
    bus: busAddr,
    adapters: {
      inv: await inv.getAddress(),
      clp: await clp.getAddress(),
      idxBurn: await idxBurn.getAddress(),
      plankBurn: await plankBurn.getAddress(),
      plankLp: await plankLp.getAddress(),
      div: await div.getAddress(),
    },
    collections: [
      { nft: collA.nftAddr, vault: collA.vaultAddr },
      { nft: collB.nftAddr, vault: collB.vaultAddr },
    ],
    finalized: await bus.finalized(),
    txHashes,
  };

  return result;
}

async function main() {
  const result = await deployAxiom1Local();
  mkdirSync("deploy-out", { recursive: true });
  const outPath = `deploy-out/axiom1.${hardhat.network.name}.json`;
  writeFileSync(outPath, JSON.stringify(result, null, 2));
  console.log(`\nWrote ${outPath}`);
  console.log(JSON.stringify(result, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
