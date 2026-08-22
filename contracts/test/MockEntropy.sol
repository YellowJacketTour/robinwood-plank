// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {MockEntropy} from "@pythnetwork/entropy-sdk-solidity/MockEntropy.sol";

/// Thin subclass to force Hardhat 3 to emit a real artifact for the
/// SDK's own MockEntropy -- a bare unused `import` gets tree-shaken with
/// no artifact produced (confirmed empirically for the same situation
/// with Chainlink's VRFCoordinatorV2_5Mock; see that mock shim's comment).
contract PlankCrashMockEntropy is MockEntropy {
    constructor(address defaultProvider) MockEntropy(defaultProvider) {}
}
