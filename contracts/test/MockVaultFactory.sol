// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @notice Minimal `isVault` registry standing in for `CollectionVaultFactory`
 * (which does not yet expose `isVault` — that wiring lands with the real
 * factory-integration PR). Used only by WeightModule's PR1 test suite.
 */
contract MockVaultFactory {
    mapping(address => bool) public isVault;

    function setVault(address vault, bool allowed) external {
        isVault[vault] = allowed;
    }
}
