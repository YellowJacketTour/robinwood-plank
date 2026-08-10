// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @notice TEST-ONLY. A `CollectionVault`-shaped share pool whose `buyShares`
 * deliberately fills at `fillBps` of its OWN `quoteBuyShares` figure.
 *
 * WHY THIS EXISTS. Audit C-2's second half was that `buyShares(budget, 0)`
 * passed `minSharesOut = 0`, so there was no slippage defence at all. Proving
 * the fix requires a venue whose fill can be made to diverge from its quote —
 * the real `CollectionVault` cannot, by construction, since its quote is
 * derived from the same formula its swap uses. Without this mock, a test
 * asserting "minSharesOut is real" would be unable to fail, which is exactly
 * the class of hollow proof the audit's meta-finding called out.
 */
contract MockShortFillVault is ERC20 {
    using SafeERC20 for IERC20;

    IERC20 public immutable payment;
    uint256 public paymentReserve;
    uint256 public shareReserve;
    uint256 public fillBps;

    error ShortFill();

    constructor(address payment_, uint256 fillBps_) ERC20("Mock Share", "mS") {
        payment = IERC20(payment_);
        fillBps = fillBps_;
        paymentReserve = 100 ether;
        shareReserve = 100 ether;
        _mint(address(this), 100 ether);
    }

    function setFillBps(uint256 v) external {
        fillBps = v;
    }

    function poolOpen() external pure returns (bool) {
        return true;
    }

    function quoteBuyShares(uint256 amountIn) public view returns (uint256) {
        if (amountIn == 0 || paymentReserve == 0 || shareReserve == 0) return 0;
        return (amountIn * shareReserve) / (paymentReserve + amountIn);
    }

    function buyShares(uint256 amountIn, uint256 minSharesOut) external returns (uint256 sharesOut) {
        payment.safeTransferFrom(msg.sender, address(this), amountIn);
        sharesOut = (quoteBuyShares(amountIn) * fillBps) / 10_000;
        if (sharesOut < minSharesOut) revert ShortFill();
        paymentReserve += amountIn;
        shareReserve -= sharesOut;
        _transfer(address(this), msg.sender, sharesOut);
    }
}
