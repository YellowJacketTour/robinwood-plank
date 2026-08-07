# Hardhat 3 migration

Hardhat is the local contract build, test, and deployment toolchain. It is
not part of the Passenger frontend/backend runtime dependency set.

## Changes

- migrated the project from Hardhat 2 and the monolithic toolbox to Hardhat 3
  with `@nomicfoundation/hardhat-toolbox-mocha-ethers`;
- adopted the ESM configuration required by Hardhat 3 and explicit
  `hre.network.create()` connections in tests and deployment scripts;
- migrated the legacy Chai `.reverted` assertions to the Hardhat 3
  `.revert(ethers)` matcher;
- retained the Paris EVM target and OpenZeppelin 4.x constraint;
- retained Robinhood explorer configuration through Hardhat 3 chain
  descriptors; and
- ignored Hardhat 3's generated `types/` TypeChain output.

No contract source or constructor parameters changed in this migration.

## Validation

- `npx hardhat build`: passed with solc 0.8.24, Paris;
- `npx tsc -p tsconfig.hardhat.json --noEmit`: passed;
- `npm run test:contracts`: 97 passing;
- stripped-metadata runtime bytecode fingerprints for DrandBeacon,
  BLSBN254, MarketplankVault, and MarketplankVaultV3 match the pre-migration
  Hardhat 2 artifacts; the interface has empty runtime bytecode in both; and
- a deployment-script dry invocation reaches its deliberate missing-environment
  guard without loading a private key or attempting a transaction.

Hardhat 3 still reports transitive audit/deprecation findings in its own
development tree. Those findings remain on this contract-only track and must
not be “fixed” by overriding frontend/backend runtime dependencies blindly.
