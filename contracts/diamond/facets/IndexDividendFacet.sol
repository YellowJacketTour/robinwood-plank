// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {IndexFacetBase} from "./IndexFacetBase.sol";
import {CoreStorage, DividendStorage, EcosystemStorage} from "../storage/IndexStorage.sol";
import {DividendVestStorage} from "../storage/IndexDividendVestStorage.sol";

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
/**
 *  ══ 2026-08-09 AUDIT FIX H-2/H-3 — THE DIVIDEND LEG NOW VESTS ══════════
 *
 *  See `DividendVestStorage`'s header for the attack and the arithmetic. The
 *  half of the fix that lives HERE is the maturity drip: `dripDividends()`
 *  moves matured value out of the vest and into the accumulator, and
 *  `claimDividend()` drips first so a holder never has to know the mechanism
 *  exists. The half that lives in `IndexFacetBase` is two lines, and this
 *  facet is INERT without them — spelled out exactly so they cannot be
 *  reconciled wrong:
 *
 *   (1) `_creditRoutedValue`, replacing the unvested credit:
 *
 *          -   if (dividendShare > 0) _creditDividends(dividendShare);
 *          +   if (dividendShare > 0) {
 *          +       DividendVestStorage.add(dividendShare, STREAM_VEST_BLOCKS);
 *          +   }
 *
 *   (2) `_reconcileCore`, inside the `token == cs.dividendAsset` branch —
 *       MANDATORY, not cosmetic. Held-but-unpushed value is in this
 *       contract's ERC-20 balance and NOT in `DividendStorage`'s
 *       received/withdrawn ledger, so without this line the next `_sync`
 *       observes it as fresh surplus and routes it again, and again, minting
 *       dividend entitlement out of nothing:
 *
 *          if (token == cs.dividendAsset) {
 *              DividendStorage.Layout storage d = DividendStorage.layout();
 *              accounted += d.totalDividendsReceived - d.totalDividendsWithdrawn;
 *          +   accounted += DividendVestStorage.pending();
 *          }
 *
 *  NOT VESTED, DELIBERATELY: `receiveDividendsWrapped` and
 *  `harvestEcosystemFees`. Both push value that is ALREADY the holders',
 *  arriving on a path whose timing an attacker cannot drive from inside their
 *  own mint — both require the value to have been transferred in first, so
 *  there is no atomic mint->trigger->redeem sequence through either. Vesting
 *  them would delay honest distributions to close a door that is not open.
 *  The snipe is specifically against the MINT-TRIGGERED credit, and that is
 *  specifically what now vests.
 *
 *  ALSO REQUIRED, and NOT in this file: `dividendBps` must be capped so the
 *  100%-snipeable configuration is not legally reachable at all — defence in
 *  depth behind the vest, per §7 principle 2. See the report accompanying
 *  this change for the exact `IndexGovernanceFacet._applyValueAccrualSplit`
 *  edit.
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

    // ══ The dividend-leg vest (audit H-2/H-3) ═════════════════════════════

    /// @notice Routed dividend value held here and not yet in the
    /// accumulator. It is nobody's yet, and it is not lost — see
    /// `releasableDividendVest`.
    function pendingDividendVest() external view returns (uint256) {
        return DividendVestStorage.pending();
    }

    /// @notice How much of `pendingDividendVest` has matured and would be
    /// pushed into the accumulator by a `dripDividends()` call right now.
    /// This is EXACTLY ZERO in the block the value was routed, which is the
    /// property that kills the atomic mint->credit->redeem->claim snipe.
    function releasableDividendVest() external view returns (uint256) {
        return DividendVestStorage.releasable();
    }

    /**
     * @notice Push whatever dividend value has matured into the accumulator.
     *
     * PERMISSIONLESS and un-aimable: there is no recipient argument and no
     * amount argument. It credits pro rata to every eligible holder through
     * the one accumulator write, exactly as `receiveDividendsWrapped` does.
     * The worst a caller can do is pay gas to distribute money on schedule.
     *
     * Returns 0 rather than reverting when nothing has matured, so it is safe
     * to call unconditionally — including from `claimDividend` below, which
     * is why a holder never needs to know this function exists.
     */
    function dripDividends() external nonReentrant returns (uint256 amount) {
        return _dripDividends();
    }

    /// @dev The ONE call site of `DividendVestStorage.take`. `_creditDividends`
    /// reverts on zero, hence the guard.
    function _dripDividends() private returns (uint256 amount) {
        amount = DividendVestStorage.take();
        if (amount == 0) return 0;
        _creditDividends(amount);
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
        // Mature first, so a holder claiming on their own schedule sweeps up
        // everything that has genuinely vested by now. This CANNOT hand the
        // caller anything unearned: the drip credits pro rata to every
        // eligible holder, and the matured quantity is a function of elapsed
        // blocks alone — never of who called, or how often.
        _dripDividends();
        amount = _withdrawableDividendOf(msg.sender);
        if (amount == 0) return 0;
        DividendStorage.Layout storage d = DividendStorage.layout();
        d.withdrawnDividends[msg.sender] += amount;
        d.totalDividendsWithdrawn += amount;
        IERC20(CoreStorage.layout().dividendAsset).safeTransfer(msg.sender, amount);
        emit DividendClaimed(msg.sender, amount);
    }
}
