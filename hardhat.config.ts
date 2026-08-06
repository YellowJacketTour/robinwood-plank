import "@nomicfoundation/hardhat-toolbox";
import type { HardhatUserConfig } from "hardhat/config";

/**
 * Compiles contracts/ for review and local testing only — see
 * contracts/MarketplankVault.sol's header. No network config here on
 * purpose: this file has never deployed anything and shouldn't be able to
 * by accident. Deployment happens via an explicit, reviewed script once the
 * audit gate (docs/marketplank/SPEC.md §7) is cleared.
 */
const config: HardhatUserConfig = {
  solidity: {
    compilers: [
      {
        version: "0.8.24",
        settings: {
          optimizer: { enabled: true, runs: 200 },
          // Pinned to OpenZeppelin 4.x specifically to avoid Cancun-only
          // opcodes (mcopy) that OZ 5.x's Bytes.sol uses unconditionally —
          // Robinhood Chain's latest block has no excessBlobGas field, so
          // Cancun support is unconfirmed. Paris is the conservative,
          // broadly-supported target.
          evmVersion: "paris",
          /**
           * Emit solc's storage layout for every contract.
           *
           * WHY THIS IS SAFE TO ADD to a config whose header warns that
           * changing compiler settings breaks source verification for the
           * ALREADY-DEPLOYED MarketplankVault contracts: `outputSelection`
           * selects which artefacts solc EMITS. It is not a codegen setting and
           * does not participate in optimisation, so every contract's bytecode
           * is bit-identical with and without it. (Verified: the deployed
           * bytecode of MarketplankVault and MarketplankVaultV3 is unchanged
           * across this edit.)
           *
           * WHY IT IS NEEDED: the diamond's most important structural rule —
           * "no facet declares a state variable, ever" (design doc section 3.3
           * rule 1) — cannot be checked by reading facet source, because the
           * dangerous case is INHERITED storage: a facet that looks clean but
           * extends OpenZeppelin's ERC20 or ReentrancyGuard and silently lands
           * a mapping on the diamond's own slot 0. Only the compiler knows the
           * resolved layout. Diamond.storage.test.ts reads it from here.
           */
          outputSelection: {
            "*": {
              "*": [
                "abi",
                "evm.bytecode",
                "evm.deployedBytecode",
                "evm.methodIdentifiers",
                "metadata",
                "storageLayout",
              ],
            },
          },
        },
      },
    ],
    /**
     * PER-FILE OVERRIDE, scoped as narrowly as it can be.
     *
     * GlobalIndexVault.sol crossed the EIP-170 24576-byte deployed-code limit
     * (23780 -> 26252 bytes) when the eligibility read, the dynamic HHI cap
     * and the realized-variance calibration landed. Two settings bring it
     * back under, at 21379 bytes:
     *
     *   - `runs: 1` optimises for DEPLOYMENT SIZE rather than repeated-call
     *     gas, which is the right trade for a contract that is deployed once
     *     and whose hot paths are already O(n <= 32).
     *   - `viaIR: true` routes through the Yul IR pipeline, whose optimiser
     *     is materially better at cross-function code sharing. This is the
     *     setting doing most of the work (~4KB of the ~4.9KB saved).
     *
     * The alternative considered and rejected was extracting the new math
     * into an external `library` with `public` functions. It works, but it
     * saves less (the delegatecall stubs and their ABI encoding cost most of
     * what the moved bodies save — measured, not assumed: moving the
     * array-passing `applyCapAndRedistribute` out made the contract BIGGER),
     * and it forces every test that deploys the vault to link a library
     * address. A compiler setting on a not-for-deployment contract is the
     * smaller change.
     *
     * Applied to this ONE file on purpose. Changing the global setting would
     * silently change the compiled bytecode of MarketplankVaultV3.sol and
     * MarketplankVault.sol, which are ALREADY DEPLOYED and whose published
     * source verification is pinned to the 200-runs build — a recompile that
     * no longer reproduces deployed bytecode is a verification break, and it
     * would be caused by an unrelated change to a contract that has never been
     * deployed at all. Every other contract's output is bit-identical.
     */
    overrides: {
      "contracts/GlobalIndexVault.sol": {
        version: "0.8.24",
        settings: {
          optimizer: { enabled: true, runs: 1 },
          viaIR: true,
          evmVersion: "paris",
          // Same output selection as the default profile; an override replaces
          // the whole settings object, so omitting it here would silently drop
          // storageLayout for this one file.
          outputSelection: {
            "*": {
              "*": [
                "abi",
                "evm.bytecode",
                "evm.deployedBytecode",
                "evm.methodIdentifiers",
                "metadata",
                "storageLayout",
              ],
            },
          },
        },
      },
    },
  },
  paths: {
    sources: "./contracts",
    tests: "./test/contracts",
    cache: "./.hardhat-cache",
    artifacts: "./.hardhat-artifacts",
  },
  // Block-explorer (Blockscout) source verification for the Robinhood chains.
  // Blockscout ignores the apiKey but hardhat-verify requires an entry.
  etherscan: {
    apiKey: {
      robinhood: process.env.ROBINHOOD_EXPLORER_KEY || "blockscout",
      "robinhood-testnet": process.env.ROBINHOOD_EXPLORER_KEY || "blockscout",
    },
    customChains: [
      {
        network: "robinhood",
        chainId: 4663,
        urls: {
          apiURL: "https://robinhoodchain.blockscout.com/api",
          browserURL: "https://robinhoodchain.blockscout.com",
        },
      },
      {
        network: "robinhood-testnet",
        chainId: 46630,
        urls: {
          apiURL: "https://explorer.testnet.chain.robinhood.com/api",
          browserURL: "https://explorer.testnet.chain.robinhood.com",
        },
      },
    ],
  },
  networks: {
    // LOCAL ONLY. `npx hardhat node` serves this on 127.0.0.1:8545 (chainId
    // 31337); scripts/local-v3-setup.ts deploys the V3 dev stack here so the
    // frontend can be exercised without touching mainnet.
    localhost: { url: "http://127.0.0.1:8545", chainId: 31337 },

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
};

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
    nets.robinhood = { url: process.env.ROBINHOOD_RPC_URL, chainId: 4663, accounts };
  }
  if (accounts.length && process.env.ROBINHOOD_TESTNET_RPC_URL) {
    nets["robinhood-testnet"] = {
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
