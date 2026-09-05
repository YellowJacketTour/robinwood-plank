// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @notice TEST-ONLY. A lottery whose every entry point reverts, to prove that
///         PlankCrash.settleRound can never be bricked (player money locked)
///         by its draw dependency, and that deliverOverflow restores escrow.
contract MockRevertingLottery {
    error Broken();

    function recordRound(uint256, bytes32, address) external pure {
        revert Broken();
    }

    function fund() external payable {
        revert Broken();
    }

    function quote() external pure returns (uint256, uint256, uint256) {
        return (0, 0, 0);
    }

    receive() external payable {
        revert Broken();
    }
}
