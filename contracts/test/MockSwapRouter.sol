// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {MockERC20Burnable} from "./MockERC20Burnable.sol";

interface IWethLike {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

/// Stands in for a real V3 SwapRouter's `exactInput` in PlankBurnEngine's
/// tests. It PULLS the approved WETH from the caller (the engine) and mints
/// mock PLANK to `params.recipient` -- proving the engine's recipient
/// choice, not the caller's, decides where output lands. It deliberately
/// exposes NO way for a caller to redirect funds, which is the whole point
/// of moving off the general Universal Router.
contract MockSwapRouter {
    struct ExactInputParams {
        bytes path;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
    }

    MockERC20Burnable public immutable plank;
    IWethLike public immutable weth;
    uint256 public plankOutPerWei;

    constructor(address plank_, address weth_, uint256 plankOutPerWei_) {
        plank = MockERC20Burnable(plank_);
        weth = IWethLike(weth_);
        plankOutPerWei = plankOutPerWei_;
    }

    function setPlankOutPerWei(uint256 v) external {
        plankOutPerWei = v;
    }

    function exactInput(ExactInputParams calldata params) external payable returns (uint256 amountOut) {
        // Pull the WETH the engine approved -- exactly like a real router.
        weth.transferFrom(msg.sender, address(this), params.amountIn);
        amountOut = params.amountIn * plankOutPerWei;
        require(amountOut >= params.amountOutMinimum, "Too little received");
        if (amountOut > 0) {
            // Output always goes to the recipient the CALLER-CONTRACT set,
            // which PlankBurnEngine hardcodes to itself.
            plank.mint(params.recipient, amountOut);
        }
    }
}
