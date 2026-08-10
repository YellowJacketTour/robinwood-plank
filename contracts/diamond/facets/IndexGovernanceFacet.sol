// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IndexFacetBase} from "./IndexFacetBase.sol";
import {IIndexPriceSource} from "../../IIndexPriceSource.sol";
import {IndexParams, IndexParamSet as Params} from "../../lib/IndexParams.sol";
import {Constituent} from "../../lib/IndexTypes.sol";
import {
    CoreStorage,
    ParamsStorage,
    GovernanceStorage,
    RolesStorage,
    AllocationStorage,
    EcosystemStorage,
    ValueAccrualStorage
} from "../storage/IndexStorage.sol";
import {IndexProvenanceStorage} from "../storage/IndexProvenanceStorage.sol";

interface IEcosystemFeeSinkView {
    function reinvestAsset() external view returns (address);
}

/**
 * ============================================================================
 *  IndexGovernanceFacet — every timelocked parameter surface, and the roles.
 *
 *  NOT FOR DEPLOYMENT except as a facet.
 *
 *  EVERY function here affects FUTURE parameter values only. None can move a
 *  constituent balance. That is the anchor rule, and it is not a convention:
 *  there is no code path anywhere in the finalized facet set that transfers a
 *  reserve to anyone except a share-burning redeemer.
 *
 *  WHAT CHANGED UNDER THE DIAMOND, AND WHAT DID NOT
 *  ------------------------------------------------
 *  `ScopedRoles` was an abstract BASE CONTRACT with its own `roleHolder` and
 *  `queuedRoles` mappings at fixed slots. A facet may not inherit it — those
 *  mappings would land on the diamond's own slot 0. The registry therefore
 *  moves to the `roles` namespace and the four queue/execute/cancel bodies move
 *  here verbatim. The properties are unchanged and one is strictly harder to
 *  satisfy: "there is no second write path to `roleHolder` anywhere in the ABI"
 *  becomes "anywhere in the union of the FINALIZED FACET SET", a strictly
 *  larger surface, which `Diamond.selectors.test.ts` enumerates mechanically.
 *
 *  `timelockDelay` moved from `immutable` to `core` storage (design doc section
 *  3.3 rule 2). The old property was "immutable, therefore unreachable". The new
 *  one is "written once, in the diamond's constructor, before any facet exists,
 *  and written by no function in the finalized set" — a DIFFERENT proof, and
 *  `Diamond.noWriteToImmutables.test.ts` is it. The BELOW-FLOOR check stays in
 *  the diamond's CONSTRUCTOR rather than moving to a setter here, because the
 *  original property is "a below-floor delay cannot be DEPLOYED AT ALL", which
 *  is a stronger claim than "cannot be set".
 * ============================================================================
 */
