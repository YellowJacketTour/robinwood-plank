/**
 * Deploys contracts/MarketplankVaultV3.sol to Robinhood Chain.
 *
 * NOT RUN BY CLAUDE. This script is written for a human operator to run with
 * their own funded wallet — no private key is ever pasted into a chat with
 * an AI assistant.
 *
 * V3 replaces V2 (contracts/MarketplankVault.sol), whose liquidity functions
 * had a critical, externally exploitable LP flaw — see
 * the privately-held V2 LP audit. V1 AND V2 both become redeem-only
 * legacies; users migrate into V3.
 *
 * Before running this against mainnet:
 *   1. contracts/MarketplankVaultV3.sol has passed the review you intend.
 *   2. The fee parameters below are final — they are IMMUTABLE once deployed.
 *      NOTE they are now flat ETH amounts (wei), not basis points. Set them to
 *      match plank floor economics; a flat fee decouples from floor price in
 *      both directions, by design.
 *   3. You are running this with a wallet YOU control, funded with real ETH.
 *
 * Usage:
 *   PRIVATE_KEY=0x... ROBINHOOD_RPC_URL=https://rpc.mainnet.chain.robinhood.com \
 *     MARKET_COLLECTION_ADDRESS=0x... MARKET_DRAND_BEACON_ADDRESS=0x... \
 *     npx hardhat run scripts/deploy-vault-v3.ts --network robinhood
 *
 * (The `robinhood` network is deliberately NOT pre-configured in
 * hardhat.config.ts — add it yourself when you're ready to actually deploy,
 * so this repo never has a one-command path to mainnet by accident.)
 */
import { ethers } from "hardhat";

// Marketplank's dedicated treasury wallet (lib/constants.ts MARKET_FEE_RECIPIENT).
const DEFAULT_TREASURY = "0xcdb7ca36d35fa16d15fda859a46f1d72d979e9d8";

// The existing deployed vaults — BOTH stay configured as redeem-only legacies.
// Dropping either from the client env bricks every legacy call for its holders
// ("Blocked unsafe vault target"), so they remain until each reads empty.
const V1_ADDRESS = "0xb2019Fd4cA24502e812C0C73b751Fa49979BF708";
const V2_ADDRESS = "0xc4B29D7a01603D2A5937b1FC86ea85E488d72e04";

// PLACEHOLDER flat fees in wei — CONFIRM before deploying, they are immutable.
// Contract ceilings: mint/redeem <= 0.05 ether, premium <= 0.1 ether,
// swap <= 100 bps. These defaults mirror the test suite, NOT an approved fee.
const DEFAULT_MINT_FEE_WEI = ethers.parseEther("0.001");
const DEFAULT_REDEEM_FEE_WEI = ethers.parseEther("0.001");
const DEFAULT_TARGET_PREMIUM_WEI = ethers.parseEther("0.002");
const DEFAULT_SWAP_FEE_BPS = 30; // 0.30% to the reserve, so LPs earn

