// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// Minimal stand-in matching every real Plank Crash variant's public
/// stakeOf(roundId, player) mapping getter -- lets PlankAirdropPool.test.ts
/// set arbitrary, deterministic stakes without deploying a full crash
/// game per test.
contract MockWagerSource {
    mapping(uint256 => mapping(address => uint256)) public stakeOf;

    function setStake(uint256 roundId, address player, uint256 amount) external {
        stakeOf[roundId][player] = amount;
    }
}
