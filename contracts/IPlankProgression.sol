// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// Minimal read/write surface PlankCrashDrand, PlankFuelBooster, and
/// PlankPowerboard each need against a deployed PlankProgression -- kept as
/// its own interface (matching this repo's existing IDrandBeacon pattern)
/// rather than importing the concrete contract, so none of the three
/// callers need to compile against PlankProgression's full implementation.
interface IPlankProgression {
    function capFor(address player) external view returns (uint256);
    function premiumBpsFor(address player, uint256 stakeWei) external view returns (uint256);
    function recordBet(address player, uint256 stakeWei) external;
    function recordFuelBurn(address player) external;
    function recordPowerboardClaim(address player) external;
}
