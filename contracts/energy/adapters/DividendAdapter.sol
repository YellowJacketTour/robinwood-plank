// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {IEnergyAdapter} from "../IEnergyAdapter.sol";

/**
 * ============================================================================
 *  DividendAdapter — Pipe D of the AXIOM-1 Energy Bus (ONESHOT §4.1 `DIV_BPS
 *  = 1500`, ONESHOT §4.1b, SPEC §2.8).
 *
 *  Pipe D is special among the six pipes: it receives BOTH its own direct
 *  15% Bus allocation AND the remainder of every OTHER pipe that returns
 *  `skipped=true` (`EnergyBus._runPipe` / `route()`). It must therefore never
 *  itself be the pipe that strands funds.
 *
 *  WHAT THIS DOES NOT BUILD. ONESHOT §4.1b locks `DRIP_BPS_OF_D = 10000`
 *  (100% reinvest) and `CASH_BPS_OF_D = 0` (cash-out is a future opt-in, not
 *  built now) — so there is deliberately no withdraw/cash-pull path here.
 *  "Reinvest" for Pipe D means: hand the WETH to the SAME exchange-rate /
 *  reserve-compounding mechanism every other WETH fee source in this
 *  codebase already uses, not a new parallel accumulator.
 *
 *  THE REUSED MECHANISM. `docs/DESIGN-N-VAULT-FACTORY-AND-VALUE-ACCRUAL-
 *  2026-08-06.md` §7.3's already-shipped, already-adversarially-reviewed
 *  "push a plain ERC-20 transfer to the diamond, then call the permissionless
 *  `reconcile(token)` alias over `_reconcileCore` -> `_creditRoutedValue`"
 *  path is the EXACT mechanism `CollectionVault`'s own mandatory sink cut
 *  already uses (`IndexBootstrapFacet.sol`'s own header: "the factory-vault
 *  push-then-opportunistic-reconcile mechanism"). `_creditRoutedValue` then
 *  applies the existing governed three-way split (dividend accumulator /
 *  buyback earmark / `c.reserve`) to the payment token — the `c.reserve` leg
 *  is exactly the "exchange-rate compounding" ONESHOT §4.1b's Pipe-D row
 *  asks for (it raises what every constituent share is redeemable for), and
 *  the dividend leg is the existing EIP-2222-style accumulator
 *  (`withdrawableDividendOf` / `claimDividend`) — so "100% reinvest, 0% cash
 *  pull" is satisfied by simply not building any NEW withdraw path over the
 *  WETH this adapter pushes; the split between "grows redeemable NAV" and
 *  "grows a holder's claimable dividend balance" is already governed
 *  upstream by `ValueAccrualStorage.dividendBps`/`buybackBps`, not
 *  reinvented here.
 *
 *  NEVER REVERTS (critical constraint, this PR's own brief). `execute()`
 *  never reverts for a recoverable-condition failure: if `reconcile` reverts
 *  for any reason (e.g. a future non-dividend-asset WETH edge case), the
 *  WETH has ALREADY landed at the index diamond's own balance by the time
 *  that call is attempted — it is not stranded, not lost, and will be picked
 *  up by the next opportunistic reconcile on a live mint/redeem hot path, or
 *  by any future permissionless `reconcile()` call from anyone. `execute()`
 *  itself only ever reverts for the genuine programming-invariant violation
 *  of being called by something other than the Bus.
 * ============================================================================
 */
interface IIndexReconcile {
    function reconcile(address token) external returns (uint256 credited);
}

contract DividendAdapter is IEnergyAdapter {
    using SafeERC20 for IERC20;

    /// @notice WETH (== the index diamond's `dividendAsset`).
    IERC20 public immutable weth;
    /// @notice The index Diamond this pipe reinvests into.
    address public immutable index;
    /// @notice The one EnergyBus this adapter will ever accept `execute` from.
    address public immutable bus;

    error ZeroAddress();
    error NotBus();

    constructor(address weth_, address index_, address bus_) {
        if (weth_ == address(0) || index_ == address(0) || bus_ == address(0)) revert ZeroAddress();
        weth = IERC20(weth_);
        index = index_;
        bus = bus_;
    }

    /// @dev Only ever reverts for the invariant violation of a non-Bus
    /// caller — never for any external-world / recoverable condition, per
    /// this PR's binding constraint (`EnergyBus._runPipe` pre-transfers WETH
    /// before calling `execute`; a genuine revert here strands that slice at
    /// this adapter's own address).
    modifier onlyBus() {
        if (msg.sender != bus) revert NotBus();
        _;
    }

    function execute(uint256 amountIn) external override onlyBus returns (uint256 used, bool skipped) {
        if (amountIn == 0) return (0, false);

        // Plain ERC-20 push straight to the diamond — the same, one, already-
        // proven "no cross-contract call, no self-reported amount" discipline
        // every other routed-fee source in this codebase uses.
        weth.safeTransfer(index, amountIn);

        // Best-effort immediate reconcile so the reinvest lands this same
        // transaction. A failure here is NOT a stranded-funds condition (see
        // header) so it is swallowed rather than propagated.
        try IIndexReconcile(index).reconcile(address(weth)) returns (uint256) {
            // credited via the existing §7.3 three-way split; nothing further
            // for this adapter to do.
        } catch {
            // WETH already sits at `index`'s own balance; a later
            // opportunistic or permissionless reconcile absorbs it.
        }

        // The WETH left this adapter's balance either way (transferred to
        // `index` above) — it was never returned to the Bus, so this pipe is
        // never "skipped" from the Bus's point of view.
        return (amountIn, false);
    }
}
