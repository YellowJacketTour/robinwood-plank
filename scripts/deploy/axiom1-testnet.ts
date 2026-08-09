/**
 * ============================================================================
 *  axiom1-testnet — PR12 (ONESHOT §9 deploy ceremony, real-network variant).
 *
 *  THE SAME 12-STEP CEREMONY `scripts/deploy/axiom1-local.ts` (PR10) already
 *  proved against local Hardhat, parameterized for a real network: instead
 *  of deploying `MockWeth` / `MockRobinWoodNft` / `MockExternalSwapRouter` /
 *  `MockExternalPlankLpRouter`, this script ATTACHES to real, already-
 *  deployed contracts at addresses supplied via env vars, following the same
 *  "one place a real deployer reads before touching testnet or mainnet"
 *  doctrine as `scripts/config/index-vault-deploy-config.ts` (reqAddr/
 *  optAddr, required-in-non-hardhat env vars, no silent production
 *  defaults).
 *
 *  WHAT IS DIFFERENT FROM axiom1-local.ts, AND WHY:
 *
 *   1. WETH / PLANK token / PLANK swap router / PLANK LP router / both NFT
 *      collections are READ from env (`WETH_ADDRESS`, `PLANK_TOKEN_ADDRESS`,
 *      `PLANK_SWAP_ROUTER_ADDRESS`, `PLANK_LP_ROUTER_ADDRESS`,
 *      `NFT_COLLECTION_A_ADDRESS`, `NFT_COLLECTION_B_ADDRESS`) rather than
 *      deployed as mocks. This script never deploys a token or an NFT
 *      collection — those are pre-existing real assets on the target chain.
 *
 *   2. The predicted-Bus-address trick (same one PR8's
 *      `FactorySinkBusIntegration.test.ts` and axiom1-local.ts both use) is
 *      driven by a DEDICATED signer built from `AXIOM1_BUS_DEPLOYER_PK`,
 *      exactly mirroring axiom1-local.ts's own dedicated `busDeployer`
 *      hardhat signer — on a real chain a fresh wallet doesn't reliably
 *      start at nonce 0, so its CURRENT nonce is read from the provider
 *      right before the 6 adapter deploys + the Bus deploy (7 sequential
 *      txs from the same key, same ordering as axiom1-local.ts), and the
 *      Bus address is predicted from that.
 *
 *   3. Every role that must SIGN a ceremony transaction (treasury-side vault
 *      ops, `risk`'s `queueEnergyBus`, `seeder`'s `seedConstituent` /
 *      `seedDeposit` / `openIndex`, `governance`'s `queueRouter` /
 *      `queueConfig`, and the real NFT/WETH deposit + swap activity used to
 *      admit + seed each collection) is played by the ONE deploying key
 *      (`DEPLOYER_PK`, same convention `hardhat.config.ts`'s
 *      `robinhoodNetworks()` already uses) — a single-operator ceremony, on
 *      purpose, matching the fact that this script has exactly one signer
 *      available on a real network unless a second key is explicitly wired
 *      in (as `AXIOM1_BUS_DEPLOYER_PK` is, for the nonce-prediction reason
 *      above). Redistributing `risk` / `seeder` / `treasury` / `governance`
 *      to separate real multisigs after the ceremony completes is a
 *      deliberate, separate, out-of-scope follow-up — every one of those
 *      roles has its own on-chain transfer/handoff path already, this
 *      script does not reimplement one. Non-signing, store-only roles
 *      (`roleAdmin`, `admission`, `allocation`) ARE independently
 *      configurable via env (`MARKET_INDEX_ROLE_ADMIN`,
 *      `MARKET_INDEX_ROLE_ADMISSION`, `MARKET_INDEX_ROLE_ALLOCATION`) since
 *      nothing in this script needs to sign as them.
 *
 *   4. Real seeding (ONESHOT §9 step 10) requires the deploying key to
 *      ALREADY hold real WETH balance and real NFTs on both collections
 *      before this script runs — there is no mock `.mint()` on a real
 *      token/collection. Token IDs the deployer owns are read from
 *      `AXIOM1_COLLECTION_A_TOKEN_IDS` / `AXIOM1_COLLECTION_B_TOKEN_IDS`
 *      (JSON arrays of >=3 uints each). `AXIOM1_DRY_RUN=1` (only ever set
 *      by this repo's own local proof run — see the bottom of this file's
 *      header) swaps in the exact same mock deploys axiom1-local.ts uses
 *      and mints/funds the deployer from them, so the wiring logic above
 *      can be exercised end-to-end against local Hardhat without a real
 *      network. This is how PR12 was proven: never by running this file
 *      against a real `--network`.
 *
 *  THIS FILE HAS NEVER BEEN EXECUTED AGAINST A REAL NETWORK. It has been
 *  compiled, type-checked, and dry-run against local Hardhat with
 *  `AXIOM1_DRY_RUN=1` (mock addresses standing in for the env vars above) to
 *  prove the wiring logic itself — see docs/BULLISH-AXIOM1-RUNBOOK.md.
 *
 *  Usage (REAL network — requires DEPLOYER_PK, the network's RPC url, and
 *  every env var below to be set; do not run this without explicit owner
 *  authorization):
 *    WETH_ADDRESS=0x.. PLANK_TOKEN_ADDRESS=0x.. PLANK_SWAP_ROUTER_ADDRESS=0x.. \
 *    PLANK_LP_ROUTER_ADDRESS=0x.. NFT_COLLECTION_A_ADDRESS=0x.. \
 *    NFT_COLLECTION_B_ADDRESS=0x.. AXIOM1_BUS_DEPLOYER_PK=0x.. \
 *    MARKET_INDEX_ROLE_ADMIN=0x.. MARKET_INDEX_ROLE_ADMISSION=0x.. \
 *    MARKET_INDEX_ROLE_ALLOCATION=0x.. AXIOM1_PRICE_SOURCE_A_ADDRESS=0x.. \
 *    AXIOM1_PRICE_SOURCE_B_ADDRESS=0x.. \
 *    AXIOM1_COLLECTION_A_TOKEN_IDS='[101,102,103]' \
 *    AXIOM1_COLLECTION_B_TOKEN_IDS='[201,202,203]' \
 *    DEPLOYER_PK=0x... ROBINHOOD_TESTNET_RPC_URL=... ROBINHOOD_TESTNET_CHAIN_ID=... \
 *    npx hardhat run scripts/deploy/axiom1-testnet.ts --network robinhood-testnet
 *
 *  Local dry-run proof (what THIS PR actually ran):
 *    AXIOM1_DRY_RUN=1 npx hardhat run scripts/deploy/axiom1-testnet.ts --network hardhat
 * ============================================================================
 */
