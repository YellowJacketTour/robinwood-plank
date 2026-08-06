// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IIndexPriceSource} from "../IIndexPriceSource.sol";
import {Observation, Constituent, OBS_SLOTS} from "./IndexTypes.sol";

/**
 * ============================================================================
 *  IndexOracle — the checkpointed price band, moved out of the vault's bytecode
 *
 *  WHY THIS EXTRACTION PAYS (the same measured rule IndexValuation.sol states).
 *  An external library call costs a fixed stub at every call site, so a move
 *  only pays when (bytes of body removed) > (call sites) * (bytes of stub).
 *  The three bodies here — the observation writer with its truncation cap and
 *  its variance accumulator, the min/max/TWAP band scan, and the persistence
 *  scan — are each a real loop over a ring buffer reached from a handful of
 *  places, and each takes its bulk data as a `storage` POINTER (one word on the
 *  wire) rather than by value. That is the shape extraction was invented for,
 *  and it is the shape that made IndexValuation.sol a net win where the earlier
 *  `memory`-array attempt recorded in hardhat.config.ts was a net loss.
 *
 *  THE INTERNAL/EXTERNAL SPLIT IS DELIBERATE. `band()` is `internal`, so it is
 *  INLINED into whoever uses it and needs no link — which is what lets
 *  IndexValuation.sol compute NAV, the weight vector and the single-asset exit
 *  preview without a second delegatecall per constituent inside its own O(n)
 *  loops. Everything the vault itself reaches is `external`, so the vault pays
 *  one stub and carries none of the body.
 *
 *  SAFETY. `observe` is the only state-changing function here and it writes
 *  EXACTLY the one `Constituent` slot the vault handed it — it cannot name a
 *  slot it was not passed. Everything else is `view`, which the compiler
 *  enforces on this file's own source. This library declares no storage of its
 *  own, so there is no layout to collide with, and its address is fixed at LINK
 *  time, so there is no admin-settable delegatecall target and no upgrade lever.
 *
 *  The bodies are moved VERBATIM from GlobalIndexVault. This file relocates
 *  code and changes no rule.
 * ============================================================================
 */
