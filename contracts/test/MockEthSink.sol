// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// Generic ETH-accepting stand-in used where PlankRakeDistributor.test.ts
/// needs a destination that isn't the real PlankBurnEngine/PlankAirdropPool
/// (those have their own dedicated test suites). Implements fund() too,
/// matching IPlankAirdropPool's shape, so it can stand in for either
/// destination.
contract MockEthSink {
    event Received(uint256 amount);

    receive() external payable {
        emit Received(msg.value);
    }

    function fund() external payable {
        emit Received(msg.value);
    }
}
