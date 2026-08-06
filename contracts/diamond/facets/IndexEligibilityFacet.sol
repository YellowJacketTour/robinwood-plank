// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IndexFacetBase} from "./IndexFacetBase.sol";
import {IndexMath} from "../../lib/IndexMath.sol";
import {CoreStorage, ParamsStorage} from "../storage/IndexStorage.sol";

/**
 * ============================================================================
 *  IndexEligibilityFacet — the oracle-free eligibility bar and the dynamic,
 *  HHI-derived concentration cap.
 *
 *  NOT FOR DEPLOYMENT except as a facet.
 *
 *  There is NO admin override on `checkEligibility` and NO stored per-constituent
 *  eligibility flag anywhere in any namespace: the answer is recomputed from the
 *  constituent's own books every time it is asked. The read is a gas-capped
 *  low-level `staticcall`, so every failure mode a hostile or merely-old
 *  constituent can produce — no code, no such selector, an outright revert,
 *  short or undecodable returndata, an attempt to burn the caller's whole gas
 *  budget — resolves to `(false, 0, 0)`. It FAILS CLOSED and never reverts the
 *  caller, so a hostile constituent cannot brick a whole-basket recount.
 *
 *  KNOWN, REAL, UNCLOSED GAP: CORRELATION BLINDNESS. HHI measures SIZE
 *  concentration and nothing else. Ten constituents at 10% each score a perfect
 *  0.10 whether they are ten unrelated collections or ten wrappers around the
 *  same underlying. This cap bounds "how much of the basket is one NAME", not
 *  "how much of the basket is one BET", and the two can be arbitrarily far
 *  apart. It is flagged as open rather than approximated: a correlation check
 *  cheap enough to run on-chain would be too crude to trust.
 * ============================================================================
 */
contract IndexEligibilityFacet is IndexFacetBase {
    /// @notice Is `constituent` eligible, by its OWN on-chain fee accounting?
    function checkEligibility(address constituent)
        external
        view
        returns (bool eligible, uint256 feesWei, uint256 elapsedBlocks)
    {
        return _checkEligibility(constituent);
    }

    /// @notice Recount eligible constituents and refresh the dynamic cap.
    /// PERMISSIONLESS: this moves no value and grants nobody anything, and the
    /// honest party always wants it current. Bounded at MAX_CONSTITUENTS reads,
    /// each itself gas-capped.
    function refreshEligibleCount() external {
        _recomputeEligibleCount();
    }

    function eligibleConstituentCount() external view returns (uint256) {
        return CoreStorage.layout().eligibleConstituentCount;
    }

    function minEligibilityFeesWei() external view returns (uint256) {
        return ParamsStorage.layout().minEligibilityFeesWei;
    }

    function minEligibilityBlocks() external view returns (uint256) {
        return ParamsStorage.layout().minEligibilityBlocks;
    }

    function targetHhiBps() external view returns (uint256) {
        return ParamsStorage.layout().targetHhiBps;
    }

    /**
     * @notice The maximum single-constituent weight, in bps, consistent with a
     * basket HHI of `targetHhiBps` across `n` eligible constituents.
     *
     *     w = (1 + sqrt(1 - n*(1 - T*(n - 1)))) / n
     *
     * derived by minimising sum-of-squares for a given maximum weight (one leg
     * at w, the remaining mass spread evenly over the other n-1; any other
     * spread has a strictly higher sum of squares by Cauchy-Schwarz).
     *
     * AN HONEST CORRECTION TO THE OBVIOUS INTUITION: this is INCREASING in n,
     * not decreasing. The more legs there are to absorb the remainder, the less
     * a given large leg costs in sum-of-squares, so a fixed HHI budget buys a
     * LARGER single name. The quantity that falls with n is the AVERAGE weight
     * 1/n, which is a different number. Written down because the intuition
     * "more constituents must mean a tighter cap" is natural, widespread and
     * false, and a contract that implemented the intuition instead of the
     * algebra would be wrong in a way nobody would notice.
     *
     * `n <= 1` -> 100%. `T < 1/n` (infeasible: 1/n is the minimum achievable
     * HHI for n names) -> the equal-weight cap, 1/n.
     */
    function capBpsFor(uint256 n) external view returns (uint256) {
        return IndexMath.capBpsFor(n, ParamsStorage.layout().targetHhiBps);
    }

    /**
     * @notice The concentration cap actually enforced right now:
     * `min(capBpsFor(eligibleConstituentCount), params.concentrationCapBps)`.
     *
     * The flat, timelocked cap is retained as a HARD BACKSTOP rather than
     * replaced, and the dynamic term can only ever bind TIGHTER. Since
     * `capBpsFor` RISES with n, letting it replace the flat cap outright would
     * mean admitting constituents could LOOSEN the single-name cap past the
     * level that was audited — an admission path that buys concentration.
     */
    function effectiveConcentrationCapBps() external view returns (uint256) {
        return _effectiveCapBps();
    }
}
