// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IDrandVerifier} from "../IDrandVerifier.sol";

/// Test-only stand-in for DrandBLSVerifier -- lets PlankCrashDrand.test.ts
/// exercise the surrounding game logic (round targeting, cashOut gating,
/// settlement, keeper reward, voidStaleRound, curve parity) against a
/// deterministic, caller-controlled verdict instead of needing a real
/// signature for every round. The real BLS cryptography this deliberately
/// bypasses is proven separately and for real in
/// test/contracts/DrandBLSVerifier.test.ts, using actual historical
/// drand evmnet signatures -- not asserted here.
contract MockDrandVerifier is IDrandVerifier {
    bool public nextResult = true;

    function setNextResult(bool result) external {
        nextResult = result;
    }

    function verifyRound(uint64, uint256[2] calldata) external view override returns (bool) {
        return nextResult;
    }
}