library IndexOracle {
    uint256 private constant BPS = 10_000;
    uint256 private constant WAD = 1e18;

    /// @dev The LONG realized-variance calibration window. Mirrors the vault's
    /// own constant; see GlobalIndexVault.realizedVolBps for why it is
    /// structurally separate from the short persistence window it scales.
    uint256 private constant VARIANCE_WINDOW = 90 days;

    /// @dev Re-declared rather than imported so this file has no compile-time
    /// dependency on the vault. Selectors match by name, which is what the ABI
    /// keys on, so a caller decodes them identically.
    error NoPriceData();
    error CheckpointTooSoon();

    // ── Observation ────────────────────────────────────────────────────────

    /**
     * @notice Record one movement-capped observation. Returns the price that
     * was actually written, so the caller emits the event under its own
     * address (an event emitted here would carry the library's topic set, not
     * the vault's, and every indexer keys on the vault).
     *
     * @dev Moved verbatim from GlobalIndexVault._observe + _accrueVariance.
     */
    function observe(
        Constituent storage c,
        uint256 priceCapBps,
        uint256 minCheckpointInterval,
        bool bootstrap
    ) internal returns (uint256 priced) {
        uint256 spot = spotPrice(c.source);
        if (spot == 0) revert NoPriceData();

        if (c.obsCount == 0) {
            c.obs[0] = Observation({
                timestamp: uint64(block.timestamp),
                price: uint192(spot),
                cumulative: 0
            });
            c.obsCount = 1;
            c.obsHead = 0;
            return spot;
        }

        Observation memory prev = c.obs[c.obsHead];
        if (!bootstrap && block.timestamp < uint256(prev.timestamp) + minCheckpointInterval) {
            revert CheckpointTooSoon();
        }
        if (block.timestamp == prev.timestamp) revert CheckpointTooSoon();

        // Per-observation movement cap — the truncated-oracle core.
        uint256 capped = spot;
        uint256 hi = (uint256(prev.price) * (BPS + priceCapBps)) / BPS;
        uint256 lo = (uint256(prev.price) * (BPS - priceCapBps)) / BPS;
        if (capped > hi) capped = hi;
        if (capped < lo) capped = lo;
        if (capped == 0) capped = 1;

        uint256 dt = block.timestamp - uint256(prev.timestamp);
        uint256 head = (uint256(c.obsHead) + 1) % OBS_SLOTS;
        c.obs[head] = Observation({
            timestamp: uint64(block.timestamp),
            price: uint192(capped),
            cumulative: prev.cumulative + uint256(prev.price) * dt
        });
        c.obsHead = uint8(head);
        if (c.obsCount < OBS_SLOTS) c.obsCount += 1;

        // Part E: fold this SETTLED move into the LONG calibration window.
        // Measured on the CAPPED price, so a rejected spike cannot inflate the
        // calibration any more than it can inflate NAV.
        uint256 prevPrice = uint256(prev.price);
        uint256 d = capped > prevPrice ? capped - prevPrice : prevPrice - capped;
        uint256 moveBps = (d * BPS) / prevPrice; // <= priceCapBps by construction
        _accrueVariance(c, moveBps * moveBps);

        return capped;
    }

    /// @dev Two-bucket tumbling window over squared per-checkpoint moves. No
    /// division, no price history, no per-sample storage — one add and a
    /// counter, plus a bucket roll at most once per VARIANCE_WINDOW.
    function _accrueVariance(Constituent storage c, uint256 squaredBps) private {
        if (c.varWindowStart == 0) c.varWindowStart = block.timestamp;
        if (block.timestamp >= c.varWindowStart + VARIANCE_WINDOW) {
            c.varPrevSumSq = c.varCurSumSq;
            c.varPrevSamples = c.varCurSamples;
            c.varCurSumSq = 0;
            c.varCurSamples = 0;
            c.varWindowStart = block.timestamp;
        }
        c.varCurSumSq += squaredBps;
        c.varCurSamples += 1;
    }

    function spotPrice(IIndexPriceSource source) internal view returns (uint256) {
        uint256 e = source.ethReserve();
        uint256 s = source.shareReserve();
        if (e == 0 || s == 0) return 0;
        return Math.mulDiv(e, WAD, s);
    }

    // ── The band ───────────────────────────────────────────────────────────

    /**
     * @notice The conservative price BAND and its mean, in ETH wei per WAD.
     * `internal` on purpose — see this file's header. Callers that loop over
     * the whole basket inline this rather than paying a delegatecall per leg.
     *
     * @dev Moved verbatim from GlobalIndexVault.priceBand, including the
     * stale/silent-constituent circuit breaker that collapses `low` to ZERO
     * while retaining `high`.
     */
    function band(Constituent storage c, uint256 bandBps, uint256 staleAfter)
        internal
        view
        returns (uint256 low, uint256 high, uint256 twap)
    {
        if (c.obsCount == 0) return (0, 0, 0);

        uint256 minP = type(uint256).max;
        uint256 maxP = 0;
        uint256 sum = 0;
        uint256 n = c.obsCount;
        for (uint256 i = 0; i < n; i++) {
            uint256 slot = (uint256(c.obsHead) + OBS_SLOTS - i) % OBS_SLOTS;
            uint256 p = uint256(c.obs[slot].price);
            if (p < minP) minP = p;
            if (p > maxP) maxP = p;
            sum += p;
        }
        twap = sum / n;

        low = (minP * (BPS - bandBps)) / BPS;
        high = (maxP * (BPS + bandBps)) / BPS;

        if (block.timestamp > uint256(c.obs[c.obsHead].timestamp) + staleAfter) {
            low = 0;
        }
    }

    /// @notice `band`, reachable by the vault as one delegatecall.
    function priceBand(Constituent storage c, uint256 bandBps, uint256 staleAfter)
        internal
        view
        returns (uint256, uint256, uint256)
    {
        return band(c, bandBps, staleAfter);
    }

    /**
     * @notice Every retained observation sits within `tolBps` of the TWAP, and
     * there are at least `required` of them, and the newest is not stale.
     * @dev Moved verbatim from GlobalIndexVault.persistenceHoldsFor.
     */
    function persistenceHoldsFor(
        Constituent storage c,
        uint256 required,
        uint256 bandBps,
        uint256 staleAfter,
        uint256 tolBps
    ) internal view returns (bool) {
        if (c.obsCount < required) return false;
        if (block.timestamp > uint256(c.obs[c.obsHead].timestamp) + staleAfter) return false;

        (, , uint256 twap) = band(c, bandBps, staleAfter);
        if (twap == 0) return false;
        uint256 tol = (twap * tolBps) / BPS;
        uint256 n = c.obsCount;
        for (uint256 i = 0; i < n; i++) {
            uint256 slot = (uint256(c.obsHead) + OBS_SLOTS - i) % OBS_SLOTS;
            uint256 p = uint256(c.obs[slot].price);
            uint256 diff = p > twap ? p - twap : twap - p;
            if (diff > tol) return false;
        }
        return true;
    }

    /// @notice RMS of settled per-checkpoint moves, in bps, over the long
    /// calibration window. Moved verbatim from GlobalIndexVault.realizedVolBps.
    function realizedVol(Constituent storage c) internal view returns (uint256) {
        uint256 samples = c.varPrevSamples + c.varCurSamples;
        if (samples == 0) return 0;
        return Math.sqrt((c.varPrevSumSq + c.varCurSumSq) / samples);
    }
}
