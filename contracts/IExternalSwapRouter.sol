// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @notice §7.11's ONE external dependency: a minimal swap venue this diamond
 * spends an already-pulled ERC-20 amount against to buy PLANK on the open
 * market, for the dev-fund allocation (design doc
 * DESIGN-N-VAULT-FACTORY-AND-VALUE-ACCRUAL-2026-08-06.md §7.11).
 *
 * @dev THE REAL PLANK VENUE IS EXTERNAL TO THIS REPO. PLANK's own market /
 * liquidity lives in the live `robinwood-plank` product, not here. This
 * interface is deliberately the smallest shape a real router needs to
 * satisfy, mirrored on `IIndexCoinPool`'s existing swap shape in this same
 * codebase rather than invented fresh, so the mechanism is real and
 * end-to-end testable in THIS repo's suite against a mock implementing this
 * interface, without requiring a live cross-repo integration.
 *
 * The concrete address behind this interface is a DEPLOYMENT-TIME PARAMETER
 * (`DevFundStorage.router`, set only through `IndexDevFundFacet`'s governed,
 * timelocked queue/execute pair) — never hardcoded anywhere in this facet
 * set. Swapping in the real PLANK router at deploy time (or later, through
 * the same timelocked path) requires no change to this interface or to any
 * facet that calls it.
 *
 * Unlike `IIndexCoinPool.swap`, this is NOT assumed to be this diamond's own
 * pool and is NOT assumed bidirectional — it only ever needs to buy PLANK
 * with an arbitrary ERC-20 `tokenIn` this diamond already holds, which is
 * the one direction §7.11 ever calls.
 */
interface IExternalSwapRouter {
    /**
     * @notice Swap `amountIn` of `tokenIn` (already approved to this router
     * by the caller) for PLANK, delivering the output directly to `to`.
     * @param tokenIn the ERC-20 being sold — a listed index constituent or
     * the payment token, whichever the caller happened to be routing.
     * @param amountIn the amount of `tokenIn` to spend, already pulled by
     * the caller and approved to this router for exactly this amount.
     * @param minPlankOut the caller's own slippage floor.
     * @param to where the bought PLANK is delivered — the dev-fund
     * treasury, in every call this codebase makes.
     * @return plankOut the amount of PLANK actually delivered to `to`.
     */
    function buyPlank(
        address tokenIn,
        uint256 amountIn,
        uint256 minPlankOut,
        address to
    ) external returns (uint256 plankOut);
}
