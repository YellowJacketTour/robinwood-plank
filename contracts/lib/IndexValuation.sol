// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {Constituent} from "./IndexTypes.sol";
import {IndexMath} from "./IndexMath.sol";
import {IndexOracle} from "./IndexOracle.sol";
import {IndexParamSet} from "./IndexParams.sol";

/**
 * ============================================================================
 *  IndexValuation — the target-weight vector, moved out of the vault's bytecode
 *
 *  THE EXTRACTION RULE, AND WHY THIS ONE CLEARS IT WHERE THE FIRST ATTEMPT
 *  DID NOT
 *  ----------------------------------------------------------------------
 *  hardhat.config.ts records an earlier extraction that made the vault BIGGER:
 *  `applyCapAndRedistribute`, which took and returned a `uint256[] memory`. The
 *  diagnosis was right and is worth keeping — ABI-encoding a dynamic array
 *  across a library boundary costs more code than a loop body — but the
 *  conclusion drawn from it was too broad. What is expensive is passing bulk
 *  data BY VALUE. Passing it by REFERENCE is not: a `storage` pointer is one
 *  word on the wire, and Solidity permits `storage` parameters on external
 *  library functions specifically so a library can operate on the caller's
 *  state without copying it.
 *
 *  So this function takes the constituent list and map as `storage` pointers —
 *  two words of calldata for the entire basket — and does the whole O(n)
 *  square-root curve, the iterated cap-and-redistribute, and the ramp scaling
 *  inside the library. Only the RESULT is encoded back, and it is encoded once
 *  per call rather than per constituent.
 *
 *  THE SAFETY CLAIM, NARROWED AGAIN AND STATED PLAINLY. This is the one
 *  library here that genuinely does read the vault's storage, because that is
 *  the point of it. The delegatecall guarantees that remain are: the function
 *  is `view`, so the compiler forbids it from WRITING any slot, emitting, or
 *  making a state-changing call; this file declares no storage variables of
 *  its own, so there is no layout to collide with; and every slot it can reach
 *  is one the vault handed it explicitly as an argument. It cannot name a slot
 *  the vault did not pass. Combined with the link-time-fixed address (no
 *  admin-settable delegatecall target, no upgrade lever), the residual surface
 *  is "a view function reads exactly the two collections it was given", which
 *  is the same authority the inlined code had.
 *
 *  The body is moved VERBATIM from GlobalIndexVault.targetWeightsBps.
 * ============================================================================
 */