import hardhat from "hardhat";
import { writeFileSync, mkdirSync } from "node:fs";
import { ethers as ethersLib, Wallet } from "ethers";

const { ethers } = hardhat;

// Reused, not reimplemented — same doctrine as scripts/deploy-index-vault.ts.
import { time } from "@nomicfoundation/hardhat-network-helpers";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { deployIndexVault, TIMELOCK, paramsTuple, defaultParams } =
  require("../../test/contracts/helpers/index-vault") as typeof import("../../test/contracts/helpers/index-vault");

const INV_BPS = 3_500n;
const CLP_BPS = 1_500n;
const IDX_BURN_BPS = 1_500n;
const PLANK_BURN_BPS = 1_000n;
const PLANK_LP_BPS = 1_000n;
const DIV_BPS = 1_500n;
const F_MIN_WEI = ethers.parseEther("0.05");

// ── Env helpers — same pattern as scripts/config/index-vault-deploy-config.ts
function reqAddr(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Set ${name} (address) before running this script against a real network.`);
  if (!/^0x[0-9a-fA-F]{40}$/.test(v)) throw new Error(`${name} is not a valid address: ${v}`);
  return v;
}
function optUint(name: string, def: bigint): bigint {
  const v = process.env[name];
  if (v === undefined || v === "") return def;
  return BigInt(v);
}
function reqTokenIds(name: string): number[] {
  const v = process.env[name];
  if (!v) throw new Error(`Set ${name} to a JSON array of >=3 token ids the deployer already owns on that collection.`);
  const parsed = JSON.parse(v);
  if (!Array.isArray(parsed) || parsed.length < 3) throw new Error(`${name} must be a JSON array of >=3 token ids.`);
  return parsed.map((x) => Number(x));
}

export interface Axiom1TestnetDeployResult {
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

export async function deployAxiom1Testnet(): Promise<Axiom1TestnetDeployResult> {
  const isDryRun = process.env.AXIOM1_DRY_RUN === "1";
  if (!isDryRun && hardhat.network.name !== "hardhat" && hardhat.network.name !== "localhost") {
    console.log(`Deploying AXIOM-1 stack to REAL network "${hardhat.network.name}"...`);
  } else {
    console.log(
      `Deploying AXIOM-1 stack to network "${hardhat.network.name}" (AXIOM1_DRY_RUN=${isDryRun ? "1" : "unset"})...`
    );
  }

  const [deployer, ...rest] = await ethers.getSigners();
  const txHashes: Record<string, string> = {};

  // ── STEP 1: real WETH / NFTs / PLANK venue, OR (dry-run only) the exact
  //    same mocks axiom1-local.ts deploys, so the wiring below can be
  //    exercised without a real network. ────────────────────────────────
  let wethAddr: string;
  let plankAddr: string;
  let swapRouterAddr: string;
  let plankLpRouterAddr: string;
  let nftAAddr: string;
  let nftBAddr: string;
  let mintRedeemSinkBps = Number(optUint("AXIOM1_MINT_REDEEM_SINK_BPS", 3_000n));

  if (isDryRun) {
    const weth: any = await (await ethers.getContractFactory("MockWeth")).deploy();
    wethAddr = await weth.getAddress();
    const nftA: any = await (await ethers.getContractFactory("MockRobinWoodNft")).deploy();
    const nftB: any = await (await ethers.getContractFactory("MockRobinWoodNft")).deploy();
    nftAAddr = await nftA.getAddress();
    nftBAddr = await nftB.getAddress();
    const swapRouter: any = await (
      await ethers.getContractFactory("MockExternalSwapRouter")
    ).deploy(ethers.parseEther("1"));
    swapRouterAddr = await swapRouter.getAddress();
    plankAddr = await swapRouter.plank();
    const plankLpRouter: any = await (
      await ethers.getContractFactory("MockExternalPlankLpRouter")
    ).deploy(plankAddr, wethAddr);
    plankLpRouterAddr = await plankLpRouter.getAddress();
    console.log(`1. [DRY RUN] mock WETH=${wethAddr} nftA=${nftAAddr} nftB=${nftBAddr} PLANK=${plankAddr}`);
  } else {
    wethAddr = reqAddr("WETH_ADDRESS");
    plankAddr = reqAddr("PLANK_TOKEN_ADDRESS");
    swapRouterAddr = reqAddr("PLANK_SWAP_ROUTER_ADDRESS");
    plankLpRouterAddr = reqAddr("PLANK_LP_ROUTER_ADDRESS");
    nftAAddr = reqAddr("NFT_COLLECTION_A_ADDRESS");
    nftBAddr = reqAddr("NFT_COLLECTION_B_ADDRESS");
    console.log(`1. Real venue: WETH=${wethAddr} PLANK=${plankAddr} nftA=${nftAAddr} nftB=${nftBAddr}`);
  }

  const weth: any = await ethers.getContractAt(isDryRun ? "MockWeth" : "IERC20", wethAddr);
  const nftA: any = await ethers.getContractAt(isDryRun ? "MockRobinWoodNft" : "IERC721", nftAAddr);
  const nftB: any = await ethers.getContractAt(isDryRun ? "MockRobinWoodNft" : "IERC721", nftBAddr);

  // ── Dedicated bus-deployer key, exactly mirroring axiom1-local.ts's
  //    dedicated `busDeployer` hardhat signer — used for ONLY the 6 adapter
  //    deploys + the Bus deploy, in that fixed order, so the CREATE-nonce
  //    prediction below is exact regardless of how many other txs `deployer`
  //    sends before/after. On dry run, reuse a spare hardhat signer instead
  //    of requiring the env var. ─────────────────────────────────────────
  function reqPk(name: string): string {
    const v = process.env[name];
    if (!v) throw new Error(`Set ${name} (private key) before running this script against a real network.`);
    return v.startsWith("0x") ? v : `0x${v}`;
  }
  const busDeployer: any = isDryRun ? rest[rest.length - 1] : new Wallet(reqPk("AXIOM1_BUS_DEPLOYER_PK"), ethers.provider as any);
  const busDeployerAddr: string = await busDeployer.getAddress();
  const startNonce = await ethers.provider.getTransactionCount(busDeployerAddr);
  const predictedBus = ethersLib.getCreateAddress({ from: busDeployerAddr, nonce: startNonce + 6 });
  console.log(`   busDeployer=${busDeployerAddr} startNonce=${startNonce} predicted EnergyBus=${predictedBus}`);

  // ── STEP 2/8: Factory + WeightModule (deployer signs, matching
  //    axiom1-local.ts's ordering: factory before adapters/bus). ──────────
  const factory: any = await (
    await ethers.getContractFactory("CollectionVaultFactory")
  ).deploy(predictedBus, wethAddr, TIMELOCK);
  const factoryAddr = await factory.getAddress();
  console.log(`8. CollectionVaultFactory deployed at ${factoryAddr} (upstreamSink=${predictedBus})`);

  const weightModule: any = await (await ethers.getContractFactory("WeightModule")).deploy(factoryAddr);
  const weightModuleAddr = await weightModule.getAddress();
  console.log(`2. WeightModule deployed at ${weightModuleAddr}`);

  // Single-operator ceremony (see file header §3): the deploying key plays
  // treasury/risk/seeder/governance/depositor for this automated pass.
  const treasury = deployer;
  const risk = deployer;
  const seeder = deployer;
  const governance = deployer;
  const depositor = deployer;

  async function deployCollection(nft: any, label: string) {
    const nftAddr = await nft.getAddress();
    const vaultAddr = await factory.deployVault.staticCall(nftAddr, treasury.address, mintRedeemSinkBps);
    const tx = await factory.deployVault(nftAddr, treasury.address, mintRedeemSinkBps);
    await tx.wait();
    const vault: any = await ethers.getContractAt("CollectionVault", vaultAddr);
    await (await vault.connect(treasury).setWeightModule(weightModuleAddr)).wait();
    console.log(`   Collection ${label} vault deployed at ${vaultAddr}`);
    return { nft, nftAddr, vault, vaultAddr };
  }

  const collA = await deployCollection(nftA, "A");
  const collB = await deployCollection(nftB, "B");

  // ── STEP 3+4: Index diamond, deploy-cut-finalize (IndexDeployer). dividendAsset
  //    is collA's real vault — cannot be known before collA is deployed above,
  //    same as axiom1-local.ts. Real oracle price sources come from env
  //    (AXIOM1_PRICE_SOURCE_*_ADDRESS) — this script never deploys a price
  //    oracle. ─────────────────────────────────────────────────────────────
  let sourceAAddr: string;
  let sourceBAddr: string;
  if (isDryRun) {
    const Source = await ethers.getContractFactory("MockIndexPriceSource");
    const sourceA: any = await Source.deploy(ethers.parseEther("1"), ethers.parseEther("1"));
    const sourceB: any = await Source.deploy(ethers.parseEther("1"), ethers.parseEther("1"));
    sourceAAddr = await sourceA.getAddress();
    sourceBAddr = await sourceB.getAddress();
  } else {
    sourceAAddr = reqAddr("AXIOM1_PRICE_SOURCE_A_ADDRESS");
    sourceBAddr = reqAddr("AXIOM1_PRICE_SOURCE_B_ADDRESS");
  }

  const roleAdmin = isDryRun ? deployer.address : reqAddr("MARKET_INDEX_ROLE_ADMIN");
  const admission = isDryRun ? deployer.address : reqAddr("MARKET_INDEX_ROLE_ADMISSION");
  const allocation = isDryRun ? deployer.address : reqAddr("MARKET_INDEX_ROLE_ALLOCATION");

  const { vault: index, vaultAddr: indexAddr } = await deployIndexVault({
    name: process.env.MARKET_INDEX_NAME || "AXIOM-1 Index",
    symbol: process.env.MARKET_INDEX_SYMBOL || "IDX",
    roles: [roleAdmin, admission, risk.address, allocation, admission],
    seeder: seeder.address,
    timelockDelay: optUint("MARKET_INDEX_TIMELOCK_DELAY", BigInt(TIMELOCK)),
    params: paramsTuple(defaultParams),
    dividendAsset: collA.vaultAddr,
  });
  console.log(`3/4. Index diamond deployed and finalized at ${indexAddr}`);

  console.log(`5. InventoryStake step skipped (deleted in share-atom correction; S is the compounding unit).`);

  // ── STEP 6+7: Six real adapters + the real EnergyBus, all signed by the
  //    dedicated busDeployer key at its predicted nonce sequence. ─────────
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
  console.log(
    `6. Six adapters deployed: I=${await inv.getAddress()} L=${await clp.getAddress()} X=${await idxBurn.getAddress()} P=${await plankBurn.getAddress()} R=${await plankLp.getAddress()} D=${await div.getAddress()}`
  );

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
  console.log(`7. EnergyBus deployed at ${busAddr} (matches predicted address)`);

  await (await plankBurn.connect(governance).queueRouter(swapRouterAddr)).wait();
  await (await plankLp.connect(governance).queueConfig(swapRouterAddr, plankAddr, plankLpRouterAddr)).wait();
  if (isDryRun) {
    await time.increase(TIMELOCK + 1);
  } else {
    console.log(
      `   Timelock queued — Pipe P/R execute*() below will revert until ${TIMELOCK}s have really elapsed; on a real network this script must be re-run (or the execute*() calls issued separately) after that real delay.`
    );
  }
  await (await plankBurn.executeRouter()).wait();
  await (await plankLp.executeConfig()).wait();
  console.log(`   Pipe P router + Pipe R config executed.`);

  await (await index.connect(risk).queueEnergyBus(busAddr)).wait();
  if (isDryRun) await time.increase(TIMELOCK + 1);
  await (await index.executeEnergyBus()).wait();
  console.log(`9. index.energyBus() wired to ${await index.energyBus()}`);

  // ── STEP 10: seed >=2 collections using REAL assets the deployer already
  //    holds (dry run mints its own via the mocks above). ─────────────────
  async function seedCollection(c: typeof collA, tokenIds: number[]) {
    const [tokenId1, tokenId2, tokenId3] = tokenIds;
    if (isDryRun) {
      await (await weth.mint(depositor.address, ethers.parseEther("200"))).wait();
      await (await c.nft.mint(depositor.address, tokenId1)).wait();
      await (await c.nft.mint(depositor.address, tokenId2)).wait();
    }
    await (await weth.connect(depositor).approve(c.vaultAddr, ethers.MaxUint256)).wait();
    await (await c.nft.connect(depositor).approve(c.vaultAddr, tokenId1)).wait();
    await (await c.nft.connect(depositor).approve(c.vaultAddr, tokenId2)).wait();
    await (await c.vault.connect(depositor).deposit(tokenId1)).wait();

    const seedPayment = ethers.parseEther("2");
    if (isDryRun) await (await weth.mint(treasury.address, seedPayment)).wait();
    await (await weth.connect(treasury).approve(c.vaultAddr, seedPayment)).wait();
    await (await c.vault.connect(treasury).seedLiquidity(seedPayment)).wait();
    await (await c.vault.connect(depositor).transfer(treasury.address, ethers.parseEther("1"))).wait();
    await (await c.vault.connect(treasury).seedShares(ethers.parseEther("1"))).wait();
    await (await c.vault.connect(treasury).openPool()).wait();

    // Single-operator ceremony: treasury === depositor here (see file
    // header §3), so treasury's `seedLiquidity` approve() above overwrote
    // (rather than added to) depositor's earlier MaxUint256 approval —
    // re-approve before the fee-cycling loop below pulls more fees.
    await (await weth.connect(depositor).approve(c.vaultAddr, ethers.MaxUint256)).wait();

    let cumulativeSink = 0n;
    let cycles = 0;
    while (cumulativeSink < F_MIN_WEI && cycles < 60) {
      await (await c.nft.connect(depositor).approve(c.vaultAddr, tokenId2)).wait();
      await (await c.vault.connect(depositor).deposit(tokenId2)).wait();
      await (await c.vault.connect(depositor).redeem(tokenId2)).wait();
      cycles += 1;
      cumulativeSink = (await weightModule.scores(c.vaultAddr)).feeWethCumulative;
    }
    await (await weightModule.checkAdmit(c.vaultAddr)).wait();

    if (isDryRun) await (await weth.mint(depositor.address, ethers.parseEther("5"))).wait();
    await (await weth.connect(depositor).approve(c.vaultAddr, ethers.MaxUint256)).wait();
    await (await c.vault.connect(depositor).buyShares(ethers.parseEther("1"), 0n)).wait();
    const depositorShares: bigint = await c.vault.balanceOf(depositor.address);
    await (await c.vault.connect(depositor).approve(c.vaultAddr, depositorShares)).wait();
    await (await c.vault.connect(depositor).sellShares(depositorShares / 2n, 0n)).wait();

    if (isDryRun) await (await c.nft.mint(depositor.address, tokenId3)).wait();
    await (await c.nft.connect(depositor).approve(c.vaultAddr, tokenId3)).wait();
    await (await c.vault.connect(depositor).deposit(tokenId3)).wait();
  }

  const tokenIdsA = isDryRun ? [1, 2, 1002] : reqTokenIds("AXIOM1_COLLECTION_A_TOKEN_IDS");
  const tokenIdsB = isDryRun ? [1, 2, 1002] : reqTokenIds("AXIOM1_COLLECTION_B_TOKEN_IDS");
  await seedCollection(collA, tokenIdsA);
  await seedCollection(collB, tokenIdsB);

  await (await index.connect(seeder).seedConstituent(collA.vaultAddr, sourceAAddr, 6_000)).wait();
  await (await index.connect(seeder).seedConstituent(collB.vaultAddr, sourceBAddr, 4_000)).wait();

  for (const c of [collA, collB]) {
    const depositorBal: bigint = await c.vault.balanceOf(depositor.address);
    const seedAmt = depositorBal / 4n;
    await (await c.vault.connect(depositor).transfer(seeder.address, seedAmt)).wait();
    await (await c.vault.connect(seeder).approve(indexAddr, seedAmt)).wait();
    await (await index.connect(seeder).seedDeposit(c.vaultAddr, seedAmt)).wait();
  }
  await (await index.connect(seeder).openIndex(1_000n * 10n ** 18n)).wait();
  console.log(`10. Both collections admitted into weights + seeded into the index; index opened.`);

  const { vaults: wVaults, wBps } = await weightModule.weights();
  console.log(`    weights: ${wVaults.join(", ")} => ${wBps.join(", ")}`);

  for (const c of [collA, collB]) {
    const remaining: bigint = await c.vault.balanceOf(depositor.address);
    await (await c.vault.connect(depositor).approve(indexAddr, remaining)).wait();
  }
  await (await index.connect(depositor).mintProRata(10n * 10n ** 18n, [ethers.MaxUint256, ethers.MaxUint256])).wait();
  console.log(`    Depositor minted 10 IDX pro-rata against both constituents.`);

  // ── STEP 11: EnergyBus.finalize() ────────────────────────────────────────
  const finalizeTx = await bus.finalize();
  await finalizeTx.wait();
  txHashes.busFinalize = finalizeTx.hash;
  console.log(`11. bus.finalize() -> finalized=${await bus.finalized()}`);

  const result: Axiom1TestnetDeployResult = {
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
  const result = await deployAxiom1Testnet();
  mkdirSync("deploy-out", { recursive: true });
  const outPath = `deploy-out/axiom1.${hardhat.network.name}.json`;
  writeFileSync(outPath, JSON.stringify(result, null, 2));
  console.log(`\nWrote ${outPath}`);
  console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
