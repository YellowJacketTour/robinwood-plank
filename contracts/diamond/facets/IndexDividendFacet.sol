// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {IndexFacetBase} from "./IndexFacetBase.sol";
import {CoreStorage, DividendStorage, EcosystemStorage} from "../storage/IndexStorage.sol";

interface IEcosystemFeeSink {
    function reinvestAsset() external view returns (address);
    function receiveDividendsWrapped(uint256 amount) external;
}

/**
 * ============================================================================
 *  IndexDividendFacet — on-chain dividend accrual to holders, with no staking,
 *  plus the segregated ecosystem-fee ledger that funds it.
 *
 *  NOT FOR DEPLOYMENT except as a facet.
 *
 *  THE MECHANISM is EIP-2222 "magnified dividend per share": one global
 *  accumulator and one per-holder CORRECTION term, with the correction adjusted
 *  on every balance change so `accumulativeDividendOf` is invariant across a
 *  transfer. A buyer cannot reach back for a distribution that predates them; a
 *  seller keeps every wei that accrued while they held. No snapshot, no Merkle
 *  root and therefore no publisher to trust, no staking, no holder list.
 *
 *  WHY IT IS STILL ONE ASSET AND O(1) (design doc section 5.4 — a REVERSAL)
 *  -----------------------------------------------------------------------
 *  Generalising this accumulator over the STREAM set is the obvious elegant
 *  move, and it is rejected. Under a backing-pool model, value that arrives
 *  accrues to THE TOKEN, so an LP pool holding the share gets richer and its
 *  LPs capture it through the pool's price with zero action by anyone. Under an
 *  accumulator model, value accrues to ADDRESSES, so the LP pool ADDRESS becomes
 *  the accruer of record and the real holders behind it cannot reach it. That
 *  would trade a bounded, self-healing griefing surface for a PERMANENT
 *  value-stranding surface on every DEX-held share.
 *
 *  Keeping it one-asset is also what keeps the ERC-20 transfer hook O(1) and
 *  unable to brick a transfer — so the two decisions are one decision.
 *
 *  THE SEED'S SHARE IS EXCLUDED, EXACTLY. The permanently-locked seed can never
 *  claim, so crediting it would strand a slice of every distribution forever.
 *  The push divides by `totalSupply - balanceOf(SEED_LOCK)` and cancels the
 *  seed's own accrual through the same correction term, in O(1).
 * ============================================================================
 */