library IndexValuation {
    uint256 private constant BPS = 10_000;
    uint256 private constant WAD = 1e18;

    /// @dev Re-declared rather than imported so this file has no compile-time
    /// dependency on the vault. Selectors match by name.
    error StalePrice();
    error ReserveWouldEmpty();

    /**
     * @notice The basket's NAV BAND in ETH wei. Never one number, anywhere.
     * @dev Moved verbatim from GlobalIndexVault.nav. `IndexOracle.band` is
     * `internal` and therefore inlined into this loop — one delegatecall for
     * the whole basket, not one per leg.
     */
    function navBand(
        address[] storage list,
        mapping(address => Constituent) storage cs,
        uint256 bandBps,
        uint256 staleAfter
    ) external view returns (uint256 navLow, uint256 navHigh) {
        uint256 n = list.length;
        for (uint256 i = 0; i < n; i++) {
            Constituent storage c = cs[list[i]];
            (uint256 lo, uint256 hi, ) = IndexOracle.band(c, bandBps, staleAfter);
            navLow += Math.mulDiv(c.reserve, lo, WAD);
            navHigh += Math.mulDiv(c.reserve, hi, WAD);
        }
    }

    /// @dev Every constituent's share of NAV_low in one O(n) pass. Moved
    /// verbatim from GlobalIndexVault._allWeightsBps.
    function allWeightsBps(
        address[] storage list,
        mapping(address => Constituent) storage cs,
        uint256 bandBps,
        uint256 staleAfter
    ) external view returns (uint256[] memory w) {
        return _weights(list, cs, bandBps, staleAfter);
    }

    /// @dev The body, `private` for the same reason `_targets` is.
    function _weights(
        address[] storage list,
        mapping(address => Constituent) storage cs,
        uint256 bandBps,
        uint256 staleAfter
    ) private view returns (uint256[] memory w) {
        uint256 n = list.length;
        w = new uint256[](n);
        uint256[] memory v = new uint256[](n);
        uint256 navLow;
        for (uint256 i = 0; i < n; i++) {
            Constituent storage c = cs[list[i]];
            (uint256 lo, , ) = IndexOracle.band(c, bandBps, staleAfter);
            v[i] = Math.mulDiv(c.reserve, lo, WAD);
            navLow += v[i];
        }
        if (navLow == 0) return w;
        for (uint256 i = 0; i < n; i++) w[i] = (v[i] * BPS) / navLow;
    }

    /**
     * @notice The single-asset exit, computed exactly as Balancer decomposes a
     * non-proportional exit:
     *   1. the SAME strict pro-rata payout as `redeemProRata`, computed
     *      virtually for every constituent (identical expression, floored);
     *   2. the non-target legs valued at their band LOW (undervalue what the
     *      redeemer gives up) and converted into target units at the target's
     *      band HIGH (overvalue what they receive) — conservative on both
     *      sides of the internal swap, so a round trip is never free;
     *   3. a Curve-`remove_liquidity_one_coin`-style imbalance fee on the
     *      swapped portion only. The pro-rata portion is always free, which is
     *      what keeps the balanced path strictly cheaper than the concentrated
     *      one for every input.
     *
     * @dev Moved verbatim from GlobalIndexVault._previewSingleExit. `denom` is
     * `totalSupply() + VIRTUAL_SHARES`, computed by the caller, so this library
     * never needs a reach into the share token.
     */
    function previewSingleExit(
        address[] storage list,
        mapping(address => Constituent) storage cs,
        address token,
        uint256 sharesIn,
        uint256 denom,
        IndexParamSet memory p
    ) external view returns (uint256 amountOut, uint256 feeAmount) {
        Constituent storage target = cs[token];
        (uint256 targetLo, uint256 targetHi, ) = IndexOracle.band(target, p.bandBps, p.staleAfter);
        if (targetHi == 0 || targetLo == 0) revert StalePrice();

        uint256 proRataTarget = Math.mulDiv(sharesIn, target.reserve, denom);

        uint256 extra = Math.mulDiv(
            _otherLegsEth(list, cs, token, sharesIn, denom, p.bandBps, p.staleAfter),
            WAD,
            targetHi
        );
        uint256 remaining = target.reserve > proRataTarget ? target.reserve - proRataTarget : 0;
        if (remaining == 0) revert ReserveWouldEmpty();
        // `feeAmount` is the fee this exit charges, in TARGET-token units —
        // the same number that was already being retained implicitly by paying
        // out less. Naming it is what lets the ecosystem split be taken out of
        // the fee rather than out of the reserve.
        feeAmount =
            (extra *
                IndexMath.imbalanceFeeBps(
                    extra,
                    remaining,
                    p.baseImbalanceFeeBps,
                    p.imbalanceSlopeBps,
                    p.maxImbalanceFeeBps
                )) /
            BPS;
        extra -= feeAmount;
        amountOut = proRataTarget + extra;
    }

    /**
     * @notice The two strict pro-rata quotes, in one body.
     *
     * `roundUp` selects the MINT side (every amount ceils, against
     * `reserve + VIRTUAL_ASSETS`) or the REDEEM side (every amount floors,
     * against `reserve` alone). That asymmetry is not a simplification for the
     * sake of sharing a body — it is the deliberate rounding doctrine
     * documented at `redeemProRata`, and keeping both sides in ONE function
     * makes it impossible for the two previews to drift apart from each other.
     *
     * @dev Moved verbatim from GlobalIndexVault. `denom` and `virtualAssets`
     * are supplied by the caller, so this library needs no reach into the
     * share token.
     */
    function previewProRata(
        address[] storage list,
        mapping(address => Constituent) storage cs,
        uint256 shares,
        uint256 denom,
        uint256 virtualAssets,
        bool roundUp
    ) external view returns (address[] memory tokens, uint256[] memory amounts) {
        uint256 n = list.length;
        tokens = new address[](n);
        amounts = new uint256[](n);
        for (uint256 i = 0; i < n; i++) {
            tokens[i] = list[i];
            uint256 r = cs[tokens[i]].reserve;
            amounts[i] = roundUp
                ? Math.mulDiv(shares, r + virtualAssets, denom, Math.Rounding.Up)
                : Math.mulDiv(shares, r, denom);
        }
    }

    /**
     * @notice DIRECTIONAL mint-side imbalance fee, layered on the depth-based
     * fee. A deposit into an UNDERWEIGHT constituent moves the basket toward
     * its target vector and is discounted; one into an OVERWEIGHT constituent
     * moves it away and is surcharged. See GlobalIndexVault._mintFeeBps for the
     * two conservative choices (the discount floors at the base fee and can
     * never go negative; an unknown target pays the maximum).
     *
     * @dev Moved verbatim. Living here is what lets the target vector and the
     * current weight vector be computed by PRIVATE calls — the vault used to
     * pay two delegatecalls and two dynamic-array ABI decodes for this one fee.
     */
    function mintFeeBps(
        address[] storage list,
        mapping(address => Constituent) storage cs,
        address token,
        uint256 depthFee,
        uint256 cap,
        IndexParamSet memory p
    ) external view returns (uint256) {
        (address[] memory tokens, uint256[] memory target) = _targets(list, cs, cap, p.staleAfter);
        uint256 idx = type(uint256).max;
        for (uint256 i = 0; i < tokens.length; i++) {
            if (tokens[i] == token) {
                idx = i;
                break;
            }
        }
        if (idx == type(uint256).max) return p.maxImbalanceFeeBps;
        uint256 t = target[idx];
        if (t == 0) return p.maxImbalanceFeeBps; // unknown target => max
        return
            IndexMath.mintFeeBps(
                depthFee,
                _weights(list, cs, p.bandBps, p.staleAfter)[idx],
                t,
                p.baseImbalanceFeeBps,
                p.imbalanceSlopeBps,
                p.maxImbalanceFeeBps
            );
    }

    /// @dev The pro-rata slice of every NON-target leg, valued at that leg's
    /// band LOW, summed in ETH wei. Split out of `previewSingleExit` purely to
    /// keep that function's stack inside the EVM's 16-slot reach — the
    /// arithmetic is identical to the loop it replaced.
    function _otherLegsEth(
        address[] storage list,
        mapping(address => Constituent) storage cs,
        address token,
        uint256 sharesIn,
        uint256 denom,
        uint256 bandBps,
        uint256 staleAfter
    ) private view returns (uint256 otherEth) {
        uint256 n = list.length;
        for (uint256 i = 0; i < n; i++) {
            address t = list[i];
            if (t == token) continue;
            Constituent storage c = cs[t];
            (uint256 lo, , ) = IndexOracle.band(c, bandBps, staleAfter);
            otherEth += Math.mulDiv(Math.mulDiv(sharesIn, c.reserve, denom), lo, WAD);
        }
    }

    /**
     * @notice Target weights: square-root curve over each constituent's
     * manipulation-resistant metric, then the hard concentration cap applied
     * with the excess redistributed pro-rata across the uncapped remainder,
     * then each newly-added constituent's result scaled by its ramp-in
     * progress. §2.7, and the same capped-index methodology UCITS funds and
     * Index Coop use.
     *
     * @dev A view. Nothing on-chain force-trades against it — rebalancing is
     * specified (§2.7, ultimate-form §4/§5.4) as piecewise, solver-auctioned
     * INTENTS, precisely so the trade direction is not published on-chain
     * ahead of the fill. Publishing a target vector is safe; publishing an
     * executable rebalance order is what gets front-run.
     *
     * @param cap the EFFECTIVE concentration cap the vault computed, passed in
     * rather than recomputed, so there is exactly one definition of it.
     * @param staleAfter feeds the ramp-in freeze; see IndexMath.rampFactorBps.
     */
    function targetWeightsBps(
        address[] storage list,
        mapping(address => Constituent) storage cs,
        uint256 cap,
        uint256 staleAfter
    ) external view returns (address[] memory tokens, uint256[] memory bps) {
        return _targets(list, cs, cap, staleAfter);
    }

    /// @dev The body, `private` so `mintFeeBps` below reaches it with a plain
    /// jump rather than a second delegatecall and a second array decode.
    function _targets(
        address[] storage list,
        mapping(address => Constituent) storage cs,
        uint256 cap,
        uint256 staleAfter
    ) private view returns (address[] memory tokens, uint256[] memory bps) {
        uint256 n = list.length;
        tokens = new address[](n);
        bps = new uint256[](n);
        uint256[] memory raw = new uint256[](n);
        uint256[] memory factor = new uint256[](n);
        uint256 total;
        for (uint256 i = 0; i < n; i++) {
            tokens[i] = list[i];
            Constituent storage c = cs[tokens[i]];
            // A ramp factor of zero means "contributes nothing", which covers
            // both a brand-new constituent at t=0 and a fully ramped-out one.
            // It must also be excluded from the normalising total, or a
            // long-dead constituent would silently depress every live leg.
            factor[i] = IndexMath.rampFactorBps(
                c.active,
                block.timestamp - uint256(c.rampStart),
                c.rampDuration,
                block.timestamp > uint256(c.obs[c.obsHead].timestamp) + staleAfter
            );
            if (factor[i] == 0) continue;
            uint256 r = Math.sqrt(c.metric);
            raw[i] = r;
            total += r;
        }
        if (total == 0) return (tokens, bps);

        for (uint256 i = 0; i < n; i++) bps[i] = (raw[i] * BPS) / total;

        // Cap-and-redistribute, iterated: capping one constituent inflates the
        // others, which may push a second over the cap. Bounded to n passes.
        for (uint256 pass = 0; pass < n; pass++) {
            uint256 excess;
            uint256 uncapped;
            for (uint256 i = 0; i < n; i++) {
                if (bps[i] > cap) {
                    excess += bps[i] - cap;
                    bps[i] = cap;
                } else if (bps[i] > 0) {
                    uncapped += bps[i];
                }
            }
            if (excess == 0 || uncapped == 0) break;
            for (uint256 i = 0; i < n; i++) {
                if (bps[i] < cap && bps[i] > 0) {
                    bps[i] += (excess * bps[i]) / uncapped;
                }
            }
        }

        // Gradual ramp, in BOTH directions (see IndexMath.rampFactorBps).
        for (uint256 i = 0; i < n; i++) {
            if (factor[i] == BPS) continue;
            bps[i] = (bps[i] * factor[i]) / BPS;
        }
    }
}
