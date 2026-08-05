// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IIndexPriceSource} from "../IIndexPriceSource.sol";

/// @dev Ring buffer depth for each constituent's price observations. The
/// vault re-declares this as its own `OBS_SLOTS`; the two MUST agree, and
/// this declaration is the one that fixes the storage shape.
uint256 constant OBS_SLOTS = 8;

/**
 * ============================================================================
 *  IndexTypes — GlobalIndexVault's per-constituent storage shape
 *
 *  Lifted to file scope, unchanged, so IndexValuation.sol can take a
 *  `Constituent storage` pointer as an argument. Field order and packing are
 *  EXACTLY what they were when these structs were declared inside the vault,
 *  which is what makes this move storage-layout-neutral; anything that
 *  reorders a field here silently reinterprets live vault storage.
 * ============================================================================
 */
struct Observation {
    uint64 timestamp;
    uint192 price; // ETH wei per WAD of token, already movement-capped
    uint256 cumulative; // price-seconds accumulator
}

struct Constituent {
    IIndexPriceSource source;
    uint64 rampStart;
    uint64 rampDuration;
    uint256 rawTargetWeightBps; // pre-curve intent, informational
    uint256 metric; // fee revenue + locked LP, timelocked input to √ curve
    uint256 reserve; // credited balance, NEVER balanceOf()
    bool listed;
    bool active; // false = weight target 0, but reserves still redeemable
    uint8 obsCount;
    uint8 obsHead;
    // ── Part E: the LONG realized-variance calibration window ──────────
    // A two-bucket TUMBLING window: `cur` fills for VARIANCE_WINDOW, then
    // rolls into `prev` and `cur` restarts. Reading prev+cur therefore
    // always covers at least one full window of history and at most two,
    // which is what makes a short burst of manufactured checkpoints a
    // vanishing fraction of the denominator. A ring buffer of individual
    // samples would be strictly more precise and strictly more expensive;
    // two accumulators is the honest on-chain shape.
    // Deliberately full-width uint256 rather than tightly packed: the
    // packing arithmetic costs more CODE than the slots it saves, and this
    // contract is against the EIP-170 size limit, not against gas.
    uint256 varWindowStart;
    uint256 varPrevSumSq; // sum of (per-checkpoint move in bps)^2
    uint256 varPrevSamples;
    uint256 varCurSumSq;
    uint256 varCurSamples;
    Observation[OBS_SLOTS] obs;
}
