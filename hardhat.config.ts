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
    version: "0.8.24",
    settings: {
      optimizer: { enabled: true, runs: 200 },
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
  networks: {
    // LOCAL ONLY. `npx hardhat node` serves this on 127.0.0.1:8545 (chainId
    // 31337); scripts/local-v3-setup.ts deploys the V3 dev stack here so the
    // frontend can be exercised without touching mainnet. There is still no
    // Robinhood/mainnet network here — deployment to real value stays a
    // deliberate, wallet-signed act (scripts/deploy-vault-v3.ts).
    localhost: { url: "http://127.0.0.1:8545", chainId: 31337 },
  },
};

export default config;
