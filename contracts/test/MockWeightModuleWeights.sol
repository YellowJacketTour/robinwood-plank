// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @notice Test-only stand-in for PR1's `WeightModule.weights()` view, used to
 * drive `InventoryBuyAdapter.execute()` against a single vault at 100% weight
 * without needing the real `WeightModule`'s `onlyFactoryVault`/admission
 * machinery. Configured once at construction, immutable thereafter.
 */
contract MockWeightModuleWeights {
    address[] private _vaults;
    uint256[] private _wBps;

    constructor(address vault_, uint256 wBps_) {
        _vaults.push(vault_);
        _wBps.push(wBps_);
    }

    function weights() external view returns (address[] memory vaults, uint256[] memory wBps) {
        return (_vaults, _wBps);
    }
}
