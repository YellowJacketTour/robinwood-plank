/**
 * Deploys contracts/MarketplankVault.sol to Robinhood Chain.
 *
 * NOT RUN BY CLAUDE. This script is written for a human operator to run with
 * their own funded wallet — no private key is ever pasted into a chat with
 * an AI assistant. See docs/marketplank/SPEC.md §7.
 *
 * Before running this against mainnet:
 *   1. contracts/MarketplankVault.sol has passed an independent third-party audit.
 *   2. The fee parameters below are final — they are immutable once deployed.
 *   3. You are running this with a wallet YOU control, funded with real ETH for gas.
 *
 * Usage:
 *   PRIVATE_KEY=0x... ROBINHOOD_RPC_URL=https://rpc.mainnet.chain.robinhood.com \
 *     npx hardhat run scripts/deploy-vault.ts --network robinhood
 *
 * (The `robinhood` network is deliberately NOT pre-configured in
 * hardhat.config.ts — add it yourself when you're ready to actually deploy,
 * so this repo never has a one-command path to mainnet by accident.)
 */
import { ethers } from "hardhat";

async function main() {
  const NFT_COLLECTION_ADDRESS = process.env.MARKET_COLLECTION_ADDRESS;
  const FEE_RECIPIENT = process.env.MARKET_FEE_RECIPIENT;
  if (!NFT_COLLECTION_ADDRESS || !FEE_RECIPIENT) {
    throw new Error(
      "Set MARKET_COLLECTION_ADDRESS and MARKET_FEE_RECIPIENT env vars before deploying."
    );
  }

  const MINT_FEE_BPS = 250; // 2.5%
  const REDEEM_FEE_BPS = 250; // 2.5%
  const TARGET_PREMIUM_BPS = 500; // 5%

  const Vault = await ethers.getContractFactory("MarketplankVault");
  const vault = await Vault.deploy(
    NFT_COLLECTION_ADDRESS,
    "Marketplank RobinWood Vault",
    "vROBIN",
    MINT_FEE_BPS,
    REDEEM_FEE_BPS,
    TARGET_PREMIUM_BPS,
    FEE_RECIPIENT
  );
  await vault.waitForDeployment();

  const address = await vault.getAddress();
  console.log("MarketplankVault deployed at:", address);
  console.log("Set NEXT_PUBLIC_MARKET_VAULT_ADDRESS =", address, "in Vercel env vars.");
  console.log("Then seed liquidity by calling seedLiquidity() with an initial ETH amount.");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
