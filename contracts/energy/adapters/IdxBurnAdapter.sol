// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {IEnergyAdapter} from "../IEnergyAdapter.sol";

/**
 * ============================================================================
 *  IdxBurnAdapter — Pipe X of the AXIOM-1 Energy Bus (ONESHOT §4.1
 *  `IDX_BURN_BPS = 1500`, ONESHOT §4.1a/§7.7 alignment note, SPEC §2.5).
 *
 *  ONESHOT §7.7 alignment note / `DESIGN-AUDIT-AXIOM-1-2026-08-08.md`'s P4
 *  row ("P4 IDX burn/lock ... Align existing buyback") is explicit: Pipe X
 *  must REUSE the already-shipped, already-adversarially-reviewed
 *  buy-and-lock mechanism in `IndexBuybackFacet.sol` (§7.7) rather than
 *  reimplementing "buy IDX coin, send it somewhere unredeemable" a second
 *  time. Two divergent implementations of the same security-sensitive
 *  mechanism (a permissionless swap against the index's own dedicated pool,
 *  landing bought coin at `SEED_LOCK_ADDR`) is exactly the outcome this
 *  adapter is built to avoid.
 *
 *  WHY THE INTERFACES DO NOT LINE UP CLEANLY (documented per this PR's own
 *  instructions, rather than silently adapted). `IndexBuybackFacet.
 *  executeBuyback(paymentIn, minCoinOut)` does not accept an arbitrary
 *  caller-supplied WETH amount to spend directly — it spends DOWN a
 *  pre-existing internal ledger slot, `ValueAccrualStorage.
 *  buybackEarmarkWei[dividendAsset]`, which only `_creditRoutedValue`
 *  (§7.3's governed `buybackBps` split) is ever allowed to credit. There is
 *  no facet entrypoint that lets an external pusher of WETH earmark 100% of
 *  a specific transfer for buyback and nothing else — earmarking is a
 *  protocol-governed *rate* over ALL routed value for a token, not a
 *  per-call parameter. Bypassing that (e.g. writing `buybackEarmarkWei`
 *  directly from a new adapter-only entrypoint) would be the "second,
 *  divergent implementation" this PR is told not to build.
 *
 *  THE MINIMAL ADAPTATION. This adapter therefore: (1) pushes its WETH to
 *  the index diamond and calls the SAME permissionless `reconcile(token)`
 *  path `DividendAdapter` uses (§7.3's push-then-reconcile mechanism — one
 *  mechanism, reused by both pipes), which credits whatever share of it
 *  governance has earmarked for buyback (plus dividend/reserve, exactly as
 *  every other routed-fee source already does — nothing here special-cases
 *  Pipe X's WETH), then (2) immediately calls the UNMODIFIED, REUSED
 *  `executeBuyback` for whatever the current payment-token earmark holds,
 *  so the buy-and-lock actually fires in the same transaction whenever
 *  there is a nonzero earmark to spend. If governance has `buybackBps == 0`
 *  (default-off), or a pool is not yet configured, or the same-block
 *  pool-quiescence guard `executeBuyback` already enforces is tripped by
 *  unrelated pool activity, step (2) simply does nothing THIS call — none of
 *  those are stranded-funds conditions, because step (1) already
 *  irreversibly credited the WETH into the index's own accounting
 *  (dividend/buyback/reserve), where it sits ready for a LATER
 *  permissionless `executeBuyback` call by anyone, exactly like any other
 *  accrued buyback earmark.
 *
 *  `minCoinOut = 0` on the reused call mirrors `IndexBuybackFacet.test.ts`'s
 *  own usage of the facet: the reused facet's sole atomic-manipulation
 *  defense is the same-block quiescence guard (`_requirePoolQuiescent`),
 *  which is unaffected by the caller's slippage floor — this adapter adds no
 *  new price-impact math on top of a mechanism that was already reviewed
 *  and shipped without one, to honor "reuse, don't duplicate".
 *
 *  NEVER REVERTS (critical constraint, this PR's own brief). Both external
 *  calls this adapter makes are wrapped in `try/catch`; a failure in either
 *  never propagates. `execute()` itself only ever reverts for the genuine
 *  programming-invariant violation of being called by something other than
 *  the Bus.
 * ============================================================================
 */
interface IIndexBuybackAndReconcile {
    function reconcile(address token) external returns (uint256 credited);
    function buybackEarmarkAvailable() external view returns (uint256);
    function executeBuyback(uint256 paymentIn, uint256 minCoinOut) external returns (uint256 coinOut);
}

contract IdxBurnAdapter is IEnergyAdapter {
    using SafeERC20 for IERC20;

    /// @notice WETH (== the index diamond's `dividendAsset`, the ONLY token
    /// `buybackEarmarkWei` can ever be spent against — see header).
    IERC20 public immutable weth;
    /// @notice The index Diamond this pipe buys+locks IDX coin through.
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
    /// caller — never for any external-world / recoverable condition. See
    /// `DividendAdapter`'s identical modifier for the full rationale.
    modifier onlyBus() {
        if (msg.sender != bus) revert NotBus();
        _;
    }

    function execute(uint256 amountIn) external override onlyBus returns (uint256 used, bool skipped) {
        if (amountIn == 0) return (0, false);

        // Step (1): push-then-reconcile, the exact §7.3 mechanism every
        // other routed-fee source (including `DividendAdapter`) uses. This
        // is what makes the WETH safe regardless of whether step (2) below
        // manages to buy anything this call.
        weth.safeTransfer(index, amountIn);
        try IIndexBuybackAndReconcile(index).reconcile(address(weth)) returns (uint256) {
            // credited; governed buybackBps share (if any) now sits in
            // `buybackEarmarkWei[weth]`, ready for step (2).
        } catch {
            // WETH already at `index`'s own balance — absorbed by a later
            // opportunistic or permissionless reconcile either way.
        }

        // Step (2): opportunistically fire the REUSED buy-and-lock over
        // whatever is currently earmarked. Best-effort, never required to
        // succeed for this pipe's WETH to be considered "used" — see header.
        try IIndexBuybackAndReconcile(index).buybackEarmarkAvailable() returns (uint256 earmark) {
            if (earmark > 0) {
                try IIndexBuybackAndReconcile(index).executeBuyback(earmark, 0) returns (uint256) {
                    // Bought coin already landed at SEED_LOCK_ADDR inside the
                    // reused facet — nothing further for this adapter to do.
                } catch {
                    // Pool not configured / same-block quiescence guard /
                    // any other recoverable reason — earmark stays credited
                    // for a later permissionless executeBuyback call.
                }
            }
        } catch {
            // Should be unreachable (a plain view getter), but even this is
            // swallowed rather than allowed to revert `execute()`.
        }

        // The WETH left this adapter's balance in step (1) and was never
        // returned to the Bus, so this pipe is never "skipped".
        return (amountIn, false);
    }
}
