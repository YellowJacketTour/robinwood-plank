// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @notice Test-only stand-in for a constituent `CollectionVault` as the ZAP
 * sees it: the `ICollectionVaultZap` surface plus a realizable curve, backed by
 * a real internal constant-product pool.
 *
 * ITS ONE SPECIAL POWER: `shortBps`. `buyShares` RETURNS the honest
 * constant-product output while TRANSFERRING `(1 - shortBps)` of it. That is
 * the exact shape audit H-2 describes — a leg that self-reports one number and
 * delivers another — and it is the only way to prove the zap now credits an
 * OBSERVED BALANCE DELTA rather than the amount it computed it wanted. With
 * `shortBps == 0` the mock is perfectly honest, which is the control: the same
 * zap must succeed.
 *
 * Any ERC-20 with a transfer fee, any AMM with a rounding shortfall, and any
 * vault whose `buyShares` under-delivers for any reason is behaviourally
 * identical to this mock from the diamond's side.
 *
 * LOCAL HARDHAT ONLY.
 */
contract MockZapVault is ERC20 {
    uint256 private constant BPS = 10_000;

    IERC20 public immutable payment;
    uint256 public paymentReserve;
    uint256 public shareReserve;
    uint256 public swapFeeBps = 100;
    bool public poolOpen = true;
    /// @notice Fraction of each `buyShares` output that is REPORTED but never
    /// transferred. 0 = honest.
    uint256 public shortBps;

    constructor(string memory n, string memory s, address payment_) ERC20(n, s) {
        payment = IERC20(payment_);
    }

    function paymentToken() external view returns (address) {
        return address(payment);
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setShortBps(uint256 bps) external {
        shortBps = bps;
    }

    /// @dev Seed the internal pool. `shareReserve` is virtual (this contract
    /// mints on demand), exactly as a real vault's pooled inventory behaves
    /// from a swapper's point of view.
    function seedPool(uint256 payment_, uint256 share_) external {
        payment.transferFrom(msg.sender, address(this), payment_);
        paymentReserve = payment_;
        shareReserve = share_;
    }

    function _out(uint256 amountIn) private view returns (uint256) {
        uint256 inNet = (amountIn * (BPS - swapFeeBps)) / BPS;
        return (inNet * shareReserve) / (paymentReserve + inNet);
    }

    function quoteBuyShares(uint256 amountIn) external view returns (uint256) {
        if (amountIn == 0 || paymentReserve == 0 || shareReserve == 0) return 0;
        return _out(amountIn);
    }

    function quoteSellShares(uint256 sharesIn) external view returns (uint256) {
        if (sharesIn == 0 || paymentReserve == 0 || shareReserve == 0) return 0;
        uint256 inNet = (sharesIn * (BPS - swapFeeBps)) / BPS;
        return (inNet * paymentReserve) / (shareReserve + inNet);
    }

    function buyShares(uint256 amountIn, uint256 minSharesOut) external returns (uint256 sharesOut) {
        payment.transferFrom(msg.sender, address(this), amountIn);
        sharesOut = _out(amountIn);
        require(sharesOut >= minSharesOut, "min");
        paymentReserve += amountIn;
        shareReserve -= sharesOut;
        // The lie: report `sharesOut`, deliver less.
        _mint(msg.sender, (sharesOut * (BPS - shortBps)) / BPS);
    }

    function sellShares(uint256 sharesIn, uint256 minAmountOut) external returns (uint256 amountOut) {
        _burn(msg.sender, sharesIn);
        uint256 inNet = (sharesIn * (BPS - swapFeeBps)) / BPS;
        amountOut = (inNet * paymentReserve) / (shareReserve + inNet);
        require(amountOut >= minAmountOut, "min");
        shareReserve += sharesIn;
        paymentReserve -= amountOut;
        payment.transfer(msg.sender, amountOut);
    }
}
