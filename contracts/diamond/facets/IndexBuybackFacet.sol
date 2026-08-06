// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {IndexFacetBase} from "./IndexFacetBase.sol";
import {CoreStorage, PoolStorage, ValueAccrualStorage} from "../storage/IndexStorage.sol";
import {IIndexCoinPool} from "../../IIndexCoinPool.sol";

/**
 * ============================================================================
 *  IndexBuybackFacet — §7.7 "buyback-and-lock" (design doc
 *  DESIGN-N-VAULT-FACTORY-AND-VALUE-ACCRUAL-2026-08-06.md §7.7).
 *
 *  NOT FOR DEPLOYMENT except as a facet.
 *
 *  WHAT THIS FILE IS. The ONE spend path over §7.3's already-earmarked,
 *  already-timelocked buyback bucket (`ValueAccrualStorage.buybackEarmarkWei`
 *  — reserved, but deliberately left unspent, by `IndexFacetBase._creditRoutedValue`
 *  when §7.3 shipped). No new bucket is created here: this facet only ever
 *  draws down a slot that `_creditRoutedValue` already carved out of routed
 *  value BEFORE it ever reached `c.reserve`, so spending it can never make
 *  redemption value go down — the spent value was never part of NAV in the
 *  first place (same footing as the dividend leg it sits alongside).
 *
 *  WHY ONLY THE PAYMENT-TOKEN EARMARK. `buybackEarmarkWei` is keyed per
 *  routed token (design doc §7.3: "token-agnostic, a pure accounting slot"),
 *  because routed value can arrive denominated in any constituent's own
 *  share token. The dedicated pool (§7.10, `IndexCoinPool`) trades ONLY
 *  payment-token against index coin — it holds no other asset — so a
 *  buyback can only ever be funded from the slice of the earmark
 *  denominated in `CoreStorage.dividendAsset` (the payment token). Earmark
 *  accrued in any other constituent's own token is left untouched by this
 *  facet; it is not lost, merely not yet spendable against THIS pool.
 *
 *  THE LOCK. Bought coin is sent to `SEED_LOCK_ADDR` — the SAME dead address
 *  `IndexBootstrapFacet.seedDeposit` already locks the genesis seed shares
 *  to, not a new address and not a burn. That is deliberate: `SEED_LOCK_ADDR`
 *  is already the one place this codebase treats "permanently unredeemable
 *  supply" specially (`IndexFacetBase._creditDividends`'s `seedBal`
 *  exclusion from the EIP-2222 eligible-supply denominator), and buyback-
 *  locked coin is conceptually the identical thing — this facet reuses that
 *  mechanism rather than inventing a second one. `_nav()` and
 *  `redeemProRata`/`redeemSingleAsset` are UNCHANGED by this file: they
 *  divide by raw `totalSupply()` exactly as they did before buyback-locked
 *  coin existed, exactly as they already did for the seed lock — coin sent
 *  here is real supply that will simply never be redeemed, which is what
 *  raises every remaining circulating coin's ACTUAL claim on `totalReserveValue`
 *  over time, without any denominator ever needing to name the lock address.
 *
 *  THE CEILING. `ValueAccrualStorage.buybackBps` — the governed rate this
 *  earmark accrues at — is hard-capped in bytecode
 *  (`IndexFacetBase.CEIL_BUYBACK_SPLIT_BPS`, enforced by
 *  `IndexGovernanceFacet._applyValueAccrualSplit`), so the real risk §7.7
 *  itself names (a comparable protocol routing 100% of fees to buybacks) is
 *  closed at the SOURCE, before value ever reaches this facet's earmark —
 *  this file has nothing further to bound.
 *
 *  THE SAME-BLOCK GUARD. `_requirePoolQuiescent()` — the identical guard
 *  `IndexPoolFacet.deployToIndexPool` already uses — is checked before the
 *  swap. A `swap` is itself a pool action, so this is what makes "an
 *  attacker cannot manipulate the pool and trigger a buyback against the
 *  distorted price in the same transaction" a proven property rather than
 *  an assumption: any pool action earlier in the SAME BLOCK (necessarily
 *  earlier in the same transaction, since a permissionless buyback and an
 *  attacker's own swap cannot both be the first pool action of a block)
 *  reverts this call outright.
 * ============================================================================
 */
contract IndexBuybackFacet is IndexFacetBase {
    using SafeERC20 for IERC20;

    event BuybackExecuted(address indexed caller, uint256 paymentIn, uint256 coinOut);

    /// @dev Distinct from `InsufficientPoolFunding` (§7.10's constituent-
    /// depth ceiling): this is a DIFFERENT reserve — the buyback earmark,
    /// never a constituent's `c.reserve` — so it gets its own name rather
    /// than overloading an error whose existing tests assert it means
    /// "not enough constituent reserve".
    error InsufficientBuybackEarmark();

    /// @notice The payment-token slice of the buyback earmark actually
    /// spendable against the dedicated pool right now.
    function buybackEarmarkAvailable() external view returns (uint256) {
        return ValueAccrualStorage.layout().buybackEarmarkWei[CoreStorage.layout().dividendAsset];
    }

    /**
     * @notice Spend up to `paymentIn` of the payment-token buyback earmark
     * buying index coin from the dedicated pool, and permanently lock every
     * unit bought. Permissionless — anyone may trigger a buyback; nobody
     * chooses where the bought coin goes, and nobody can spend past what
     * governance has actually earmarked.
     *
     * @param paymentIn payment-token amount to spend, capped at the current
     * earmark — never a caller-inflatable figure.
     * @param minCoinOut the caller's own slippage floor, passed straight
     * through to `IndexCoinPool.swap` — the identical permissionless swap
     * every other trader on this pool uses, priced with the pool's own 1%
     * fee, no favorable route.
     */
    function executeBuyback(uint256 paymentIn, uint256 minCoinOut)
        external
        nonReentrant
        whenOpen
        returns (uint256 coinOut)
    {
        if (paymentIn == 0) revert ZeroAmount();
        address pool = PoolStorage.layout().pool;
        if (pool == address(0)) revert BadParam();
        _requirePoolQuiescent();

        address paymentToken = CoreStorage.layout().dividendAsset;
        ValueAccrualStorage.Layout storage va = ValueAccrualStorage.layout();
        uint256 earmark = va.buybackEarmarkWei[paymentToken];
        if (paymentIn > earmark) revert InsufficientBuybackEarmark();
        va.buybackEarmarkWei[paymentToken] = earmark - paymentIn; // effects before interactions

        // The allowance is granted for exactly `paymentIn` and asserted
        // consumed afterwards — the same discipline
        // `IndexDividendFacet.harvestEcosystemFees` already uses, so this
        // facet never leaves a standing approval over the payment-token
        // balance backing every constituent's own reserve.
        IERC20(paymentToken).forceApprove(pool, paymentIn);
        coinOut = IIndexCoinPool(pool).swap(true, paymentIn, minCoinOut, address(this));
        if (IERC20(paymentToken).allowance(address(this), pool) != 0) revert ApprovalNotConsumed();

        // The lock: an internal balance move to the SAME dead address the
        // genesis seed shares already sit at, never a new mechanism. See
        // this file's header for why no NAV/redeem denominator needs to
        // change for this to work.
        _transferShares(address(this), SEED_LOCK_ADDR, coinOut);

        emit BuybackExecuted(msg.sender, paymentIn, coinOut);
    }
}
