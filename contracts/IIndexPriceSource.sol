// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title IIndexPriceSource
 * @notice The ONE shape every Global Index constituent must expose to be
 * priceable. Deliberately minimal: a constant-product pool's two reserves.
 *
 * `MarketplankVaultV3` satisfies this natively (`ethReserve()` /
 * `shareReserve()` are already public), which is the point — the index prices
 * a v-token by reading the v-token's own vault's real reserves, exactly the
 * "read-through, oracle-free" model SPEC-PLANK-CHECKS-AND-INDEX.md §2.1
 * requires ("an index token's price is math over other vaults' math, all the
 * way down to real reserves, never a number a human enters").
 *
 * PLANK, if it is ever a constituent, is priced through a PLANK/ETH pool
 * wearing this same interface and NOTHING ELSE. There is deliberately no
 * second, privileged price path in this codebase for PLANK — see
 * SPEC-GLOBAL-INDEX-ULTIMATE-FORM.md §2 and SPEC-PLANK-CHECKS-AND-INDEX.md
 * §2.5. Everything is ETH-denominated; PLANK is never a pricing input for
 * anything else.
 */
interface IIndexPriceSource {
    /// @notice ETH (wei) side of the constituent's own pool.
    function ethReserve() external view returns (uint256);

    /// @notice Token side of the constituent's own pool, in token base units.
    function shareReserve() external view returns (uint256);
}
