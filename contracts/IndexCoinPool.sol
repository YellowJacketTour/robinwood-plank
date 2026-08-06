// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * ============================================================================
 *  IndexCoinPool — the index coin's dedicated market (design doc §7.10).
 *
 *  A minimal constant-product AMM (payment/ETH-equivalent token vs index
 *  coin), PROTOCOL-OWNED ONLY: no LP token is ever minted, to anyone, ever.
 *  The sole liquidity provider is `owner` (the index diamond), and that is
 *  what makes the closed-form NAV solve in `IndexPoolValuation` tractable —
 *  there is no third-party claim on the pool's reserves to account for.
 *
 *  STANDALONE CONTRACT, NOT A FACET. It is referenced by address from the
 *  diamond (`PoolStorage.layout().pool`) exactly the way a constituent's
 *  `IIndexPriceSource` is — an external contract the diamond calls into, never
 *  something cut into the diamond's own selector table. `LibBytecodeScan`'s
 *  DELEGATECALL ban and the 24,576-byte facet ceiling therefore do not apply
 *  to this file at all; it is sized and reviewed as its own contract.
 *
 *  FEE COMPOUNDING. Standard Uniswap-V2-style fee-on-input: the 1% swap fee
 *  is deducted only from the OUTPUT-side pricing math, while the FULL input
 *  amount is credited to the input reserve. The fee therefore never leaves
 *  the pool and is never distributed anywhere — it mechanically deepens both
 *  reserves for the next trade, which is the whole of "compounds directly
 *  back into its own reserve" from design doc §7.10 rule 3.
 * ============================================================================
 */
contract IndexCoinPool {
    using SafeERC20 for IERC20;

    IERC20 public immutable paymentToken;
    IERC20 public immutable indexCoin;

    /// @notice The index diamond. The ONLY address that may ever call
    /// `deploy` — there is no other liquidity-adding path, and no LP token
    /// anywhere in this contract for anyone (owner included) to redeem.
    address public immutable owner;

    uint256 public reservePayment;
    uint256 public reserveCoin;

    uint256 public constant FEE_BPS = 100; // 1%, at parity with the per-vault default (§7.10 rule 3)
    uint256 public constant BPS = 10_000;

    /// @notice The block number of the most recently completed reserve-moving
    /// action (a swap OR a `deploy`). Read by the diamond as the same-block
    /// staleness guard design doc §7.10's test-5 requires: a valuation read
    /// taken in the same block as a reserve-moving pool action is refused by
    /// the caller (`IndexFacetBase._requirePoolQuiescent`), not by this
    /// contract — this is simply where the timestamp of record lives.
    uint256 public lastActionBlock;

    error NotOwner();
    error ZeroAmount();
    error InsufficientOutput();
    error InsufficientLiquidity();

    event Deployed(uint256 paymentIn, uint256 coinIn);
    event Swapped(address indexed sender, bool paymentIn, uint256 amountIn, uint256 amountOut);

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(address _paymentToken, address _indexCoin, address _owner) {
        paymentToken = IERC20(_paymentToken);
        indexCoin = IERC20(_indexCoin);
        owner = _owner;
    }

    function getReserves() external view returns (uint256, uint256) {
        return (reservePayment, reserveCoin);
    }

    /**
     * @notice Owner-only (the diamond): register protocol-owned liquidity
     * the owner has ALREADY physically transferred to this pool in the same
     * transaction, before calling this. Balance-delta measured — the same
     * "credit only what has already, physically, verifiably arrived"
     * discipline `IndexBootstrapFacet._sync` already uses — rather than a
     * `transferFrom` pull, so the caller never needs to grant this pool an
     * allowance over its own unified share token (a `transferFrom` pull of
     * the DIAMOND'S OWN ERC-20 by an external contract mid-facet-call is an
     * avoidable self-referential approve/pull loop; a push-then-register is
     * not). No LP token is minted — this call only ever increases
     * `reservePayment`/`reserveCoin`, and nothing else in this contract
     * records any claim on them.
     */
    function deploy(uint256 minPaymentIn, uint256 minCoinIn)
        external
        onlyOwner
        returns (uint256 paymentIn, uint256 coinIn)
    {
        uint256 balP = paymentToken.balanceOf(address(this));
        uint256 balC = indexCoin.balanceOf(address(this));
        paymentIn = balP - reservePayment;
        coinIn = balC - reserveCoin;
        if (paymentIn == 0 || coinIn == 0 || paymentIn < minPaymentIn || coinIn < minCoinIn) revert ZeroAmount();
        reservePayment = balP;
        reserveCoin = balC;
        lastActionBlock = block.number;
        emit Deployed(paymentIn, coinIn);
    }

    /**
     * @notice Permissionless constant-product swap. Anyone may trade against
     * this pool in either direction — this IS the index coin's market
     * (§7.10 rule 4): the venue a holder sells into for ETH outside the
     * dividend-claim mechanism, and the venue §7.7's buyback buys from.
     */
    function swap(
        bool paymentIn,
        uint256 amountIn,
        uint256 minAmountOut,
        address to
    ) external returns (uint256 amountOut) {
        if (amountIn == 0) revert ZeroAmount();
        if (reservePayment == 0 || reserveCoin == 0) revert InsufficientLiquidity();

        uint256 amountInWithFee = amountIn * (BPS - FEE_BPS);
        if (paymentIn) {
            amountOut = (amountInWithFee * reserveCoin) / (reservePayment * BPS + amountInWithFee);
            if (amountOut < minAmountOut || amountOut == 0) revert InsufficientOutput();
            paymentToken.safeTransferFrom(msg.sender, address(this), amountIn);
            reservePayment += amountIn;
            reserveCoin -= amountOut;
            indexCoin.safeTransfer(to, amountOut);
        } else {
            amountOut = (amountInWithFee * reservePayment) / (reserveCoin * BPS + amountInWithFee);
            if (amountOut < minAmountOut || amountOut == 0) revert InsufficientOutput();
            indexCoin.safeTransferFrom(msg.sender, address(this), amountIn);
            reserveCoin += amountIn;
            reservePayment -= amountOut;
            paymentToken.safeTransfer(to, amountOut);
        }
        lastActionBlock = block.number;
        emit Swapped(msg.sender, paymentIn, amountIn, amountOut);
    }
}
