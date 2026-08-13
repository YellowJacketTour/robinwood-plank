import hardhatToolboxMochaEthers from "@nomicfoundation/hardhat-toolbox-mocha-ethers";
import { defineConfig } from "hardhat/config";
import type { HardhatUserConfig } from "hardhat/config";

/**
 * Compiles contracts/ for review and local testing only — see
 * contracts/MarketplankVault.sol's header. No network config here on
 * purpose: this file has never deployed anything and shouldn't be able to
 * by accident. Deployment happens via an explicit, reviewed script once the
 * audit gate (docs/marketplank/SPEC.md §7) is cleared.
 */
const config = defineConfig({
  plugins: [hardhatToolboxMochaEthers],
  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: { enabled: true, runs: 200 },
      // Required by PlankCrashV2.sol -- its Config-struct constructor and
      // large Round struct (view-returned by currentRound()) hit a real
      // "stack too deep" error under the legacy codegen; viaIR is the
      // standard, compiler-recommended fix. Applies repo-wide, so the
      // full test suite was re-run after enabling this, not just the new
      // contract's own tests, to confirm no other contract regressed.
      viaIR: true,
      // Pinned to OpenZeppelin 4.x specifically to avoid Cancun-only opcodes
      // (mcopy) that OZ 5.x's Bytes.sol uses unconditionally — Robinhood
      // Chain's latest block has no excessBlobGas field, so Cancun support
      // is unconfirmed. Paris is the conservative, broadly-supported target.
      evmVersion: "paris",
    },
  },
  paths: {
    sources: "./contracts",
    tests: "./test/contracts",
    cache: "./.hardhat-cache",
    artifacts: "./.hardhat-artifacts",
  },
  chainDescriptors: {
    4663: {
      name: "Robinhood Chain",
      blockExplorers: {
        etherscan: {
          name: "Robinhood Chain Explorer",
          url: "https://robinhoodchain.blockscout.com",
          apiUrl: "https://robinhoodchain.blockscout.com/api",
        },
        blockscout: {
          name: "Robinhood Chain Explorer",
          url: "https://robinhoodchain.blockscout.com",
          apiUrl: "https://robinhoodchain.blockscout.com/api",
        },
      },
    },
    46630: {
      name: "Robinhood Chain Testnet",
      blockExplorers: {
        etherscan: {
          name: "Robinhood Chain Testnet Explorer",
          url: "https://explorer.testnet.chain.robinhood.com",
          apiUrl: "https://explorer.testnet.chain.robinhood.com/api",
        },
        blockscout: {
          name: "Robinhood Chain Testnet Explorer",
          url: "https://explorer.testnet.chain.robinhood.com",
          apiUrl: "https://explorer.testnet.chain.robinhood.com/api",
        },
      },
    },
  },
  // Block-explorer (Blockscout) source verification for the Robinhood chains.
  // Blockscout ignores the apiKey but hardhat-verify requires an entry.
  verify: {
    etherscan: {
      apiKey: process.env.ROBINHOOD_EXPLORER_KEY || "blockscout",
    },
  },
  networks: {
    // LOCAL ONLY. `npx hardhat node` serves this on 127.0.0.1:8545 (chainId
    // 31337); scripts/local-v3-setup.ts deploys the V3 dev stack here so the
    // frontend can be exercised without touching mainnet.
    localhost: { type: "http", url: "http://127.0.0.1:8545", chainId: 31337 },

    // Robinhood networks appear ONLY when their RPC URL + DEPLOYER_PK are both
    // present in the environment. Absent those env vars the keys below are
    // simply not defined, so `--network robinhood` errors out — there is still
    // NO one-command path to mainnet by accident (the anti-footgun invariant
    // from this file's header). The deploy+seed workflow
    // (.github/workflows/deploy-vault-v3.yml) injects them at dispatch time from
    // GitHub secrets; DEPLOYER_PK is never committed and never enters the app
    // build/runtime (same isolation as RELAYER_PRIVATE_KEY).
    ...robinhoodNetworks(),
  },
});

/**
 * Build the Robinhood network map from env, omitting any network whose RPC/key
 * is unset. `robinhood` = Arbitrum Orbit mainnet (chainId 4663);
 * `robinhood-testnet` = the rehearsal chain (chainId from env). A deploy key is
 * required for both — this repo has no read-only path to these chains, only a
 * signed-deploy path, and only when explicitly configured.
 */
function robinhoodNetworks(): HardhatUserConfig["networks"] {
  const key = process.env.DEPLOYER_PK;
  const accounts = key ? [key.startsWith("0x") ? key : `0x${key}`] : [];
  const nets: NonNullable<HardhatUserConfig["networks"]> = {};
  if (accounts.length && process.env.ROBINHOOD_RPC_URL) {
    nets.robinhood = { type: "http", url: process.env.ROBINHOOD_RPC_URL, chainId: 4663, accounts };
  }
  if (accounts.length && process.env.ROBINHOOD_TESTNET_RPC_URL) {
    nets["robinhood-testnet"] = {
      type: "http",
      url: process.env.ROBINHOOD_TESTNET_RPC_URL,
      // Testnet chainId is env-driven — Orbit testnets don't share mainnet's id.
      chainId: process.env.ROBINHOOD_TESTNET_CHAIN_ID
        ? Number(process.env.ROBINHOOD_TESTNET_CHAIN_ID)
        : undefined,
      accounts,
    };
  }
  return nets;
}

export default config;
