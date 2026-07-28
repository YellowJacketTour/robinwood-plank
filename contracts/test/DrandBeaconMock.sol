// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IDrandBeacon} from "../IDrandBeacon.sol";

/**
 * TEST ONLY. Never deploy.
 *
 * Implements the same round<->time schedule as DrandBeacon but lets a test
 * inject a round's randomness directly instead of relaying a real BLS
 * signature. This exists so the VAULT's behaviour (draw pinning, expiry,
 * exploit regressions) can be tested without carrying signature fixtures
 * through every case.
 *
 * The REAL cryptography is exercised separately and without any mock, in
 * test/contracts/DrandBeacon.bls.test.ts, which drives genuine BN254 BLS
 * signatures through DrandBeacon.submitRound.
 */
contract DrandBeaconMock is IDrandBeacon {
    uint256 public immutable override period;
    uint256 public immutable override genesisTimestamp;

    mapping(uint64 => bytes32) private _randomness;

    error RoundNotAvailable();
    error BeforeGenesis();

    constructor(uint256 period_, uint256 genesis_) {
        period = period_;
        genesisTimestamp = genesis_;
    }

    /// @dev Test-only injection. Stands in for a verified relay.
    function setRandomness(uint64 round, bytes32 value) external {
        _randomness[round] = value;
    }

    /// @dev Mirrors DrandBeacon exactly, including drand's real +1: round 1 is
    /// published AT genesis. If this drifts from the real contract the vault
    /// suites stop testing the schedule that ships.
    function currentRoundAt(uint256 timestamp) public view override returns (uint64) {
        if (timestamp < genesisTimestamp) return 0;
        return uint64((timestamp - genesisTimestamp) / period) + 1;
    }

    function nextRoundAfter(uint256 timestamp) external view override returns (uint64) {
        if (timestamp < genesisTimestamp) revert BeforeGenesis();
        return currentRoundAt(timestamp) + 1;
    }

    function isRoundAvailable(uint64 round) external view override returns (bool) {
        return _randomness[round] != bytes32(0);
    }

    function randomnessAt(uint64 round) external view override returns (bytes32) {
        bytes32 r = _randomness[round];
        if (r == bytes32(0)) revert RoundNotAvailable();
        return r;
    }

    function randomnessOrZero(uint64 round) external view override returns (bytes32) {
        return _randomness[round];
    }
}
