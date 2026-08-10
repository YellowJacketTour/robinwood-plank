// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface IWrappedIndexShareLike {
    function deposit(uint256 rawSharesIn) external returns (uint256);

    function withdraw(uint256 wrappedIn) external returns (uint256, uint256);

    function balanceOf(address) external view returns (uint256);
}

/**
 * @dev Test-only. The ATOMIC version of the "lone-staker vault drain": wrap
 * into an empty wrapper and unwrap again inside ONE transaction, to prove the
 * zero-denominator carry cannot be round-tripped out by a contract. A
 * transaction boundary is the strongest form of the attack — nothing else can
 * be interleaved and no other holder can join — which is exactly why the
 * carry's release is keyed to a BLOCK.
 *
 * LOCAL HARDHAT ONLY.
 */
contract MockFlashWrapAttacker {
    function attack(address wrapper, address rawShare, uint256 rawIn) external {
        IERC20(rawShare).transferFrom(msg.sender, address(this), rawIn);
        IERC20(rawShare).approve(wrapper, type(uint256).max);
        IWrappedIndexShareLike(wrapper).deposit(rawIn);
        uint256 w = IWrappedIndexShareLike(wrapper).balanceOf(address(this));
        IWrappedIndexShareLike(wrapper).withdraw(w);
    }

    function sweep(address token, address to) external {
        IERC20(token).transfer(to, IERC20(token).balanceOf(address(this)));
    }
}
