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
     * NO PER-FILE OVERRIDES.
     *
     * There used to be one here, for `contracts/GlobalIndexVault.sol`: that
     * contract had crossed EIP-170 at 26,252 bytes and `runs: 1` + `viaIR`
     * bought it back under, after which five library extractions were spent to
     * hold it there — ending at 24,528 bytes with 48 bytes of headroom. That is
     * a dead end, and the diamond refactor is what ends it: the monolith is
     * gone, its logic lives in facets, and each facet carries a full 24,576-byte
     * budget of its own with the routing stub paid once in the proxy fallback
     * rather than at every library call site.
     *
     * Deleting the override also RESTORES a property the override cost: every
     * contract in this repo is now compiled with the identical settings, so
     * there is no file whose bytecode depends on a per-file exception a reader
     * has to know about. MarketplankVault / MarketplankVaultV3 are unaffected
     * either way — they were never in the override and their 200-runs source
     * verification is unchanged.
     *
     * ONE narrow exception remains, and it is a different KIND of problem from
     * the one above. `Diamond.sol` and `IndexDeployer.sol` take the whole
     * deployment initialiser — ERC-20 metadata, five role addresses and the
     * twelve-field risk set — as a single struct argument, and the legacy
     * codegen's ABI DECODER for that struct runs out of stack ("Variable
     * headStart is 1 slot too deep"). That is a decoder limit, not a size
     * limit: no amount of optimisation setting fixes it, and the alternative is
     * to flatten the initialiser into a dozen loose constructor arguments,
     * which would make the deployment calldata less legible at exactly the
     * place a reviewer most needs to read it. `viaIR` compiles it directly.
     *
     * Scoped to these two files only, so no facet's bytecode and no already
     * deployed contract's bytecode is touched.
     */
    overrides: Object.fromEntries([
      // viaIR is needed for these two to compile at all (deep stacks).
      ...["contracts/diamond/Diamond.sol", "contracts/diamond/IndexDeployer.sol"].map((f) => [
        f,
        {
          version: "0.8.24",
          settings: {
            optimizer: { enabled: true, runs: 200 },
            viaIR: true,
            evmVersion: "paris",
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
      ]),
      // SIZE RELIEF FOR THE EIP-170 CEILING — via `viaIR`, NOT by starving
      // the optimizer.
      //
      // CollectionVaultFactory's deployed bytecode literally carries all of
      // CollectionVault's CREATION code as a data blob (it calls
      // `type(CollectionVault).creationCode`), so the two are one size
      // problem: the factory was at 98.2% of EIP-170 with 454 bytes spare,
      // and every byte the vault sheds comes straight off the factory. An
      // over-limit contract cannot be deployed at all, and `diamondCut` is
      // renounced at birth, so there is no later fix.
      //
      // MEASURED, not assumed. Factory deployed size by optimizer runs, all
      // with viaIR on:
      //     runs=1   -> 22,592 bytes
      //     runs=50  -> 22,593 bytes
      //     runs=200 -> 22,723 bytes
      // The spread across a 200x change in `runs` is 131 bytes. Essentially
      // the ENTIRE saving comes from `viaIR`'s tighter codegen, not from
      // trading away runtime gas — so there is no reason to pay for size
      // with the gas of `deposit`/`redeem`/`buyShares`/`sellShares`, which
      // are hot user paths on every vault forever. `runs` therefore stays at
      // the repo default 200 and the contracts keep normal optimisation.
      //
      // Scoped to these two files only — no facet and no already-deployed
      // MarketplankVault bytecode is touched, so no existing contract's
      // source verification breaks.
      ...["contracts/factory/CollectionVault.sol", "contracts/factory/CollectionVaultFactory.sol"].map((f) => [
        f,
        {
          version: "0.8.24",
          settings: {
            optimizer: { enabled: true, runs: 200 },
            viaIR: true,
            evmVersion: "paris",
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
      ]),
    ]),
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
    // The in-process test network's EVM RULES (distinct from the compiler's
    // `evmVersion: "paris"` target above — this repo's own facet bytecode is
    // compiled conservatively for a pre-Cancun chain, but the LOCAL TEST
    // NETWORK is a separate, superset-compatible sandbox and does not need
    // the same restriction; paris-targeted bytecode runs unmodified on a
    // later hardfork). Pinned to "cancun" for two independent reasons found
    // wiring §7.10's pool facet into the deployment manifest:
    //   1. `SeaportCriteriaFulfill.test.ts` / `SeaportPerTokenApproval.test.ts`
    //      plant Seaport 1.6's REAL deployed bytecode via `hardhat_setCode`,
    //      which uses `PUSH0` (EIP-3855, Shanghai+) — Hardhat's default
    //      network hardfork must be at least Shanghai for that bytecode to
    //      execute at all (pre-existing requirement, just never pinned).
    //   2. Hardhat's own CURRENT default hardfork (as of the version pinned
    //      in package.json) is past FUSAKA, which enforces EIP-7825's
    //      16,777,216 PER-TRANSACTION gas cap. `IndexDeployer`'s one-shot
    //      atomic deploy-cut-finalize transaction genuinely needs slightly
    //      MORE than that once a 13th facet (`IndexPoolFacet`) joined the
    //      manifest (~16.8-17M gas, confirmed by direct measurement) — real
    //      on a Fusaka chain, irrelevant on the pre-Cancun chain this repo
    //      actually targets (see the `evmVersion: "paris"` note above).
    // "cancun" is the newest hardfork that satisfies (1) without
    // reintroducing (2) — anything from "shanghai" through "cancun" would
    // equally fix both; "cancun" is chosen as the newest hardfork this
    // Hardhat version supports that still predates Fusaka's gas cap.
    hardhat: { hardfork: "cancun" },

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
