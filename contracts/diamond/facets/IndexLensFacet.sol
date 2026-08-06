// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {IndexFacetBase} from "./IndexFacetBase.sol";
import {IndexValuation} from "../../lib/IndexValuation.sol";
import {IndexParamSet as Params} from "../../lib/IndexParams.sol";
import {Constituent} from "../../lib/IndexTypes.sol";
import {CoreStorage, ParamsStorage, GovernanceStorage} from "../storage/IndexStorage.sol";

/**
 * ============================================================================
 *  IndexLensFacet — every read-only view, and nothing else.
 *
 *  NOT FOR DEPLOYMENT except as a facet.
 *
 *  Design doc section 2.1 rule 2: VIEWS ARE WHERE SIZE PRESSURE GOES. Views cost
 *  nothing at the margin and can be split arbitrarily, so any facet running out
 *  of room moves its views here. That is the escape valve that stops the byte
 *  budget from ever being a design constraint again.
 *
 *  EVERY function in this file is `view` or `pure`. There is not one state
 *  write, not one external call that can mutate, and no path from here to a
 *  transfer. `targetWeightsBps` in particular is a pure view and nothing
 *  on-chain force-trades against it: rebalancing is specified as piecewise,
 *  solver-auctioned INTENTS, precisely so the trade direction is not published
 *  on-chain ahead of the fill. Publishing a target VECTOR is safe; publishing an
 *  executable rebalance ORDER is what gets front-run.
 * ============================================================================
 */
contract IndexLensFacet is IndexFacetBase {
    // ── The parameter set ──────────────────────────────────────────────────

    /// @notice The whole risk/fee parameter set, field order unchanged from the
    /// monolith's auto-generated getter.
    function params() external view returns (Params memory) {
        return ParamsStorage.layout().params;
    }

    // ── NAV and weights ────────────────────────────────────────────────────

    /// @notice The basket's NAV band in ETH wei. Never one number, anywhere.
    function nav() external view returns (uint256 navLow, uint256 navHigh) {
        return _nav();
    }

    /// @notice Per-constituent share of NAV_low, in bps. Used for the cap.
    function weightBps(address token) external view returns (uint256) {
        (uint256 navLow, ) = _nav();
        if (navLow == 0) return 0;
        (uint256 lo, , ) = _priceBand(token);
        uint256 v = Math.mulDiv(CoreStorage.layout().constituents[token].reserve, lo, WAD);
        return (v * BPS) / navLow;
    }

    /**
     * @notice Target weights: square-root curve over each constituent's
     * manipulation-resistant metric, then the hard concentration cap applied
     * with the excess redistributed pro-rata across the uncapped remainder,
     * then each constituent's result scaled by its ramp progress.
     *
     * RAMP-IN freezes at zero progress while a constituent is stale.
     * RAMP-OUT decays linearly rather than cliffing, and staleness does NOT
     * freeze it — freezing a ramp-out would pin a silent, being-removed
     * constituent at full target weight, the one case where "freeze on stale"
     * helps an attacker rather than the basket.
     */
    function targetWeightsBps() external view returns (address[] memory tokens, uint256[] memory bps) {
        CoreStorage.Layout storage cs = CoreStorage.layout();
        return
            IndexValuation.targetWeightsBps(
                cs.constituentList,
                cs.constituents,
                _effectiveCapBps(),
                _params().staleAfter
            );
    }

    // ── Constituent enumeration ────────────────────────────────────────────

    function constituentCount() external view returns (uint256) {
        return CoreStorage.layout().constituentList.length;
    }

    function constituentAt(uint256 i) external view returns (address) {
        return CoreStorage.layout().constituentList[i];
    }

    function listConstituents() external view returns (address[] memory) {
        return CoreStorage.layout().constituentList;
    }

    function reserveOf(address token) external view returns (uint256) {
        return CoreStorage.layout().constituents[token].reserve;
    }

    function constituentInfo(address token)
        external
        view
        returns (
            address source,
            uint256 reserve,
            uint256 metric,
            uint64 rampStart,
            uint64 rampDuration,
            bool listed,
            bool active,
            uint8 obsCount
        )
    {
        Constituent storage c = CoreStorage.layout().constituents[token];
        return (
            address(c.source),
            c.reserve,
            c.metric,
            c.rampStart,
            c.rampDuration,
            c.listed,
            c.active,
            c.obsCount
        );
    }

    /// @notice Whether `token` is frozen to NEW single-asset deposits because a
    /// removal is queued against it or already executed. Deliberately public
    /// the INSTANT a removal is queued: transparency about what the basket is
    /// unwinding is worth having, and hiding it would only advantage whoever
    /// reads the mempool.
    function isExiting(address token) external view returns (bool) {
        CoreStorage.Layout storage cs = CoreStorage.layout();
        if (!cs.constituents[token].listed) return false;
        if (!cs.constituents[token].active) return true;
        GovernanceStorage.QueuedListing storage q = GovernanceStorage.layout().queuedListings[token];
        return q.pending && q.isRemoval;
    }

    // ── Previews ───────────────────────────────────────────────────────────

    /// @notice What a pro-rata redemption of `sharesIn` pays today. Pure math
    /// over reserves — no prices, so a UI can show it without an oracle read.
    /// Shares ONE body in IndexValuation with `previewMintProRata` so the two
    /// cannot drift apart, including the deliberate absence of VIRTUAL_ASSETS
    /// on the payout side.
    function previewRedeemProRata(uint256 sharesIn)
        external
        view
        returns (address[] memory tokens, uint256[] memory amounts)
    {
        CoreStorage.Layout storage cs = CoreStorage.layout();
        return
            IndexValuation.previewProRata(
                cs.constituentList,
                cs.constituents,
                sharesIn,
                _totalSupply() + VIRTUAL_SHARES,
                0,
                false
            );
    }

    function previewMintProRata(uint256 sharesOut)
        external
        view
        returns (address[] memory tokens, uint256[] memory amounts)
    {
        CoreStorage.Layout storage cs = CoreStorage.layout();
        return
            IndexValuation.previewProRata(
                cs.constituentList,
                cs.constituents,
                sharesOut,
                _totalSupply() + VIRTUAL_SHARES,
                VIRTUAL_ASSETS,
                true
            );
    }

    /// @notice What a single-asset exit pays, imbalance fee already deducted.
    /// Shown before signature, per CONTRIBUTING.md's pre-signature rule.
    function previewRedeemSingleAsset(uint256 sharesIn, address token) external view returns (uint256) {
        (uint256 out, ) = _previewSingleExit(sharesIn, token);
        return out;
    }

    /// @notice The mint-side fee a deposit of `amountIn` into `token` would
    /// pay, directional term included.
    function previewMintFeeBps(address token, uint256 amountIn) external view returns (uint256) {
        return
            _mintFeeBps(
                token,
                _imbalanceFeeBps(amountIn, CoreStorage.layout().constituents[token].reserve)
            );
    }

    function imbalanceFeeBps(uint256 amount, uint256 against) external view returns (uint256) {
        return _imbalanceFeeBps(amount, against);
    }

    // ── Capability marker ──────────────────────────────────────────────────

    function capabilities()
        external
        pure
        returns (bool proRataInKind, bool bandedNav, bool timelocked, uint256 version)
    {
        return (true, true, true, INDEX_VERSION_);
    }

    /// @notice Generation marker so the client never has to sniff bytecode. The
    /// public face of `IndexFacetBase.INDEX_VERSION_`; see that declaration for
    /// why the getter lives in exactly one facet.
    function INDEX_VERSION() external pure returns (uint256) {
        return INDEX_VERSION_;
    }
}
