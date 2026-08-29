// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * TEST ONLY. Never deploy.
 *
 * A malicious payoutRedirect sink for PlankCrashDrand: on receiving a
 * winner's push (creditFor), it tries to re-enter claim() for the same
 * (round, player). PlankCrashDrand's nonReentrant guard must make that
 * inner call revert -- the winner is paid exactly once.
 */
interface IReentrantTarget {
    function claim(uint256 roundId, address player) external;
}

contract MockReentrantSink {
    uint256 public attempts;
    bool public innerSucceeded;

    function creditFor(address player) external payable {
        attempts += 1;
        // Re-enter the caller (the crash game).
        try IReentrantTarget(msg.sender).claim(_round, player) {
            innerSucceeded = true;
        } catch {
            // expected: ReentrancyGuard
        }
        // Keep the ETH (a reverting sink would roll back `attempts` too):
        // the test asserts the inner re-entry failed and no double-pay
        // happened. The escrow-fallback path is covered by a sink with no
        // creditFor at all.
    }

    uint256 private _round;

    function arm(uint256 roundId) external {
        _round = roundId;
    }
}
