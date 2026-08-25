// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {MockERC20Burnable} from "./MockERC20Burnable.sol";

/// Stands in for the Uniswap V2 router's swapExactETHForTokens in
/// PlankBurnEngine's tests. It keeps the sent ETH and mints mock $PLANK to
/// `to` at a SETTABLE rate, and -- like the real router -- reverts if the
/// output is below amountOutMin. The rate is independent of the oracle's
/// pool mock, which lets a test simulate "the TWAP says the fair price is
/// X, but this execution is rigged to give less" and prove the engine's
/// oracle floor rejects it.
contract MockV2Router {
    MockERC20Burnable public immutable plank;
    uint256 public plankOutPerWei;

    constructor(address plank_, uint256 plankOutPerWei_) {
        plank = MockERC20Burnable(plank_);
        plankOutPerWei = plankOutPerWei_;
    }

    function setPlankOutPerWei(uint256 v) external {
        plankOutPerWei = v;
    }

    function swapExactETHForTokens(
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 /* deadline */
    ) external payable returns (uint256[] memory amounts) {
        uint256 out = msg.value * plankOutPerWei;
        require(out >= amountOutMin, "INSUFFICIENT_OUTPUT_AMOUNT");
        // Output token is the last in the path; the engine hardcodes it to
        // $PLANK and sets the recipient, so we just honor those.
        if (out > 0) MockERC20Burnable(path[path.length - 1]).mint(to, out);
        amounts = new uint256[](2);
        amounts[0] = msg.value;
        amounts[1] = out;
    }
}
