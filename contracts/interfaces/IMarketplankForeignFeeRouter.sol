// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {AdvancedOrder, CriteriaResolver} from "../MarketplankForeignFeeRouter.sol";

/**
 * @title IMarketplankForeignFeeRouter
 * @notice Single source of truth for the router interface both
 *         MarketplankAcrossReceiver and MarketplankDeBridgeExecutor call
 *         through. Previously duplicated inline in both of those files --
 *         a real drift risk flagged by Slither (the router should
 *         explicitly implement the interface its callers depend on, not
 *         have two independently-hand-copied definitions that could
 *         silently diverge from the real function signature). Consolidated
 *         here: MarketplankForeignFeeRouter now explicitly implements
 *         this, so a signature change that breaks callers fails to
 *         compile immediately instead of silently at the ABI-encoding
 *         boundary.
 */
interface IMarketplankForeignFeeRouter {
    function buyNowFor(
        AdvancedOrder calldata order,
        CriteriaResolver[] calldata criteriaResolvers,
        bytes32 fulfillerConduitKey,
        uint256 orderPriceWei,
        address recipient
    ) external payable;
}
