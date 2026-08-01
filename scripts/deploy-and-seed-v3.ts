/**
 * Deploy + seed + open MarketplankVaultV3 on Robinhood Chain (mainnet 4663) or
 * its testnet, in one reviewed, self-verifying pass.
 *
 * This is the script the deploy workflow (.github/workflows/deploy-vault-v3.yml)
 * runs, and that a human operator can run locally against the testnet to
 * rehearse. It NEVER sees a private key in source — the key comes from the
 * `DEPLOYER_PK` env (hardhat.config.ts wires it into the robinhood networks) and
 * must control the treasury (only the treasury may seed/open).
 *
 * Flow (each step asserted before the next):
 *   1. deploy V3 with the immutable constructor args
 *   2. assert VAULT_VERSION()==3 and read back EVERY immutable == the input
 *   3. seed: setApprovalForAll -> depositMany(seedIds) -> seedShares{value}
 *   4. PRE-OPEN CHECKLIST (hard asserts) — the last safe point before the
 *      one-way openPool()
 *   5. openPool()  (ONE-WAY: locks the seed forever) — only if CONFIRM_OPEN=1
 *   6. assert poolOpen()==true
 *   7. write deploy-out/v3.json (address + immutables + seed state)
 *
 * Real, withdrawable depth is added SEPARATELY via addLiquidity() (optional here,
 * off by default) — a large addLiquidity should go through a private relay, not
 * a public CI log, so we don't automate it unless LIQ_ETH_WEI is set.
 *
 * Usage (testnet rehearsal):
 *   DEPLOYER_PK=0x... ROBINHOOD_TESTNET_RPC_URL=... ROBINHOOD_TESTNET_CHAIN_ID=... \
 *   MARKET_COLLECTION_ADDRESS=0x... MARKET_DRAND_BEACON_ADDRESS=0x... \
 *   MARKET_MINT_FEE_WEI=... MARKET_REDEEM_FEE_WEI=... MARKET_TARGET_PREMIUM_WEI=... MARKET_SWAP_FEE_BPS=... \
 *   MARKET_FEE_RECIPIENT=0x<treasury==deployer> SEED_TOKEN_IDS=1,2 SEED_ETH_WEI=... CONFIRM_OPEN=1 \
 *   npx hardhat run scripts/deploy-and-seed-v3.ts --network robinhood-testnet
 */
import hardhat from "hardhat";
import { writeFileSync, mkdirSync } from "node:fs";
const { ethers } = hardhat as unknown as { ethers: typeof import("ethers") & Record<string, unknown> };

