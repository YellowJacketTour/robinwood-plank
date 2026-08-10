// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @notice Test-only stand-in for a misconfigured/broken WeightModule: every
 * note* call reverts unconditionally. Used to prove `CollectionVault`'s
 * best-effort `try/catch` signal push (PR4) never bricks a real mint/redeem
 * hot path even when the downstream WeightModule is completely broken.
 */
contract AlwaysRevertingWeightModule {
    error AlwaysReverts();

    function noteFee(address, uint256) external pure {
        revert AlwaysReverts();
    }

    function noteMintPressure(address, int256) external pure {
        revert AlwaysReverts();
    }

    function noteDepth(address, uint256) external pure {
        revert AlwaysReverts();
    }

    function noteVolume(address, uint256) external pure {
        revert AlwaysReverts();
    }
}