contract IndexGovernanceFacet is IndexFacetBase {
    // ── The role keys, exposed ONCE ────────────────────────────────────────
    //
    // The monolith declared these `public constant`. Under a diamond a shared
    // base cannot: the identical getter would appear in every facet and
    // `diamondCut` rejects a duplicate selector. They live here because this is
    // the only facet with anything to do with roles, and the values themselves
    // are `constant` in `IndexFacetBase` so every facet still agrees on them.

    function ROLE_ADMIN() external pure returns (bytes32) {
        return ROLE_ADMIN_;
    }

    /// @notice Admits, removes and re-weights constituents. Cannot touch risk
    /// parameters or the platform cut.
    function ROLE_CONSTITUENT_ADMISSION() external pure returns (bytes32) {
        return ROLE_CONSTITUENT_ADMISSION_;
    }

    /// @notice Tunes the risk surface. Cannot admit a constituent and cannot
    /// touch the platform cut.
    function ROLE_RISK_PARAM() external pure returns (bytes32) {
        return ROLE_RISK_PARAM_;
    }

    /// @notice The ONLY role over the operator-facing value flow. Kept
    /// separately keyed precisely because it is the one parameter surface that
    /// redirects newly minted shares to an operator — even though it can never
    /// touch reserves or existing holders' NAV per share.
    function ROLE_PLATFORM_ALLOCATION() external pure returns (bytes32) {
        return ROLE_PLATFORM_ALLOCATION_;
    }

    /// @notice The stream-listing capability. It whitelists reward tokens and
    /// reaches no value path at all.
    function ROLE_STREAM_LISTER() external pure returns (bytes32) {
        return ROLE_STREAM_LISTER_;
    }

    // ── Queue views ────────────────────────────────────────────────────────

    function queuedParams(bytes32 key) external view returns (uint256 value, uint64 eta, bool pending) {
        GovernanceStorage.QueuedParam storage q = GovernanceStorage.layout().queuedParams[key];
        return (q.value, q.eta, q.pending);
    }

    function queuedListings(address token)
        external
        view
        returns (address source, uint256 rawTargetWeightBps, uint64 eta, bool pending, bool isRemoval)
    {
        GovernanceStorage.QueuedListing storage q = GovernanceStorage.layout().queuedListings[token];
        return (q.source, q.rawTargetWeightBps, q.eta, q.pending, q.isRemoval);
    }

    function queuedPlatformTreasury() external view returns (uint256 value, uint64 eta, bool pending) {
        GovernanceStorage.QueuedParam storage q = GovernanceStorage.layout().queuedPlatformTreasury;
        return (q.value, q.eta, q.pending);
    }

    function platformTreasury() external view returns (address) {
        return AllocationStorage.layout().platformTreasury;
    }

    function platformAllocationBps() external view returns (uint256) {
        return AllocationStorage.layout().platformAllocationBps;
    }

    // ── §7.3 value-accrual split views ─────────────────────────────────────

    /// @notice Share of newly-routed value (design doc §7.3) credited to the
    /// EIP-2222 dividend accumulator. Zero until governance queues a split —
    /// see `ValueAccrualStorage`'s header for why that default is safe.
    function valueAccrualDividendBps() external view returns (uint256) {
        return ValueAccrualStorage.layout().dividendBps;
    }

    /// @notice Share earmarked toward §7.7's not-yet-built buyback-and-lock.
    function valueAccrualBuybackBps() external view returns (uint256) {
        return ValueAccrualStorage.layout().buybackBps;
    }

    /// @notice The remainder — always `BPS - dividendBps - buybackBps`, never
    /// stored, so it can never drift from the other two.
    function valueAccrualReserveBps() external view returns (uint256) {
        ValueAccrualStorage.Layout storage va = ValueAccrualStorage.layout();
        return BPS - va.dividendBps - va.buybackBps;
    }

    /// @notice Value earmarked for `token` toward §7.7's buyback-and-lock, not
    /// yet spent by anything (nothing can spend it yet — see `ValueAccrualStorage`).
    function buybackEarmarkWei(address token) external view returns (uint256) {
        return ValueAccrualStorage.layout().buybackEarmarkWei[token];
    }

    // ══ Parameters ════════════════════════════════════════════════════════

    /**
     * @notice Which role may queue `key`. Reverts for anything unrecognised.
     *
     * Load-bearing in two directions: it routes `platformAllocationBps` — the
     * one key that redirects value to an operator — away from the risk role,
     * and it REJECTS unrecognised keys outright. Without the rejection, any
     * parameter role could write a `keccak256("metric", token)` key into the
     * shared `queuedParams` mapping and have `executeMetric` apply it, handing
     * the risk role the admission role's re-weighting power through the back
     * door. Whitelisting the key space closes that — and under the diamond it
     * has to hold ACROSS FACETS, since several now reach that one map.
     */
    function roleForParamKey(bytes32 key) public pure returns (bytes32) {
        return IndexParams.roleForParamKey(key, ROLE_PLATFORM_ALLOCATION_, ROLE_RISK_PARAM_);
    }

    function queueParam(bytes32 key, uint256 value) external {
        bytes32 role = roleForParamKey(key);
        if (msg.sender != RolesStorage.layout().roleHolder[role]) revert NotRoleHolder(role);
        uint64 eta = uint64(block.timestamp + CoreStorage.layout().timelockDelay);
        GovernanceStorage.layout().queuedParams[key] =
            GovernanceStorage.QueuedParam({value: value, eta: eta, pending: true});
        emit ParamQueued(key, value, eta);
    }

    function executeParam(bytes32 key) external {
        GovernanceStorage.Layout storage gs = GovernanceStorage.layout();
        GovernanceStorage.QueuedParam memory q = gs.queuedParams[key];
        if (!q.pending) revert NothingQueued();
        if (block.timestamp < q.eta) revert TimelockNotElapsed();
        delete gs.queuedParams[key];

        ParamsStorage.Layout storage ps = ParamsStorage.layout();
        (Params memory p, bool handled) = IndexParams.applyRiskParam(ps.params, key, q.value);
        if (handled) {
            ps.params = p;
            emit ParamApplied(key, q.value);
            return;
        }

        // Hard ceilings are re-checked HERE, at EXECUTION, never at queue time.
        // Same doctrine as IndexParams.validate: a timelock bounds when a bad
        // change lands, never how bad it can be.
        if (key == "platformAllocationBps") {
            if (q.value > CEIL_PLATFORM_ALLOCATION_BPS) revert AllocationCapExceeded();
            AllocationStorage.layout().platformAllocationBps = q.value;
        } else if (key == "ecosystemFeeSplitBps") {
            if (q.value > CEIL_ECOSYSTEM_SPLIT_BPS) revert AllocationCapExceeded();
            EcosystemStorage.layout().ecosystemFeeSplitBps = q.value;
        } else if (key == "ecosystemSink") {
            _applyEcosystemSink(q.value);
        } else if (key == "valueAccrualSplitBps") {
            _applyValueAccrualSplit(q.value);
        } else if (key == "targetHhiBps") {
            if (q.value < MIN_TARGET_HHI_BPS || q.value > MAX_TARGET_HHI_BPS) revert BadParam();
            ps.targetHhiBps = q.value;
        } else if (key == "minEligibilityFeesWei") {
            // The two bars need no ceiling: they are MINIMUMS, so an absurdly
            // high one makes every constituent ineligible, drives the eligible
            // count to zero, makes `capBpsFor` return 100%, and is then clamped
            // by the flat cap — i.e. the worst an admin can do is fall back to
            // the pre-existing flat behaviour.
            ps.minEligibilityFeesWei = q.value;
        } else if (key == "minEligibilityBlocks") {
            ps.minEligibilityBlocks = q.value;
        } else revert BadParam();

        emit ParamApplied(key, q.value);
    }

    /**
     * @dev APPOINTING THE ECOSYSTEM SINK. There is no bespoke queue pair: the
     * appointment rides the SAME timelock every other parameter uses. One
     * timelock implementation, not two — a second hand-rolled queue is a second
     * place for a bypass to hide.
     *
     * The asset is read ONCE, at appointment, rather than live on the hot path.
     * Consulting the sink inside the priced paths would put an external call to
     * a third-party contract on both of them — a reentrancy surface bought for
     * a value that does not change — and would let a sink silently retarget
     * which constituent this diamond diverts by mutating its own storage.
     */
    function _applyEcosystemSink(uint256 value) private {
        address sink = address(uint160(value));
        EcosystemStorage.Layout storage es = EcosystemStorage.layout();
        es.ecosystemSink = sink;
        es.ecosystemAsset = sink == address(0)
            ? address(0)
            : IEcosystemFeeSinkView(sink).reinvestAsset();
    }

    /**
     * @dev §7.3's three-way split, applied atomically. `value` packs BOTH bps
     * fields into one queue slot (`dividendBps * BPS + buybackBps`) rather
     * than using two independent keys, so a single queue/execute pair can
     * never leave the split in a state where the two governed shares were
     * changed at different times and briefly summed past 100% — the same
     * "hard ceilings re-checked at execution" doctrine as everywhere else in
     * this file, applied to keep the pair atomic rather than just bounded.
     * `reserveBps` is never stored: it is always the derived remainder.
     */
    function _applyValueAccrualSplit(uint256 value) private {
        uint256 buybackBps = value % BPS;
        uint256 dividendBps = value / BPS;
        // §7.7's hard ceiling, re-checked HERE at execution — same doctrine
        // as every other hard ceiling in this function (a timelock bounds
        // WHEN a bad change lands, never HOW BAD it can be).
        if (buybackBps > CEIL_BUYBACK_SPLIT_BPS) revert BadParam();
        if (dividendBps > BPS || dividendBps + buybackBps > BPS) revert BadParam();
        ValueAccrualStorage.Layout storage va = ValueAccrualStorage.layout();
        va.dividendBps = dividendBps;
        va.buybackBps = buybackBps;
        emit ValueAccrualSplitApplied(dividendBps, buybackBps);
    }

    // ══ Metrics ═══════════════════════════════════════════════════════════

    /// @notice Update a constituent's weight metric. Timelocked like any other
    /// economically significant parameter, and it only ever changes a
    /// target-weight VIEW — it moves no value.
    function queueMetric(address token, uint256 metric) external onlyRole(ROLE_CONSTITUENT_ADMISSION_) {
        _get(token);
        bytes32 key = keccak256(abi.encodePacked("metric", token));
        uint64 eta = uint64(block.timestamp + CoreStorage.layout().timelockDelay);
        GovernanceStorage.layout().queuedParams[key] =
            GovernanceStorage.QueuedParam({value: metric, eta: eta, pending: true});
        emit ParamQueued(key, metric, eta);
    }

    function executeMetric(address token) external {
        bytes32 key = keccak256(abi.encodePacked("metric", token));
        GovernanceStorage.Layout storage gs = GovernanceStorage.layout();
        GovernanceStorage.QueuedParam memory q = gs.queuedParams[key];
        if (!q.pending) revert NothingQueued();
        if (block.timestamp < q.eta) revert TimelockNotElapsed();
        delete gs.queuedParams[key];
        CoreStorage.layout().constituents[token].metric = q.value;
        emit MetricUpdated(token, q.value);
    }

    // ══ The provenance registry (audit C-6) ═══════════════════════════════

    /// @notice The `CollectionVaultFactory` whose `isVault` gates post-open
    /// constituent admission and every zap leg. `address(0)` = nothing is
    /// admissible.
    function vaultFactory() external view returns (address) {
        return IndexProvenanceStorage.layout().vaultFactory;
    }

    /**
     * @notice Point the diamond at the vault registry that decides which
     * tokens are real. Timelocked like every other economically significant
     * address here.
     *
     * @dev WHAT THIS KEY CAN AND CANNOT DO. It can only ever change WHICH set
     * of tokens is admissible; it cannot admit one directly, cannot move a
     * reserve, and cannot reach `redeemProRata`. Setting it to a hostile
     * registry is equivalent to holding `ROLE_CONSTITUENT_ADMISSION` and no
     * more — the same key already gates listing, so this adds no authority to
     * an existing holder, it only takes authority away from them by requiring
     * a second, independently-deployed contract to agree.
     *
     * `address(0)` is accepted and is the SAFE direction: it disarms all
     * post-open admission. There is deliberately no way for this key to make
     * admission MORE permissive than "a factory-deployed vault".
     *
     * ⚠️ DEPLOYMENT REQUIREMENT, because `diamondCut` is renounced at birth
     * and there is no upgrade path: `IndexDeployer` MUST queue+execute this
     * (or the genesis seeder must, before opening) or the index can never
     * admit a constituent after launch and `zapMint` reverts on every leg.
     */
    function queueVaultFactory(address factory) external onlyRole(ROLE_CONSTITUENT_ADMISSION_) {
        uint64 eta = uint64(block.timestamp + CoreStorage.layout().timelockDelay);
        IndexProvenanceStorage.layout().queued =
            IndexProvenanceStorage.QueuedAddress({value: factory, eta: eta, pending: true});
        emit ParamQueued("vaultFactory", uint256(uint160(factory)), eta);
    }

    function executeVaultFactory() external {
        IndexProvenanceStorage.Layout storage l = IndexProvenanceStorage.layout();
        IndexProvenanceStorage.QueuedAddress memory q = l.queued;
        if (!q.pending) revert NothingQueued();
        if (block.timestamp < q.eta) revert TimelockNotElapsed();
        delete l.queued;
        l.vaultFactory = q.value;
        emit VaultFactoryUpdated(q.value);
    }

    // ══ Listings ══════════════════════════════════════════════════════════

    function queueListing(
        address token,
        IIndexPriceSource source,
        uint256 rawTargetWeightBps,
        bool isRemoval
    ) external onlyRole(ROLE_CONSTITUENT_ADMISSION_) {
        // AUDIT C-6: validate at QUEUE time as well as at `_list`. Both
        // matter and they are not redundant: `executeListing` is
        // permissionless, so `msg.sender` there is whoever happened to push
        // the button, and the "the price source may not be the lister" clause
        // is only meaningful against the account that actually chose it —
        // which is this one. The provenance gate is re-checked at execution
        // too, so a token cannot be de-registered-and-relisted through the
        // window, and a queued listing whose token loses provenance during the
        // timelock fails closed at execution rather than landing.
        if (!isRemoval && CoreStorage.layout().indexOpen) _requireAdmissible(token, source);
        uint64 eta = uint64(block.timestamp + CoreStorage.layout().timelockDelay);
        GovernanceStorage.layout().queuedListings[token] = GovernanceStorage.QueuedListing({
            source: address(source),
            rawTargetWeightBps: rawTargetWeightBps,
            eta: eta,
            pending: true,
            isRemoval: isRemoval
        });
        emit ConstituentQueued(token, eta, isRemoval);
    }

    /**
     * @notice Apply a queued add/remove after the delay.
     * @dev Removal DEACTIVATES but never delists a constituent that still holds
     * reserves — a delisted-with-reserves leg would be value stranded outside
     * the pro-rata payout set, which is the anchor rule violated by omission
     * rather than by theft. Removal is NOT blocked even when the leg holds a
     * large fraction of NAV: blocking it would leave the basket unable to ever
     * exit a broken constituent, and deactivation moves no value in any case.
     * The target weight decays over `rampDuration` rather than cliffing, so the
     * intent is public and gradual and the sell order is not.
     */
    function executeListing(address token) external nonReentrant {
        GovernanceStorage.Layout storage gs = GovernanceStorage.layout();
        GovernanceStorage.QueuedListing memory q = gs.queuedListings[token];
        if (!q.pending) revert NothingQueued();
        if (block.timestamp < q.eta) revert TimelockNotElapsed();
        delete gs.queuedListings[token];

        if (q.isRemoval) {
            Constituent storage c = _get(token);
            c.active = false;
            c.rampStart = uint64(block.timestamp);
            c.rampDuration = uint64(_params().rampDuration);
            emit ConstituentDeactivated(token);
            _recomputeEligibleCount(); // the eligible set shrank
        } else {
            _list(
                token,
                IIndexPriceSource(q.source),
                q.rawTargetWeightBps,
                uint64(block.timestamp),
                uint64(_params().rampDuration)
            );
        }
    }

    // ══ Platform treasury ═════════════════════════════════════════════════

    /// @notice Appoint (or retire, with address(0)) the platform treasury.
    /// Grants NO reach over pooled reserves: the treasury receives SHARES and
    /// redeems them through the identical strict pro-rata path as anyone else.
    function queuePlatformTreasury(address treasury) external onlyRole(ROLE_PLATFORM_ALLOCATION_) {
        uint64 eta = uint64(block.timestamp + CoreStorage.layout().timelockDelay);
        GovernanceStorage.layout().queuedPlatformTreasury = GovernanceStorage.QueuedParam({
            value: uint256(uint160(treasury)),
            eta: eta,
            pending: true
        });
        emit ParamQueued("platformTreasury", uint256(uint160(treasury)), eta);
    }

    function executePlatformTreasury() external {
        GovernanceStorage.Layout storage gs = GovernanceStorage.layout();
        GovernanceStorage.QueuedParam memory q = gs.queuedPlatformTreasury;
        if (!q.pending) revert NothingQueued();
        if (block.timestamp < q.eta) revert TimelockNotElapsed();
        delete gs.queuedPlatformTreasury;
        AllocationStorage.layout().platformTreasury = address(uint160(q.value));
        emit ParamApplied("platformTreasury", q.value);
    }

    // ══ Roles (ported from ScopedRoles, verbatim) ═════════════════════════

    function roleHolder(bytes32 role) external view returns (address) {
        return RolesStorage.layout().roleHolder[role];
    }

    function queuedRoles(bytes32 role) external view returns (address holder, uint64 eta, bool pending) {
        RolesStorage.QueuedRole storage q = RolesStorage.layout().queuedRoles[role];
        return (q.holder, q.eta, q.pending);
    }

    function hasRole(bytes32 role, address who) external view returns (bool) {
        return who != address(0) && RolesStorage.layout().roleHolder[role] == who;
    }

    /**
     * @notice Queue a role handover. RE-QUEUE IS REPLACE, NOT APPEND, on a
     * fresh full delay, and it stays cancellable throughout.
     *
     * NO RENOUNCE PATH EXISTS. `next` may not be the zero address, so a role
     * can never be vacated — an unassigned role is an ungoverned parameter.
     * ROLE_ADMIN_ cannot grant itself another role in one transaction, because
     * every grant is a queue followed by a separate execute after the full
     * delay.
     */
    function queueRole(bytes32 role, address next) external onlyRole(ROLE_ADMIN_) {
        if (!_isKnownRole(role)) revert UnknownRole(role);
        if (next == address(0)) revert BadRoleHolder();
        uint64 eta = uint64(block.timestamp + CoreStorage.layout().timelockDelay);
        RolesStorage.layout().queuedRoles[role] = RolesStorage.QueuedRole({
            holder: next,
            eta: eta,
            pending: true
        });
        emit RoleQueued(role, next, eta);
    }

    function executeRole(bytes32 role) external {
        RolesStorage.Layout storage rs = RolesStorage.layout();
        RolesStorage.QueuedRole memory q = rs.queuedRoles[role];
        if (!q.pending) revert NoRoleQueued();
        if (block.timestamp < q.eta) revert RoleTimelockNotElapsed();
        delete rs.queuedRoles[role];
        address prev = rs.roleHolder[role];
        rs.roleHolder[role] = q.holder;
        emit RoleApplied(role, prev, q.holder);
    }

    /// @notice Cancel a pending handover. Grants no capability: the only thing
    /// it can prevent is a change that has not happened yet, and a SUCCESSOR
    /// ADMIN INHERITS this authority over proposals queued by their predecessor.
    function cancelRole(bytes32 role) external onlyRole(ROLE_ADMIN_) {
        RolesStorage.Layout storage rs = RolesStorage.layout();
        if (!rs.queuedRoles[role].pending) revert NoRoleQueued();
        delete rs.queuedRoles[role];
        emit RoleQueued(role, address(0), 0);
    }
}
