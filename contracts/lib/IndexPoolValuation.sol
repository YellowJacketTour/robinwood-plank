// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/**
 * ============================================================================
 *  IndexPoolValuation — the closed-form NAV solve for a sole-LP,
 *  protocol-owned index-coin/payment-token pool (design doc §7.10, blocker 1
 *  resolution, 2026-08-06 task brief).
 *
 *  THE CIRCULARITY, AND WHY IT IS TRACTABLE HERE
 *  ----------------------------------------------
 *  The pool holds `C` units of the index coin itself, and the index coin's
 *  own value is `V / S` (total reserve value over total supply) — so the
 *  pool's contribution to `V` depends on `V`. That circularity is normally
 *  unsolvable for a pool with third-party LPs, because a third party's claim
 *  on the pool's reserves would need to be priced too. It IS solvable here,
 *  in closed form, because `IndexCoinPool` is confirmed sole-LP,
 *  protocol-owned-only — no LP token is ever minted to anyone — so the
 *  pool's entire reserve is either (a) payment token, valued 1:1, or (b)
 *  index coin, valued at the SAME `V/S` this function is solving for. Let:
 *
 *      B = value of every OTHER reserve band (every listed constituent,
 *          excluding the pool)
 *      E = the pool's own payment-token reserve (already ETH-equivalent)
 *      C = the pool's own index-coin reserve
 *      S = total index-coin supply
 *
 *  Then V = B + E + (C/S)*V  =>  V*(1 - C/S) = B + E
 *                              =>  V = (B + E) * S / (S - C)
 *
 *  which is exactly the formula the task brief specifies. `S - C > 0` always
 *  holds in practice — the pool can never hold the entire outstanding supply,
 *  because every unit of `C` it ever receives was paired 1:1 in value with a
 *  same-transaction payment-token deposit that also grew `S` — but it is
 *  checked rather than assumed, and division is guarded against a
 *  division-by-zero at `S == C`.
 *
 *  PURE AND STATELESS. Reads only the numbers the caller passes in — the
 *  pool's LIVE reserves, read fresh on every call by `IndexFacetBase._nav`
 *  through `IIndexCoinPool.getReserves()` — never a cached or self-reported
 *  figure, which is the other half of blocker 1's resolution.
 * ============================================================================
 */
library IndexPoolValuation {
    /// @dev Re-declared per this codebase's own convention (see
    /// `IndexValuation`'s identical note): no compile-time dependency on the
    /// vault, selectors match by name.
    error PoolOwnsEntireSupply();

    /**
     * @notice Fold the pool's own live position into a NAV band already
     * computed over every OTHER reserve band.
     * @param otherLow the existing basket's NAV_low (`B`, low band)
     * @param otherHigh the existing basket's NAV_high (`B`, high band)
     * @param poolPayment the pool's live payment-token reserve (`E`)
     * @param poolCoin the pool's live index-coin reserve (`C`)
     * @param totalSupply the index coin's live total supply (`S`)
     */
    function includePool(
        uint256 otherLow,
        uint256 otherHigh,
        uint256 poolPayment,
        uint256 poolCoin,
        uint256 totalSupply
    ) internal pure returns (uint256 low, uint256 high) {
        // An un-deployed or momentarily-empty pool contributes nothing — the
        // formula degenerates to V = B exactly at E == C == 0, so this early
        // return is an optimisation, not a special case.
        if (poolPayment == 0 && poolCoin == 0) return (otherLow, otherHigh);
        if (totalSupply <= poolCoin) revert PoolOwnsEntireSupply();
        uint256 denom = totalSupply - poolCoin;
        low = Math.mulDiv(otherLow + poolPayment, totalSupply, denom);
        high = Math.mulDiv(otherHigh + poolPayment, totalSupply, denom);
    }
}
