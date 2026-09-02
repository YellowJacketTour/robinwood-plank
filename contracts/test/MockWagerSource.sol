// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// Minimal stand-in matching every real Plank Crash variant's public
/// stakeOf(roundId, player) mapping getter -- lets PlankAirdropPool.test.ts
/// set arbitrary, deterministic stakes without deploying a full crash
/// game per test.
contract MockWagerSource {
    mapping(uint256 => mapping(address => uint256)) public stakeOf;
    // Mirrors the real crash variants' finality surface (AUDIT 2026-09-02):
    // rounds below currentRoundId are finished; voided rounds took no rake.
    // Defaults make every configured stake claimable, matching the mock's
    // historical behavior, unless a test opts into non-final/voided rounds.
    uint256 public currentRoundId = type(uint256).max;
    mapping(uint256 => bool) public voided;

    function setStake(uint256 roundId, address player, uint256 amount) external {
        stakeOf[roundId][player] = amount;
    }

    function setCurrentRoundId(uint256 id) external {
        currentRoundId = id;
    }

    function setVoided(uint256 roundId, bool isVoided) external {
        voided[roundId] = isVoided;
    }
}