async function main() {
  const NFT_COLLECTION_ADDRESS = process.env.MARKET_COLLECTION_ADDRESS;
  if (!NFT_COLLECTION_ADDRESS) {
    throw new Error("Set MARKET_COLLECTION_ADDRESS before deploying.");
  }
  const TREASURY = process.env.MARKET_FEE_RECIPIENT || DEFAULT_TREASURY;

  const BEACON_ADDRESS = process.env.MARKET_DRAND_BEACON_ADDRESS;
  if (!BEACON_ADDRESS) {
    throw new Error(
      "Set MARKET_DRAND_BEACON_ADDRESS to a deployed DrandBeacon before deploying the vault. " +
        "V3 reuses V1/V2's beacon — no new beacon or drand re-verification is needed."
    );
  }

  const MINT_FEE_WEI = process.env.MARKET_MINT_FEE_WEI
    ? BigInt(process.env.MARKET_MINT_FEE_WEI)
    : DEFAULT_MINT_FEE_WEI;
  const REDEEM_FEE_WEI = process.env.MARKET_REDEEM_FEE_WEI
    ? BigInt(process.env.MARKET_REDEEM_FEE_WEI)
    : DEFAULT_REDEEM_FEE_WEI;
  const TARGET_PREMIUM_WEI = process.env.MARKET_TARGET_PREMIUM_WEI
    ? BigInt(process.env.MARKET_TARGET_PREMIUM_WEI)
    : DEFAULT_TARGET_PREMIUM_WEI;
  const SWAP_FEE_BPS = process.env.MARKET_SWAP_FEE_BPS
    ? Number(process.env.MARKET_SWAP_FEE_BPS)
    : DEFAULT_SWAP_FEE_BPS;

  console.log(
    "The vault deploys CLOSED: nobody can trade until the treasury calls openPool(). " +
      "openPool() is ONE-WAY and it LOCKS the seed forever (mints sqrt(E*S) LP to a dead " +
      "address so pool ETH can never be withdrawn — the no-rug guarantee)."
  );

  console.log("Deploying MarketplankVaultV3 with:", {
    NFT_COLLECTION_ADDRESS,
    TREASURY,
    MINT_FEE_WEI: MINT_FEE_WEI.toString(),
    REDEEM_FEE_WEI: REDEEM_FEE_WEI.toString(),
    TARGET_PREMIUM_WEI: TARGET_PREMIUM_WEI.toString(),
    SWAP_FEE_BPS,
    BEACON_ADDRESS,
  });

  const Vault = await ethers.getContractFactory("MarketplankVaultV3");
  const vault = await Vault.deploy(
    NFT_COLLECTION_ADDRESS,
    "Marketplank RobinWood Vault V3",
    "vROBIN",
    MINT_FEE_WEI,
    REDEEM_FEE_WEI,
    TARGET_PREMIUM_WEI,
    SWAP_FEE_BPS,
    TREASURY,
    BEACON_ADDRESS
  );
  await vault.waitForDeployment();

  const address = await vault.getAddress();
  console.log("\nMarketplankVaultV3 deployed at:", address);

  // Post-deploy verification: confirm the deployed bytecode actually is V3, not
  // a stale artifact (the wallet-signed deploy tool has bitten this before).
  const version = await vault.VAULT_VERSION();
  if (version !== 3n) {
    throw new Error(
      `Deployed VAULT_VERSION is ${version}, expected 3 — you deployed a stale/wrong artifact. Recompile and redeploy.`
    );
  }
  console.log("Verified on-chain VAULT_VERSION =", version.toString());

  console.log("\n=== Client env (primary V3, V1 AND V2 as redeem-only legacies) ===");
  console.log("  NEXT_PUBLIC_MARKET_VAULT_ADDRESS =", address, "  # new primary (V3)");
  console.log(
    "  NEXT_PUBLIC_MARKET_VAULT_LEGACY_ADDRESSES =",
    `${V1_ADDRESS},${V2_ADDRESS}`,
    "  # V1 and V2 — redeem-only, DO NOT drop either until it reads empty"
  );
  console.log(
    "Set these in .env, wrangler.jsonc, docker-compose.inmotion.yml, the Dockerfile\n" +
      "ARG/ENV, and .github/workflows/inmotion.yml, then redeploy the site."
  );

  console.log("\n=== Seeding — READ THIS, it is the part that loses money if rushed ===");
  console.log(
    "1. Seed the MINIMUM to open: one or two NFTs deposited + seedShares{value: <small>}.\n" +
      "   Whatever you seed here is LOCKED FOREVER at openPool() (see above), so keep it tiny.\n" +
      "2. Call openPool() — one-way; seeding dies, trading opens.\n" +
      "3. Add your REAL liquidity AFTER opening via addLiquidity() — that position is a\n" +
      "   normal, withdrawable LP claim (withdrawing pro-rata at current price is the same\n" +
      "   right every user has, so it is NOT a rug). Do NOT put real depth in as seed.\n" +
      "   Protect a large addLiquidity via a private relay or split it into tranches."
  );
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
