/**
 * LOCAL-ONLY V3 dev stack. Deploys a mock RobinWood NFT + a mock drand beacon +
 * MarketplankVaultV3 to a running Hardhat node, seeds and opens a real pool, and
 * mints planks to the first few accounts so the frontend can be exercised
 * end-to-end without any mainnet.
 *
 * Usage (two terminals):
 *   1)  npx hardhat node
 *   2)  npx hardhat run scripts/local-v3-setup.ts --network localhost
 *
 * Then paste the printed .env.local block, restart `npm run dev`, add the
 * Localhost network to your wallet (RPC http://127.0.0.1:8545, chainId 31337),
 * and import the printed test key. NEVER used against real value.
 */
import { ethers } from "hardhat";

const E = (n: string) => ethers.parseEther(n);

async function main() {
  const signers = await ethers.getSigners();
  const [deployer, alice, bob] = signers;

  const MINT_FEE = E("0.001");
  const REDEEM_FEE = E("0.001");
  const PREMIUM = E("0.002");
  const SWAP_BPS = 30;

  // ── contracts ──────────────────────────────────────────────────────────
  const Nft = await ethers.getContractFactory("MockRobinWoodNft");
  const nft = await Nft.deploy();
  await nft.waitForDeployment();
  const nftAddr = await nft.getAddress();

  const now = (await ethers.provider.getBlock("latest"))!.timestamp;
  const Beacon = await ethers.getContractFactory("DrandBeaconMock");
  const beacon = await Beacon.deploy(3, now); // 3s period
  await beacon.waitForDeployment();
  const beaconAddr = await beacon.getAddress();

  const Vault = await ethers.getContractFactory("MarketplankVaultV3");
  const vault = await Vault.deploy(
    nftAddr,
    "Marketplank RobinWood Vault V3",
    "vROBIN",
    MINT_FEE,
    REDEEM_FEE,
    PREMIUM,
    SWAP_BPS,
    deployer.address,
    beaconAddr
  );
  await vault.waitForDeployment();
  const vaultAddr = await vault.getAddress();

  // ── mint planks: 1–12 to deployer, 13–18 alice, 19–24 bob ───────────────
  const mintRange = async (to: string, from: number, to_: number) => {
    for (let id = from; id <= to_; id++) await nft.mint(to, id);
  };
  await mintRange(deployer.address, 1, 12);
  await mintRange(alice.address, 13, 18);
  await mintRange(bob.address, 19, 24);

  // ── seed + open a real pool ─────────────────────────────────────────────
  await nft.setApprovalForAll(vaultAddr, true);
  // Deposit 8 planks (deployer) -> 8 shares, vault holds 8.
  await vault.depositMany([1, 2, 3, 4, 5, 6, 7, 8], { value: MINT_FEE * 8n });
  // Seed 2 shares + 0.4 ETH, then open (locks the seed).
  await vault.seedShares(E("2"), { value: E("0.4") });
  await vault.openPool();
  // Add real depth so the deployer also holds an ordinary LP position.
  await vault.addLiquidity(E("3"), 0, { value: E("0.4") });

  const held: bigint = await vault.heldTokenCount();
  const eth: bigint = await vault.ethReserve();
  const shares: bigint = await vault.shareReserve();
  const lp: bigint = await vault.lpBalance(deployer.address);
  const bal: bigint = await vault.balanceOf(deployer.address);

  // First hardhat account key is well-known and only ever funds this local node.
  const HH_KEY0 = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

  console.log("\n========================================================");
  console.log(" Local V3 dev stack is live on http://127.0.0.1:8545 (chainId 31337)");
  console.log("========================================================");
  console.log(" Vault (V3)  :", vaultAddr);
  console.log(" Collection  :", nftAddr);
  console.log(" Beacon      :", beaconAddr);
  console.log(" Treasury    :", deployer.address, "(account #0)");
  console.log("\n Pool: open ·", held.toString(), "planks ·", ethers.formatEther(eth), "ETH ·",
    ethers.formatEther(shares), "shares in pool");
  console.log(" Deployer holds:", ethers.formatEther(bal), "shares +", ethers.formatEther(lp), "LP + planks 9-12");
  console.log(" Alice (acct #1) holds planks 13-18 ·  Bob (acct #2) planks 19-24");

  console.log("\n--- paste into .env.local, then restart `npm run dev` ---");
  console.log("NEXT_PUBLIC_MARKET_ENABLED=true");
  console.log("NEXT_PUBLIC_DEV_LOCAL_CHAIN=1");
  console.log("NEXT_PUBLIC_DEV_LOCAL_RPC=http://127.0.0.1:8545");
  console.log("NEXT_PUBLIC_MARKET_VAULT_ADDRESS=" + vaultAddr);
  console.log("NEXT_PUBLIC_MARKET_VAULT_LEGACY_ADDRESS=");
  console.log("NEXT_PUBLIC_MARKET_VAULT_LEGACY_ADDRESSES=");
  console.log("NEXT_PUBLIC_NFT_CONTRACT_ADDRESS=" + nftAddr);
  console.log("NEXT_PUBLIC_DRAND_BEACON_ADDRESS=" + beaconAddr);
  console.log("\n--- wallet import (test account #0, LOCAL ONLY) ---");
  console.log(" Address:", deployer.address);
  console.log(" Key    :", HH_KEY0);
  console.log(" Add network: RPC http://127.0.0.1:8545 · chainId 31337 · symbol ETH");
  console.log("========================================================\n");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
