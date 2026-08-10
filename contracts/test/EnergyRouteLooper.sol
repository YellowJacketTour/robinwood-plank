// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IEnergyBus} from "../energy/IEnergyBus.sol";

/**
 * ============================================================================
 *  EnergyRouteLooper — TEST-ONLY attacker harness for AUDIT H-5.
 *
 *  This is the H-5 attack expressed as the smallest contract that can express
 *  it: call `EnergyBus.route()` N times SEQUENTIALLY inside ONE transaction.
 *
 *  Note it does NOT reenter. Each `route()` returns before the next begins, so
 *  the Bus's `nonReentrant` guard never fires — which is precisely why the
 *  reentrancy guard was never a defence against H-5, and why a per-call cap on
 *  a permissionless, unlimited-frequency function is a step size rather than a
 *  limit. This is the same shape as Balancer's Nov-2025 $128.64M loss, where
 *  65 individually sub-threshold operations compounded inside one `batchSwap`.
 *
 *  Deployed only by `test/contracts/energy/*.test.ts`. Never part of any
 *  production deployment.
 * ============================================================================
 */
contract EnergyRouteLooper {
    /// @notice Calls `route()` `iterations` times in this one transaction and
    /// reports the aggregate the Bus admitted, so a test can assert the
    /// CUMULATIVE figure rather than any single call's figure.
    function loopRoute(address bus, uint256 iterations) external returns (uint256 totalSpent) {
        for (uint256 i = 0; i < iterations; i++) {
            totalSpent += IEnergyBus(bus).route();
        }
    }
}
