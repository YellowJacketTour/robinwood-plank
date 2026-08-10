// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @notice TEST-ONLY. `MockWeightModuleWeights` plus the `windowMinDepth` view
 * the real `WeightModule` gained in Phase 3, so the adapters' depth-adaptive
 * leg cap can be exercised against a MANIPULATION-RESISTANT depth reference
 * rather than the live reserve.
 *
 * Without this, a test of "the cap is measured against windowed-minimum
 * depth" would silently exercise the live-reserve FALLBACK path and pass for
 * the wrong reason — the exact shape of hollow proof the audit's meta-finding
 * called out.
 */
contract MockWeightModuleCapped {
    address public immutable vault;
    uint256 public immutable wBpsOne;
    uint256 public windowMin;

    constructor(address vault_, uint256 wBpsOne_, uint256 windowMin_) {
        vault = vault_;
        wBpsOne = wBpsOne_;
        windowMin = windowMin_;
    }

    function setWindowMinDepth(uint256 v) external {
        windowMin = v;
    }

    function windowMinDepth(address) external view returns (uint256) {
        return windowMin;
    }

    function weights() external view returns (address[] memory vaults, uint256[] memory wBps) {
        vaults = new address[](1);
        wBps = new uint256[](1);
        vaults[0] = vault;
        wBps[0] = wBpsOne;
    }
}
