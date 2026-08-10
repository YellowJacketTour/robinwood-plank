// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Minimal stand-in exposing only `eligibilityRoot()` non-zero, for
/// WeightModule's isolated unit-test fixture to satisfy
/// `setRobinwoodVault`'s gated-vault requirement (game-theory audit
/// hardening) without deploying a full CollectionVault. LOCAL HARDHAT TEST
/// ONLY — has no other vault surface.
contract MockGatedVaultStub {
    bytes32 public constant eligibilityRoot = keccak256("mock-gated-vault-stub");
}
