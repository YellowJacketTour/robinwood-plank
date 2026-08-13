// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {MockERC20Burnable} from "./MockERC20Burnable.sol";

/// Stands in for the real Uniswap Universal Router in
/// PlankBurnEngine.test.ts: simulates a real ETH->PLANK swap by minting
/// a configurable amount of mock PLANK to whoever calls execute() (the
/// burn engine), simply keeping the ETH sent. Real command/input bytes
/// are accepted but ignored -- this contract exists to test
/// PlankBurnEngine's OWN balance-delta/burn logic, not to re-implement
/// Universal Router's real routing, which is real, external, and
/// already used elsewhere in this codebase's frontend layer.
contract MockUniversalRouter {
    MockERC20Burnable public immutable plank;
    // plankOutPerWei == 0 means "simulate a route that produces zero
    // output" -- used to test PlankBurnEngine's NoSwapOutput revert path.
    uint256 public plankOutPerWei;

    constructor(address plank_, uint256 plankOutPerWei_) {
        plank = MockERC20Burnable(plank_);
        plankOutPerWei = plankOutPerWei_;
    }

    function setPlankOutPerWei(uint256 value) external {
        plankOutPerWei = value;
    }

    function execute(bytes calldata, bytes[] calldata, uint256) external payable {
        if (plankOutPerWei > 0) {
            plank.mint(msg.sender, msg.value * plankOutPerWei);
        }
    }
}
