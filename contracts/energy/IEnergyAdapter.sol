// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * ============================================================================
 *  IEnergyAdapter — PR2 of the AXIOM-1 stack (ONESHOT §7, SPEC §2.2).
 *
 *  Six adapters (InventoryBuy, CollectionLpRenounce, IdxBurn, PlankBurn,
 *  PlankLpRenounce, Dividend) implement this interface. `EnergyBus.route()`
 *  transfers `amountIn` WETH to the adapter with a plain `IERC20.transfer`,
 *  then calls `execute`. The adapter must never retain WETH it does not
 *  spend: any unused amount must be returned to the Bus (as `used < amountIn`
 *  leftover, transferred back) so the Bus's post-call balance accounting
 *  stays exact — the Bus only ever credits observed balance deltas, never
 *  self-reported amounts.
 * ============================================================================
 */
interface IEnergyAdapter {
    /// @param amountIn WETH transferred to this adapter for this pipe, this call.
    /// @return used Amount of WETH actually consumed by the adapter. Any
    /// `amountIn - used` must be transferred back to `msg.sender` (the Bus)
    /// before `execute` returns.
    /// @return skipped True if the adapter found no safe fill (e.g. price
    /// impact would exceed `MAX_IMPACT_BPS`) and returned the entire
    /// `amountIn` back to the Bus. The Bus routes that amount to Pipe D
    /// (DividendAdapter) instead of leaving it stranded or sending it to any
    /// admin-controlled address.
    function execute(uint256 amountIn) external returns (uint256 used, bool skipped);
}
