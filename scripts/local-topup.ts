/**
 * LOCAL-ONLY top-up. Adds fresh positions to an ALREADY-DEPLOYED dev stack
 * (from scripts/local-v3-setup.ts) so you can run a full end-to-end test —
 * WITHOUT redeploying, so your .env.local addresses and wallet state stay put.
 *
 * It funds the connected wallet (PLAYER_ADDRESS) with:
 *   - ETH to pay gas
 *   - planks in your WALLET (to deposit / list / play with)
 *   - Premium Plank Liquidity (V3), Driftwood (V1) and WormWood (V2) shares
 * and mints extra planks INTO each vault so there's always something to
 * redeem / shop under the floorboards.
 *
 * Usage (Hardhat node from local-v3-setup already running):
 *   PLAYER_ADDRESS=0xYourRabbyAddress npx hardhat run scripts/local-topup.ts --network localhost
 *
 * Vault/NFT addresses default to the current .env.local values but can be
 * overridden with the same NEXT_PUBLIC_* env vars. NEVER used against real value.
 */
import hardhat from "hardhat";
const { ethers } = hardhat as unknown as { ethers: typeof import("ethers") & Record<string, unknown> };

const E = (n: string) => ethers.parseEther(n);

// Current dev-stack addresses (from .env.local); override via env if you redeploy.
const V3_ADDR = process.env.NEXT_PUBLIC_MARKET_VAULT_ADDRESS || "0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0";
const V1_ADDR = process.env.NEXT_PUBLIC_MARKET_VAULT_V1_KNOWN || "0x70e0bA845a1A0F2DA3359C97E0285013525FFC49";
const V2_ADDR = process.env.NEXT_PUBLIC_MARKET_VAULT_V2_KNOWN || "0x4826533B4897376654Bb4d4AD88B7faFD0C98528";
const NFT_ADDR = process.env.NEXT_PUBLIC_NFT_CONTRACT_ADDRESS || "0x5FbDB2315678afecb367f032d93F642f64180aa3";

// High, collision-proof id ranges (setup used 1–40, player 25–30). Re-runnable:
// each run bumps the base by 100 via a block-derived offset so ids never clash.
async function main() {
  const player = process.env.PLAYER_ADDRESS;
  if (!player || !/^0x[0-9a-fA-F]{40}$/.test(player)) {
    throw new Error("Set PLAYER_ADDRESS=0x... (your Rabby address) before running.");
  }

  const [deployer] = await ethers.getSigners();
  const nft = await ethers.getContractAt("MockRobinWoodNftEnumerable", NFT_ADDR);
  const v3 = await ethers.getContractAt("MarketplankVaultV3", V3_ADDR);
  const v1 = await ethers.getContractAt("MarketplankVault", V1_ADDR);
  const v2 = await ethers.getContractAt("MarketplankVault", V2_ADDR);

  // Unique id base per run: 1000 + (blockNumber * 100) leaves wide gaps.
  const blockNo = await ethers.provider.getBlockNumber();
  const base = 1000 + blockNo * 100;
  const walletIds = [base + 0, base + 1, base + 2, base + 3];      // 4 planks → your wallet
  const v3Ids = [base + 10, base + 11, base + 12, base + 13, base + 14]; // 5 → V3 held
  const v1Ids = [base + 20, base + 21, base + 22, base + 23, base + 24]; // 5 → V1 held
  const v2Ids = [base + 30, base + 31, base + 32, base + 33, base + 34]; // 5 → V2 held

  console.log("Top-up base id:", base, "· player:", player);

  // ── ETH for gas ──────────────────────────────────────────────────────────
  await (await deployer.sendTransaction({ to: player, value: E("50") })).wait();

  // ── planks straight to your WALLET (to deposit / list / trade) ────────────
  for (const id of walletIds) await (await nft.mint(player, id)).wait();

  // ── approvals for the deployer to deposit into all three pools ────────────
  await (await nft.setApprovalForAll(V3_ADDR, true)).wait();
  await (await nft.setApprovalForAll(V1_ADDR, true)).wait();
  await (await nft.setApprovalForAll(V2_ADDR, true)).wait();

  // ── Premium Plank Liquidity (V3): mint → depositMany → hand you 3 shares ──
  for (const id of v3Ids) await (await nft.mint(deployer.address, id)).wait();
  const mintFee: bigint = await v3.mintFeeWei();
  await (await v3.depositMany(v3Ids, { value: mintFee * BigInt(v3Ids.length) })).wait();
  await (await v3.transfer(player, E("3"))).wait(); // 3 V3 shares to redeem/LP/trade

  // ── Driftwood (V1) share-model: deposit → hand you 3 shares ───────────────
  for (const id of v1Ids) await (await nft.mint(deployer.address, id)).wait();
  for (const id of v1Ids) await (await v1.deposit(id)).wait();
  await (await v1.transfer(player, E("3"))).wait(); // 3 Driftwood shares

  // ── WormWood (V2) share-model: deposit → hand you 3 shares ────────────────
  for (const id of v2Ids) await (await nft.mint(deployer.address, id)).wait();
  for (const id of v2Ids) await (await v2.deposit(id)).wait();
  await (await v2.transfer(player, E("3"))).wait(); // 3 WormWood shares

  // ── report ────────────────────────────────────────────────────────────────
  const [p3, p1, p2] = await Promise.all([
    v3.balanceOf(player) as Promise<bigint>,
    v1.balanceOf(player) as Promise<bigint>,
    v2.balanceOf(player) as Promise<bigint>,
  ]);
  const [h3, h1, h2] = await Promise.all([
    v3.heldTokenCount() as Promise<bigint>,
    v1.heldTokenCount() as Promise<bigint>,
    v2.heldTokenCount() as Promise<bigint>,
  ]);

  console.log("\n=========================================================");
  console.log(" Topped up", player);
  console.log("=========================================================");
  console.log(" Wallet planks minted:", walletIds.join(", "), "(deposit / list these)");
  console.log(" Your shares  → Premium Plank Liquidity:", ethers.formatEther(p3),
    "· Driftwood:", ethers.formatEther(p1), "· WormWood:", ethers.formatEther(p2));
  console.log(" Vault holdings → Premium Plank Liquidity:", h3.toString(),
    "· Driftwood:", h1.toString(), "· WormWood:", h2.toString(), "planks (to redeem / shop)");
  console.log(" + 50 ETH for gas. Reload the app — no .env change, no restart needed.");
  console.log("=========================================================\n");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
