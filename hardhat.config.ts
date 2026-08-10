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
    compilers: [
      {
        version: "0.8.24",
        settings: {
          optimizer: { enabled: true, runs: 200 },
          // Pinned to OpenZeppelin 4.x specifically to avoid Cancun-only opcodes
          // (mcopy) that OZ 5.x's Bytes.sol uses unconditionally.
          evmVersion: "paris",
          // `storageLayout` is REQUIRED, not decorative: the diamond's rule
          // "no facet declares a state variable" cannot be checked by reading
          // facet source, because the dangerous case is INHERITED storage (a
          // facet extending ERC20/ReentrancyGuard silently landing a mapping
          // on the diamond's slot 0). Only the compiler knows the resolved
          // layout, and Diamond.storage.test.ts reads it from here.
          // outputSelection picks which artefacts solc EMITS -- not a codegen
          // setting, so bytecode is bit-identical with and without it.
      outputSelection: {
        "*": {
          "*": ["abi", "evm.bytecode", "evm.deployedBytecode", "evm.methodIdentifiers", "metadata", "storageLayout"],
        },
      },
        },
      },
    ],
    // viaIR ONLY, deliberately -- not a lower optimizer `runs`.
    //
    // Diamond.sol / IndexDeployer.sol: legacy codegen's ABI DECODER for the
    // single-struct initialiser runs out of stack ("headStart is 1 slot too
    // deep"). A decoder limit, not a size limit; viaIR compiles it directly.
    //
    // CollectionVault / CollectionVaultFactory: the factory's bytecode carries
    // the vault's entire CREATION code as a data blob (type(...).creationCode),
    // so the two are ONE size problem. Factory was 98.2% of EIP-170 with 454
    // bytes spare; viaIR took it to 92.5% with 1,853. MEASURED: factory size by
    // runs, all with viaIR on -- runs=1 -> 22,592, runs=50 -> 22,593,
    // runs=200 -> 22,723. A 131-byte spread across a 200x change, so the whole
    // saving is viaIR codegen, NOT a gas trade-off. `runs` stays 200 so the hot
    // user paths keep full optimisation. diamondCut is renounced at birth, so
    // an over-limit contract would have no later fix.
    overrides: Object.fromEntries(
      [
        "contracts/diamond/Diamond.sol",
        "contracts/diamond/IndexDeployer.sol",
        "contracts/factory/CollectionVault.sol",
        "contracts/factory/CollectionVaultFactory.sol",
      ].map((f) => [
        f,
        {
          version: "0.8.24",
          settings: {
            optimizer: { enabled: true, runs: 200 },
            viaIR: true,
            evmVersion: "paris",
          outputSelection: {
            "*": {
              "*": ["abi", "evm.bytecode", "evm.deployedBytecode", "evm.methodIdentifiers", "metadata", "storageLayout"],
            },
          },
          },
        },
      ])
    ),
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
    // Pinned hardfork, RE-ADDED during the Hardhat 2->3 merge — this exact
    // fix already existed pre-migration and was lost because the merge only
    // carried the `solidity` block forward from dev's config, not `networks`.
    //
    // WHY THIS IS NEEDED. Hardhat's current default hardfork is past Fusaka,
    // which enforces EIP-7825's 16,777,216 PER-TRANSACTION gas cap.
    // `IndexDeployer`'s one-shot atomic deploy-cut-finalize transaction
    // genuinely needs slightly MORE than that once a 13th facet
    // (`IndexPoolFacet`) joined the manifest (~16.8-17M gas, confirmed by
    // direct measurement) — a real limit on a Fusaka chain, irrelevant on the
    // pre-Cancun chain this repo actually targets (see the `evmVersion:
    // "paris"` note above). "cancun" is the newest hardfork that supports
    // `PUSH0` (EIP-3855, Shanghai+, required by this compile target) without
    // reintroducing Fusaka's cap.
    hardhat: { type: "edr-simulated", hardfork: "cancun" },

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
