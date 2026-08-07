// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @notice Test-only stand-in for a constituent v-token, following the same
 * "mint freely, never deployed anywhere real" pattern as MockWeth.sol.
 * Adds an optional fee-on-transfer mode so the Balancer-STA class of bug
 * (crediting nominal instead of actual received amount) can be exercised
 * against GlobalIndexVault directly.
 */
contract MockIndexToken is ERC20 {
    uint256 public feeBps;

    constructor(string memory n, string memory s) ERC20(n, s) {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    /// @notice Burn a fraction of every transfer, like a real fee-on-transfer
    /// token. 0 (the default) makes this a plain ERC-20.
    function setFeeBps(uint256 bps) external {
        require(bps < 10_000, "fee");
        feeBps = bps;
    }

    function _transfer(address from, address to, uint256 amount) internal override {
        uint256 fee = (amount * feeBps) / 10_000;
        if (fee > 0) {
            super._transfer(from, address(0xdead), fee);
        }
        super._transfer(from, to, amount - fee);
    }
}
