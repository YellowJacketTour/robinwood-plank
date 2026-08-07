/**
 * ⚠ DEPRECATED — deploys the RETIRED V2 vault (contracts/MarketplankVault.sol),
 * whose liquidity functions have a critical, externally exploitable flaw
 * (audit held privately). DO NOT deploy a new vault with
 * this script. Use scripts/deploy-vault-v3.ts instead. Kept only as the record
 * of how V1/V2 were deployed. Its post-deploy env output below also hardcodes
 * V1 as the sole legacy, which after a V3 deploy would strand V2 depositors —
 * another reason not to follow it.
 *
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
import hardhat from "hardhat";

// Marketplank's dedicated treasury wallet (lib/constants.ts
// MARKET_FEE_RECIPIENT) — separate from the Trade section's Uniswap
// integrator fee wallet. Override with the MARKET_FEE_RECIPIENT env var if
// the vault should pay a different address for some reason.
const DEFAULT_FEE_RECIPIENT = "0xcdb7ca36d35fa16d15fda859a46f1d72d979e9d8";

// Kept deliberately lower than NFTX's typical production rates: the vault's
// whole value proposition is being faster than a Seaport listing, and
// Seaport charges $PLANK 0%. If the vault round-trip cost more than a
// listing, nobody would use it. Approved 2026-07-27. Still CONFIRM before
// deploying — they are immutable the moment this script runs.
const DEFAULT_MINT_FEE_BPS = 100; // 1%
const DEFAULT_REDEEM_FEE_BPS = 100; // 1%
const DEFAULT_TARGET_PREMIUM_BPS = 250; // 2.5% extra to pick a specific token ID

async function main() {
  const { ethers } = await hardhat.network.create();
  const NFT_COLLECTION_ADDRESS = process.env.MARKET_COLLECTION_ADDRESS;
  if (!NFT_COLLECTION_ADDRESS) {
    throw new Error("Set MARKET_COLLECTION_ADDRESS before deploying.");
  }
  const FEE_RECIPIENT = process.env.MARKET_FEE_RECIPIENT || DEFAULT_FEE_RECIPIENT;

  // The vault draws its randomness from a deployed DrandBeacon (see
  // contracts/DrandBeacon.sol). Deploy and verify that FIRST — with drand
  // parameters you cross-checked against multiple independent mirrors — then
  // pass its address here. There is no default: a wrong beacon is a silently
  // broken redemption path, so this must be a deliberate act.
  const BEACON_ADDRESS = process.env.MARKET_DRAND_BEACON_ADDRESS;
  if (!BEACON_ADDRESS) {
    throw new Error(
      "Set MARKET_DRAND_BEACON_ADDRESS to a deployed DrandBeacon before deploying the vault."
    );
  }

  const MINT_FEE_BPS = process.env.MARKET_MINT_FEE_BPS
    ? Number(process.env.MARKET_MINT_FEE_BPS)
    : DEFAULT_MINT_FEE_BPS;
  const REDEEM_FEE_BPS = process.env.MARKET_REDEEM_FEE_BPS
    ? Number(process.env.MARKET_REDEEM_FEE_BPS)
    : DEFAULT_REDEEM_FEE_BPS;
  const TARGET_PREMIUM_BPS = process.env.MARKET_TARGET_PREMIUM_BPS
    ? Number(process.env.MARKET_TARGET_PREMIUM_BPS)
    : DEFAULT_TARGET_PREMIUM_BPS;

  console.log(
    "The vault deploys CLOSED: nobody can trade until the treasury calls openPool(). " +
      "Seed shares + ETH at your own pace, then call openPool() — it is ONE-WAY: " +
      "trading becomes public forever and seedLiquidity/seedShares lock forever, " +
      "for everyone, treasury included."
  );

  console.log("Deploying with:", {
    NFT_COLLECTION_ADDRESS,
    FEE_RECIPIENT,
    MINT_FEE_BPS,
    REDEEM_FEE_BPS,
    TARGET_PREMIUM_BPS,
    BEACON_ADDRESS,
  });

  const Vault = await ethers.getContractFactory("MarketplankVault");
  const vault = await Vault.deploy(
    NFT_COLLECTION_ADDRESS,
    "Marketplank RobinWood Vault",
    "vROBIN",
    MINT_FEE_BPS,
    REDEEM_FEE_BPS,
    TARGET_PREMIUM_BPS,
    FEE_RECIPIENT,
    BEACON_ADDRESS
  );
  await vault.waitForDeployment();

  const address = await vault.getAddress();
  console.log("MarketplankVault deployed at:", address);
  console.log("Dual-vault migrate env (safe — do not drop V1 until empty):");
  console.log("  NEXT_PUBLIC_MARKET_VAULT_ADDRESS =", address, "  # new primary (V2)");
  console.log(
    "  NEXT_PUBLIC_MARKET_VAULT_LEGACY_ADDRESS = 0xb2019Fd4cA24502e812C0C73b751Fa49979BF708  # existing deposits"
  );
  console.log("Also set both in wrangler.jsonc vars and redeploy the site.");
  console.log(
    "Then seed the pool (deposit NFTs, seedShares()/seedLiquidity()) and finally call " +
      "openPool() to make trading public — one-way, seeding locks forever."
  );
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
