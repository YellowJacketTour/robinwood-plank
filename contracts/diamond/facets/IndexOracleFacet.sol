// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IndexFacetBase} from "./IndexFacetBase.sol";
import {IndexOracle} from "../../lib/IndexOracle.sol";
import {Constituent} from "../../lib/IndexTypes.sol";
import {CoreStorage, ParamsStorage} from "../storage/IndexStorage.sol";

/**
 * ============================================================================
 *  IndexOracleFacet — the capped, checkpointed, banded price surface.
 *
 *  NOT FOR DEPLOYMENT except as a facet.
 *
 *  Every function here is either permissionless (`checkpoint`, `checkpointAll`)
 *  or a pure view. There is no setter, no submission, and no privileged price
 *  path anywhere in this facet — the truncated-oracle cap, the staleness
 *  breaker and the persistence calibration are all computed from observations
 *  the diamond recorded itself.
 *
 *  NOTE FOR THE EXIT-DOOR REVIEW: nothing in this facet is on the
 *  `redeemProRata` path. Pro-rata redemption reads no price at all and works
 *  with every constituent fully stale, which is why the staleness breaker can
 *  afford to be as harsh as it is (NAV_low collapses to zero) without ever
 *  standing between a holder and their assets.
 * ============================================================================
 */
contract IndexOracleFacet is IndexFacetBase {
    /**
     * @notice Record one price observation. Permissionless — anyone may call,
     * and the honest party always wants to, because a stale constituent is
     * valued at zero on the redemption side.
     * @dev The new observation is CLAMPED to +/- `priceCapBps` of the previous
     * one: a flash-loaned spike of any magnitude enters as at most one capped
     * step, and reverting it in the same block costs the attacker the whole
     * round trip for nothing.
     */
    function checkpoint(address token) external nonReentrant {
        Constituent storage c = _get(token);
        _observe(token, c, false);
    }

    /// @notice Checkpoint every listed constituent. Convenience, same rules.
    function checkpointAll() external nonReentrant {
        CoreStorage.Layout storage cs = CoreStorage.layout();
        uint256 minInterval = _params().minCheckpointInterval;
        uint256 n = cs.constituentList.length;
        for (uint256 i = 0; i < n; i++) {
            address t = cs.constituentList[i];
            Constituent storage c = cs.constituents[t];
            if (block.timestamp >= uint256(_last(c).timestamp) + minInterval) {
                _observe(t, c, false);
            }
        }
    }

    /**
     * @notice The constituent's conservative price BAND and its time-weighted
     * mean, in ETH wei per WAD of token.
     *
     * STALE / SILENT-CONSTITUENT CIRCUIT BREAKER: if the newest observation is
     * older than `staleAfter`, `low` collapses to ZERO while `high` is
     * retained. Deliberately asymmetric: a constituent that has gone quiet must
     * never be trusted to VALUE something, while still being expensive to
     * RECEIVE. A stale leg is always fully redeemable pro rata in kind — that
     * path uses no prices at all.
     */
    function priceBand(address token) external view returns (uint256 low, uint256 high, uint256 twap) {
        return _priceBand(token);
    }

    /// @notice Every retained observation sits within `persistenceToleranceBps`
    /// of the TWAP, across at least `persistenceCheckpoints` of them. This
    /// overload keeps the ORIGINAL fixed-N meaning and is what a UI should read.
    function persistenceHolds(address token) external view returns (bool) {
        return _persistenceHoldsFor(token, _params().persistenceCheckpoints);
    }

    /// @notice `persistenceHolds`, but against an explicit checkpoint count.
    function persistenceHoldsFor(address token, uint256 required) external view returns (bool) {
        return _persistenceHoldsFor(token, required);
    }

    /**
     * @notice SIZE-PROPORTIONAL PERSISTENCE, size term only.
     *
     * A fixed N is defeatable by a patient attacker: hold the pushed price for
     * exactly N checkpoints, take the basket-moving trade on checkpoint N, let
     * it fall on N+1. The cost of holding is linear in N and the profit is
     * linear in SIZE, so at a fixed N there is always a size at which the
     * attack pays. Growing the requirement with size removes that.
     */
    function requiredCheckpoints(uint256 ethValue) external view returns (uint256) {
        return _requiredCheckpoints(ethValue);
    }

    /**
     * @notice A constituent's REALIZED per-checkpoint volatility in bps: the
     * root-mean-square of its settled checkpoint-to-checkpoint moves over the
     * long calibration window.
     *
     * WHAT THIS IS NOT: a Generalized Pareto / extreme-value tail fit. It is
     * the second moment of ALL moves, dominated by the ordinary middle of the
     * distribution, and it can by construction never anticipate a move larger
     * than the ones it has seen. It is STRICTLY LESS statistically rigorous
     * than an EVT fit and is chosen anyway, because an MLE fit is not
     * practically Solidity-computable and would in practice be SUBMITTED —
     * reintroducing the oracle-trust problem on the very parameter that governs
     * how much confirmation a large operation needs.
     */
    function realizedVolBps(address token) external view returns (uint256) {
        return IndexOracle.realizedVol(_get(token));
    }

    /**
     * @notice VARIANCE-CALIBRATED, SIZE-PROPORTIONAL persistence.
     *
     * THE CLAMP IS NOT A DETAIL. Floor is `max(persistenceCheckpoints,
     * MIN_REQUIRED_CHECKPOINTS)`; ceiling is the ring-buffer depth, because a
     * requirement deeper than the retained history is unsatisfiable and would
     * brick both priced paths. Neither bound is reachable by governance or by
     * anything an attacker can do to the calibration input.
     */
    function requiredCheckpointsFor(address token, uint256 ethValue) external view returns (uint256) {
        return _requiredCheckpointsFor(token, ethValue);
    }
}
