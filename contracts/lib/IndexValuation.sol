// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {Constituent} from "./IndexTypes.sol";
import {IndexMath} from "./IndexMath.sol";

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
