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
// Node 24 runs this .ts file with its native (ESM) loader, so `hardhat` (a
// CommonJS module) can only be default-imported, not named-imported.
import hardhat from "hardhat";
const { ethers } = hardhat as unknown as { ethers: typeof import("ethers") & Record<string, unknown> };

const E = (n: string) => ethers.parseEther(n);

async function main() {
  const signers = await ethers.getSigners();
  const [deployer, alice, bob] = signers;

  const MINT_FEE = E("0.001");
  const REDEEM_FEE = E("0.001");
  const PREMIUM = E("0.002");
  const SWAP_BPS = 30;

  // ── contracts ──────────────────────────────────────────────────────────
  // Enumerable so the frontend can walk holdings on-chain (no indexer locally).
  const Nft = await ethers.getContractFactory("MockRobinWoodNftEnumerable");
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

  // Optionally fund YOUR connected wallet so you can play with it directly
  // (instead of importing a test key): PLAYER_ADDRESS=0x... hardhat run ...
  const player = process.env.PLAYER_ADDRESS;
  if (player && /^0x[0-9a-fA-F]{40}$/.test(player)) {
    await deployer.sendTransaction({ to: player, value: E("100") });
    for (let id = 25; id <= 30; id++) await nft.mint(player, id); // planks 25-30
    await vault.transfer(player, E("1.5")); // 1.5 shares to trade/redeem/LP with
    console.log("\n Funded PLAYER", player, "→ 100 ETH · planks 25-30 · 1.5 shares");
  }

  // ── Legacy V1 + V2 vaults so /migrate has real positions to move ──────────
  // Two instances of the audited share-fee vault (MarketplankVault). The client
  // registry labels them V1/V2 via the *_KNOWN env vars printed below; both
  // share the SAME collection + beacon as V3, so the dev relay can finish their
  // random redeems too. The treasury (deployer/player) takes a redeemable share
  // position in each, plus a V2 LP position — so the full migration flow
  // (withdraw LP → redeem → deposit into V3) is exercisable end-to-end.
  const Legacy = await ethers.getContractFactory("MarketplankVault");
  const legacy = async (name: string) => {
    const c = await Legacy.deploy(nftAddr, name, "vROBIN", 100, 100, 200, deployer.address, beaconAddr);
    await c.waitForDeployment();
    return c;
  };
  const v1 = await legacy("Marketplank RobinWood Vault V1");
  const v2 = await legacy("Marketplank RobinWood Vault V2");
  const v1Addr = await v1.getAddress();
  const v2Addr = await v2.getAddress();

  for (let id = 31; id <= 40; id++) await nft.mint(deployer.address, id);
  await nft.setApprovalForAll(v1Addr, true);
  await nft.setApprovalForAll(v2Addr, true);

  // V1: 5 deposits (=5.0 sh; the mint fee mints back to treasury==depositor),
  //     seed 2 sh + 0.3 ETH, open. Leaves 3.0 redeemable shares, no LP.
  for (let id = 31; id <= 35; id++) await v1.deposit(id);
  await v1.seedShares(E("2"), { value: E("0.3") });
  await v1.openPool();

  // V2: 5 deposits, seed, open, then a real LP contribution (share + ETH).
  for (let id = 36; id <= 40; id++) await v2.deposit(id);
  await v2.seedShares(E("2"), { value: E("0.3") });
  await v2.openPool();
  await v2.contributeLiquidity(E("1"), { value: E("0.15") });

  // Playing from a separate injected wallet? Hand it the redeemable shares.
  // (contributeLiquidity credit is non-transferable — it stays on the treasury.)
  if (player && /^0x[0-9a-fA-F]{40}$/.test(player) && player.toLowerCase() !== deployer.address.toLowerCase()) {
    await v1.transfer(player, await v1.balanceOf(deployer.address));
    await v2.transfer(player, await v2.balanceOf(deployer.address));
  }

  const v1Bal: bigint = await v1.balanceOf(deployer.address);
  const v2Bal: bigint = await v2.balanceOf(deployer.address);

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
  console.log("\n Legacy vaults (to migrate FROM):");
  console.log("  V1", v1Addr, "→ you hold", ethers.formatEther(v1Bal), "shares · holds planks 31-35");
  console.log("  V2", v2Addr, "→ you hold", ethers.formatEther(v2Bal), "shares + an LP position · holds planks 36-40");

  console.log("\n--- paste into .env.local, then restart `npm run dev` ---");
  console.log("NEXT_PUBLIC_MARKET_ENABLED=true");
  console.log("NEXT_PUBLIC_DEV_LOCAL_CHAIN=1");
  console.log("NEXT_PUBLIC_DEV_LOCAL_RPC=http://127.0.0.1:8545");
  console.log("NEXT_PUBLIC_MARKET_VAULT_ADDRESS=" + vaultAddr);
  console.log("NEXT_PUBLIC_MARKET_VAULT_LEGACY_ADDRESSES=" + v1Addr + "," + v2Addr);
  console.log("NEXT_PUBLIC_MARKET_VAULT_V1_KNOWN=" + v1Addr);
  console.log("NEXT_PUBLIC_MARKET_VAULT_V2_KNOWN=" + v2Addr);
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
