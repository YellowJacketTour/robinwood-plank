// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// TEST ONLY. NEVER DEPLOY. Differential-harness sink for PlankCrashDrand's
/// _spillOverflow: fund() can be toggled to revert so both the success path
/// (reserve = cap, sink balance += excess) and the FAILURE path (excess
/// RETAINED in the Vault) are exercised against the real contract.
contract ToggleableJackpotSink {
    bool public reverting;
    uint256 public totalFunded;

    error SinkDisabled();

    function setReverting(bool v) external {
        reverting = v;
    }

    function fund() external payable {
        if (reverting) revert SinkDisabled();
        totalFunded += msg.value;
    }
}