const SHARE_UNIT = 10n ** 18n;
const DEFAULT_TREASURY = "0xcdb7ca36d35fa16d15fda859a46f1d72d979e9d8";
const V1_ADDRESS = "0xb2019Fd4cA24502e812C0C73b751Fa49979BF708";
const V2_ADDRESS = "0xc4B29D7a01603D2A5937b1FC86ea85E488d72e04";

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Set ${name} before deploying.`);
  return v;
}
function feeWei(name: string, def: bigint): bigint {
  return process.env[name] ? BigInt(process.env[name] as string) : def;
}
const eqAddr = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

async function main() {
  const [signer] = await ethers.getSigners();
  const signerAddr = await signer.getAddress();
  const net = await ethers.provider.getNetwork();
  const isMainnet = net.chainId === 4663n;

  const beaconAddr = req("MARKET_DRAND_BEACON_ADDRESS");
  const mintFeeWei = feeWei("MARKET_MINT_FEE_WEI", ethers.parseEther("0.001"));
  const redeemFeeWei = feeWei("MARKET_REDEEM_FEE_WEI", ethers.parseEther("0.001"));
  const targetPremiumWei = feeWei("MARKET_TARGET_PREMIUM_WEI", ethers.parseEther("0.002"));
  const swapFeeBps = process.env.MARKET_SWAP_FEE_BPS ? Number(process.env.MARKET_SWAP_FEE_BPS) : 30;

  const seedIds = (process.env.SEED_TOKEN_IDS || "").split(/[,\s]+/).filter(Boolean).map((s) => BigInt(s));
  const seedEthWei = process.env.SEED_ETH_WEI ? BigInt(process.env.SEED_ETH_WEI) : 0n;
  const deployOnly = process.env.DEPLOY_ONLY === "1";
  const confirmOpen = process.env.CONFIRM_OPEN === "1";

  // Collection: mainnet uses the real RobinWood NFT. The testnet rehearsal
  // self-provisions a mock ERC721 (the mainnet collection doesn't exist on
  // testnet) so the full deposit->seed->open flow is exercised end-to-end.
  let collectionAddr = process.env.MARKET_COLLECTION_ADDRESS || "";
  if (process.env.DEPLOY_MOCK_COLLECTION === "1") {
    if (isMainnet) throw new Error("DEPLOY_MOCK_COLLECTION refused on mainnet — use the real collection.");
    if (seedIds.length === 0) throw new Error("SEED_TOKEN_IDS is empty — needed to mint the mock seed NFTs.");
    console.log("Deploying a mock ERC721 collection for the testnet rehearsal…");
    const Mock = await ethers.getContractFactory("MockRobinWoodNftEnumerable");
    const mock = await Mock.deploy();
    await mock.waitForDeployment();
    collectionAddr = await mock.getAddress();
    for (const id of seedIds) await (await mock.mint(signerAddr, id)).wait();
    console.log(" mock collection :", collectionAddr, `(minted seed ids [${seedIds.join(",")}] to signer)`);
  }
  if (!collectionAddr) throw new Error("Set MARKET_COLLECTION_ADDRESS (or DEPLOY_MOCK_COLLECTION=1 on testnet).");

  // Treasury: mainnet defaults to the dedicated treasury (signer must equal it);
  // the testnet rehearsal defaults to the signer so it can seed/open freely.
  const treasury = process.env.MARKET_FEE_RECIPIENT || (isMainnet ? DEFAULT_TREASURY : signerAddr);

  console.log("── MarketplankVaultV3 deploy+seed ─────────────────────────────");
  console.log(" network chainId :", net.chainId.toString());
  console.log(" signer          :", signerAddr);
  console.log(" treasury        :", treasury);
  console.log(" collection      :", collectionAddr);
  console.log(" beacon          :", beaconAddr);
  console.log(" fees (wei)      : mint", mintFeeWei.toString(), "redeem", redeemFeeWei.toString(),
    "premium", targetPremiumWei.toString(), "swapBps", swapFeeBps);
  console.log(" seed            :", deployOnly ? "(deploy-only)" : `tokenIds [${seedIds.join(",")}] + ${ethers.formatEther(seedEthWei)} ETH`);

  // The signer MUST be the treasury — seedShares/openPool are treasury-gated.
  if (!deployOnly && !eqAddr(signerAddr, treasury)) {
    throw new Error(
      `Signer ${signerAddr} is not the treasury ${treasury}. Only the treasury can seed/open. ` +
        `Set DEPLOYER_PK to the treasury key, or MARKET_FEE_RECIPIENT to the signer.`
    );
  }

  // ── 1. deploy ────────────────────────────────────────────────────────────
  const Vault = await ethers.getContractFactory("MarketplankVaultV3");
  const vault = await Vault.deploy(
    collectionAddr, "Marketplank RobinWood Vault V3", "vROBIN",
    mintFeeWei, redeemFeeWei, targetPremiumWei, swapFeeBps, treasury, beaconAddr
  );
  await vault.waitForDeployment();
  const address = await vault.getAddress();
  console.log("\n deployed at     :", address);

  // ── 2. verify version + every immutable reads back == input ──────────────
  const version: bigint = await vault.VAULT_VERSION();
  if (version !== 3n) throw new Error(`VAULT_VERSION is ${version}, expected 3 — stale artifact.`);
  const checks: [string, boolean][] = [
    ["collection", eqAddr(await vault.collection(), collectionAddr)],
    ["treasury", eqAddr(await vault.treasury(), treasury)],
    ["beacon", eqAddr(await vault.beacon(), beaconAddr)],
    ["mintFeeWei", (await vault.mintFeeWei()) === mintFeeWei],
    ["redeemFeeWei", (await vault.redeemFeeWei()) === redeemFeeWei],
    ["targetPremiumWei", (await vault.targetPremiumWei()) === targetPremiumWei],
    ["swapFeeBps", (await vault.swapFeeBps()) === BigInt(swapFeeBps)],
  ];
  for (const [n, ok] of checks) if (!ok) throw new Error(`Immutable ${n} did not read back as configured.`);
  console.log(" verified        : VAULT_VERSION=3, all immutables match input ✓");

  if (deployOnly) {
    writeOut({ address, chainId: net.chainId, treasury, collectionAddr, beaconAddr, mintFeeWei, redeemFeeWei, targetPremiumWei, swapFeeBps, opened: false });
    console.log("\n DEPLOY_ONLY set — stopping before seed. Vault is CLOSED (not tradeable).");
    return;
  }

  // ── 3. seed ──────────────────────────────────────────────────────────────
  if (seedIds.length === 0) throw new Error("SEED_TOKEN_IDS is empty — need at least one NFT the treasury owns to seed.");
  const nft = await ethers.getContractAt("IERC721", collectionAddr);
  console.log("\n approving vault for seed NFTs…");
  await (await nft.setApprovalForAll(address, true)).wait();
  console.log(" depositMany(seed)…");
  await (await vault.depositMany(seedIds, { value: mintFeeWei * BigInt(seedIds.length) })).wait();
  const seedShares = SHARE_UNIT * BigInt(seedIds.length);
  console.log(` seedShares(${ethers.formatEther(seedShares)} sh, ${ethers.formatEther(seedEthWei)} ETH)…`);
  await (await vault.seedShares(seedShares, { value: seedEthWei })).wait();

  // ── 4. PRE-OPEN CHECKLIST (hard asserts — last safe point) ───────────────
  const held: bigint = await vault.heldTokenCount();
  const ethReserve: bigint = await vault.ethReserve();
  const shareReserve: bigint = await vault.shareReserve();
  const accrued: bigint = await vault.accruedFees();
  const bal: bigint = await ethers.provider.getBalance(address);
  const open: boolean = await vault.poolOpen();
  console.log("\n── PRE-OPEN CHECKLIST ─────────────────────────────────────────");
  const gate: [string, boolean][] = [
    [`heldTokenCount ${held} >= 1`, held >= 1n],
    [`ethReserve ${ethers.formatEther(ethReserve)} > 0`, ethReserve > 0n],
    [`shareReserve ${ethers.formatEther(shareReserve)} > 0`, shareReserve > 0n],
    [`balance == ethReserve + accruedFees (${ethers.formatEther(bal)} == ${ethers.formatEther(ethReserve + accrued)})`, bal === ethReserve + accrued],
    [`poolOpen == false`, open === false],
    [`collection() correct`, eqAddr(await vault.collection(), collectionAddr)],
    [`treasury() correct`, eqAddr(await vault.treasury(), treasury)],
  ];
  for (const [label, ok] of gate) { console.log(`  ${ok ? "✓" : "✗"} ${label}`); if (!ok) throw new Error(`Pre-open checklist FAILED: ${label}`); }

  // ── 5. openPool — ONE-WAY ────────────────────────────────────────────────
  if (!confirmOpen) {
    writeOut({ address, chainId: net.chainId, treasury, collectionAddr, beaconAddr, mintFeeWei, redeemFeeWei, targetPremiumWei, swapFeeBps, opened: false });
    console.log("\n Seeded + checklist GREEN, but CONFIRM_OPEN != 1 — NOT opening the pool.");
    console.log(" openPool() is ONE-WAY and locks the seed forever. Re-run with CONFIRM_OPEN=1 to finalize.");
    console.log(" (Note: re-running redeploys a NEW vault; only set CONFIRM_OPEN=1 when you mean it.)");
    return;
  }
  console.log("\n openPool() — ONE-WAY, locking the seed forever…");
  await (await vault.openPool()).wait();
  if ((await vault.poolOpen()) !== true) throw new Error("openPool() did not set poolOpen — aborting.");
  console.log(" pool OPEN ✓ · sqrt(E*S) LP locked at address(0) (no-rug)");

  // ── 6. optional real depth (off unless LIQ_ETH_WEI set) ──────────────────
  if (process.env.LIQ_ETH_WEI) {
    const liqEth = BigInt(process.env.LIQ_ETH_WEI);
    const maxShares = process.env.LIQ_MAX_SHARES_WEI ? BigInt(process.env.LIQ_MAX_SHARES_WEI) : ethers.MaxUint256;
    console.log(`\n addLiquidity(${ethers.formatEther(liqEth)} ETH)… (consider a private relay for large depth)`);
    await (await vault.addLiquidity(maxShares, 0, { value: liqEth })).wait();
  }

  // ── 7. artifact ──────────────────────────────────────────────────────────
  writeOut({ address, chainId: net.chainId, treasury, collectionAddr, beaconAddr, mintFeeWei, redeemFeeWei, targetPremiumWei, swapFeeBps, opened: true });

  console.log("\n=== Client env (V3 primary; V1 AND V2 stay as redeem-only legacies) ===");
  console.log("  NEXT_PUBLIC_MARKET_VAULT_ADDRESS =", address);
  console.log("  NEXT_PUBLIC_MARKET_VAULT_LEGACY_ADDRESSES =", `${V1_ADDRESS},${V2_ADDRESS}`);
  console.log("  → the workflow sets these repo Variables; then trigger the inmotion rebuild.");
}

function writeOut(o: {
  address: string; chainId: bigint; treasury: string; collectionAddr: string; beaconAddr: string;
  mintFeeWei: bigint; redeemFeeWei: bigint; targetPremiumWei: bigint; swapFeeBps: number; opened: boolean;
}) {
  mkdirSync("deploy-out", { recursive: true });
  const json = {
    vaultAddress: o.address,
    chainId: o.chainId.toString(),
    treasury: o.treasury,
    collection: o.collectionAddr,
    beacon: o.beaconAddr,
    mintFeeWei: o.mintFeeWei.toString(),
    redeemFeeWei: o.redeemFeeWei.toString(),
    targetPremiumWei: o.targetPremiumWei.toString(),
    swapFeeBps: o.swapFeeBps,
    opened: o.opened,
    legacyAddresses: `${V1_ADDRESS},${V2_ADDRESS}`,
  };
  writeFileSync("deploy-out/v3.json", JSON.stringify(json, null, 2));
  console.log("\n wrote deploy-out/v3.json");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
