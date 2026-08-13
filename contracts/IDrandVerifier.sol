// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// Minimal interface implemented by DrandBLSVerifier -- kept separate so
/// PlankCrashDrand.sol depends only on this shape, letting tests swap in
/// a mock for game-logic coverage while the real BLS cryptography is
/// proven independently against real, historical drand signatures (see
/// test/contracts/DrandBLSVerifier.test.ts).
interface IDrandVerifier {
    function verifyRound(uint64 round, uint256[2] calldata signature) external view returns (bool);
}