contract IndexDividendFacet is IndexFacetBase {
    using SafeERC20 for IERC20;

    // ── Accumulator views ──────────────────────────────────────────────────

    function magnifiedDividendPerShare() external view returns (uint256) {
        return DividendStorage.layout().magnifiedDividendPerShare;
    }

    function withdrawnDividends(address account) external view returns (uint256) {
        return DividendStorage.layout().withdrawnDividends[account];
    }

    function totalDividendsReceived() external view returns (uint256) {
        return DividendStorage.layout().totalDividendsReceived;
    }

    function totalDividendsWithdrawn() external view returns (uint256) {
        return DividendStorage.layout().totalDividendsWithdrawn;
    }

    /// @notice Value received but not yet credited. Two causes, one behaviour:
    /// nobody was eligible, or the implied per-share delta exceeded this push's
    /// share of the accumulator's remaining headroom. In BOTH cases the value is
    /// HELD, never lost and never reverted, and folds into the next push whose
    /// arithmetic has room for it. There is no input that can refuse a dividend
    /// push or strand one permanently.
    function undistributedDividends() external view returns (uint256) {
        return DividendStorage.layout().undistributedDividends;
    }

    /// @notice Everything `account` has ever been credited, claimed or not.
    function accumulativeDividendOf(address account) external view returns (uint256) {
        return _accumulativeDividendOf(account);
    }

    /**
     * @notice What `account` can claim right now. Always already correct, with
     * no action ever required from them and nothing to prove.
     *
     * This does NOT go to zero when a holder's balance goes to zero: a redeemer
     * who burns every share keeps every wei that accrued while they held them,
     * because the burn moved the same quantity into their correction term.
     */
    function withdrawableDividendOf(address account) external view returns (uint256) {
        return _withdrawableDividendOf(account);
    }

    // ── Ecosystem ledger views ─────────────────────────────────────────────

    function ecosystemFeesWei(address token) external view returns (uint256) {
        return EcosystemStorage.layout().ecosystemFeesWei[token];
    }

    function ecosystemSink() external view returns (address) {
        return EcosystemStorage.layout().ecosystemSink;
    }

    function ecosystemAsset() external view returns (address) {
        return EcosystemStorage.layout().ecosystemAsset;
    }

    function ecosystemFeeSplitBps() external view returns (uint256) {
        return EcosystemStorage.layout().ecosystemFeeSplitBps;
    }

    // ══ Harvest ═══════════════════════════════════════════════════════════

    /**
     * @notice Push the segregated ecosystem fees to the appointed sink.
     *
     * PERMISSIONLESS, with a FIXED destination. Anyone may call it; nobody may
     * choose where it goes. There is no recipient argument, no override and no
     * privileged variant, so this is a trigger, not a rug lever: the worst a
     * caller can do is pay gas to move protocol fee revenue to the address
     * governance appointed under timelock in public.
     *
     * The allowance is granted for exactly `amount` and asserted consumed, so
     * the diamond never leaves a standing approval over any token balance —
     * including the balance backing `reserve`.
     */
    function harvestEcosystemFees() external nonReentrant returns (uint256 amount) {
        EcosystemStorage.Layout storage es = EcosystemStorage.layout();
        address sink = es.ecosystemSink;
        if (sink == address(0)) revert EcosystemSinkUnset();
        address asset = es.ecosystemAsset;
        amount = es.ecosystemFeesWei[asset];
        if (amount == 0) revert ZeroAmount();
        es.ecosystemFeesWei[asset] = 0; // effects before interactions
        if (sink == address(this)) {
            // SELF-SINK: the tokens are already in this contract's balance, so
            // there is nothing to approve, nothing to pull and no external call
            // to make. Moving them would be `transferFrom(self, self)` — a
            // no-op that credits a zero delta and would revert.
            _creditDividends(amount);
        } else {
            IERC20(asset).forceApprove(sink, amount);
            IEcosystemFeeSink(sink).receiveDividendsWrapped(amount);
            if (IERC20(asset).allowance(address(this), sink) != 0) revert ApprovalNotConsumed();
        }
        emit EcosystemFeesHarvested(asset, sink, amount);
    }

    // ══ Dividends in ══════════════════════════════════════════════════════

    /// @notice The asset an ecosystem sink is expected to expose. Implementing
    /// it — with `receiveDividendsWrapped` — makes the DIAMOND ITSELF a valid
    /// `IEcosystemFeeSink`, so the sink can be pointed at the diamond through
    /// the ordinary timelock and the harvest then funds holders directly with
    /// no second contract in the path.
    function reinvestAsset() external view returns (address) {
        return CoreStorage.layout().dividendAsset;
    }

    /**
     * @notice Push dividends to every holder, pro rata, permissionlessly.
     *
     * Anyone may call. Making it privileged would buy nothing — a griefer's
     * "attack" is donating money — and would add a key to lose. Credits the
     * ACTUAL balance delta, never the nominal amount.
     */
    function receiveDividendsWrapped(uint256 amount) external nonReentrant {
        address asset = CoreStorage.layout().dividendAsset;
        if (asset == address(0)) revert BadParam();
        if (amount == 0) revert ZeroAmount();
        uint256 before = IERC20(asset).balanceOf(address(this));
        IERC20(asset).safeTransferFrom(msg.sender, address(this), amount);
        _creditDividends(IERC20(asset).balanceOf(address(this)) - before);
    }

    // ══ Dividends out ═════════════════════════════════════════════════════

    /**
     * @notice Claim your own dividend. Permissionless, no proof, no root, no
     * snapshot, no staking — you held the token, so it is already yours.
     *
     * Paying zero is a successful transaction, not an error.
     * Checks-effects-interactions: every state change lands before the
     * transfer, so a re-entrant token finds `withdrawableDividendOf` already
     * zero even with the guard removed.
     */
    function claimDividend() external nonReentrant returns (uint256 amount) {
        amount = _withdrawableDividendOf(msg.sender);
        if (amount == 0) return 0;
        DividendStorage.Layout storage d = DividendStorage.layout();
        d.withdrawnDividends[msg.sender] += amount;
        d.totalDividendsWithdrawn += amount;
        IERC20(CoreStorage.layout().dividendAsset).safeTransfer(msg.sender, amount);
        emit DividendClaimed(msg.sender, amount);
    }
}
