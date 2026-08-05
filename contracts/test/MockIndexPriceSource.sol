// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IIndexPriceSource} from "../IIndexPriceSource.sol";

/**
 * @notice Test-only constant-product price source wearing the exact interface
 * MarketplankVaultV3 already satisfies, so a constituent's price can be moved
 * deliberately in a test the way a real thin pool would move under attack.
 * Never deployed anywhere real.
 */
contract MockIndexPriceSource is IIndexPriceSource {
    uint256 public ethReserve;
    uint256 public shareReserve;

    constructor(uint256 eth_, uint256 share_) {
        ethReserve = eth_;
        shareReserve = share_;
    }

    function setReserves(uint256 eth_, uint256 share_) external {
        ethReserve = eth_;
        shareReserve = share_;
    }

    /// @notice Move the implied price by a multiplier in bps (10000 = no move).
    function scalePrice(uint256 bps) external {
        ethReserve = (ethReserve * bps) / 10_000;
    }
}
