// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice The read surface a consumer (e.g. MarketplankVault) needs from a
/// drand round cache. Deliberately tiny so it can be mocked in tests without
/// mocking any cryptography.
interface IDrandBeacon {
    /// @return seconds between drand rounds (3 for drand's EVM beacon).
    function period() external view returns (uint256);

    /// @return unix timestamp of the beacon's genesis (round 0 reference).
    function genesisTimestamp() external view returns (uint256);

    /// @notice The first round whose emission time is strictly after
    /// `timestamp`. Reverts if `timestamp` predates genesis.
    function nextRoundAfter(uint256 timestamp) external view returns (uint64);

    /// @notice The round that has most recently been emitted as of `timestamp`
    /// (0 before genesis, since no round exists yet). Never reverts for
    /// timestamps below genesis.
    /// @dev drand's own convention: round 1 is published AT genesis, so this is
    /// floor((t - genesis)/period) + 1 — NOT floor(...) alone.
    function currentRoundAt(uint256 timestamp) external view returns (uint64);

    /// @notice Has a valid signature for `round` been relayed and verified?
    function isRoundAvailable(uint64 round) external view returns (bool);

    /// @notice The verified randomness for `round`. Reverts if unavailable —
    /// it must be impossible to read 0 and mistake it for a value.
    function randomnessAt(uint64 round) external view returns (bytes32);

    /// @notice The verified randomness for `round`, or bytes32(0) if the round
    /// has not been relayed. Lets a consumer collapse the availability check
    /// and the read into a single external call; callers MUST treat zero as
    /// "not available" and never draw from it.
    function randomnessOrZero(uint64 round) external view returns (bytes32);
}
