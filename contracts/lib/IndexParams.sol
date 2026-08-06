// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * ============================================================================
 *  IndexParams — GlobalIndexVault's parameter key-space, moved out of its
 *  bytecode
 *
 *  WHY THIS ONE AND NOT THE OTHERS (the measurement that drove the split)
 *  ---------------------------------------------------------------------
 *  hardhat.config.ts's header records an earlier attempt at library extraction
 *  that made the vault BIGGER, and IndexMath.sol's header records a second
 *  attempt that saved 3 bytes. Both findings are real, and they point at the
 *  same cause: an external library call costs a fixed ~100-150 bytes of stub
 *  (build calldata, `delegatecall`, check the return, decode it) at EVERY call
 *  site, so extraction only pays when
 *
 *      (bytes of body removed) > (call sites) * (bytes of stub)
 *
 *  The arithmetic helpers in IndexMath fail that test because they are small
 *  bodies called from several places. What PASSES it, decisively, is a
 *  STRING-KEYED DISPATCH CHAIN: `roleForParamKey` and the parameter applicator
 *  are each one enormous straight-line body — twenty-odd 32-byte constant
 *  pushes and comparisons, which the optimiser cannot share because every
 *  constant is different — reached from exactly ONE place. One stub against a
 *  kilobyte of body is the shape extraction was invented for.
 *
 *  Every function here is `pure`, so the `delegatecall` this compiles to cannot
 *  read or write the vault's storage, cannot call out, and cannot emit — the
 *  compiler enforces that on this file's own source. The library declares no
 *  state variables, so there is no layout to collide with. The address is fixed
 *  at LINK time and baked into the vault's bytecode as an immutable constant,
 *  so there is no admin-settable delegatecall target and no upgrade lever.
 *
 *  The bodies are moved VERBATIM. The key space, the routing, the ceilings and
 *  the order of every check are byte-for-byte what they were; this file
 *  relocates code and changes no rule.
 * ============================================================================
 */

/// @dev Mirrors GlobalIndexVault.Params exactly, field for field and in the
/// same order. Declared here so the applicator can take and return it by
/// value; the vault's own declaration is the canonical one and this must
/// track it.
struct IndexParamSet {
    uint256 concentrationCapBps;
    uint256 baseImbalanceFeeBps;
    uint256 imbalanceSlopeBps;
    uint256 maxImbalanceFeeBps;
    uint256 bandBps;
    uint256 priceCapBps;
    uint256 minCheckpointInterval;
    uint256 staleAfter;
    uint256 persistenceCheckpoints;
    uint256 persistenceToleranceBps;
    uint256 largeOpValueWei;
    uint256 rampDuration;
}

library IndexParams {
    uint256 private constant BPS = 10_000;
    uint256 private constant OBS_SLOTS = 8;

    uint256 private constant MIN_CONCENTRATION_CAP_BPS = 1_000; // 10%
    uint256 private constant MAX_CONCENTRATION_CAP_BPS = 5_000; // 50%
    uint256 private constant CEIL_IMBALANCE_FEE_BPS = 1_000; // 10%, absolute
    uint256 private constant CEIL_BAND_BPS = 2_000; // 20% band widening
    uint256 private constant CEIL_PRICE_CAP_BPS = 2_000; // 20% per observation
    uint256 private constant MIN_RAMP_DURATION = 7 days;
    uint256 private constant MAX_RAMP_DURATION = 365 days;

    /// @dev Re-declared rather than imported so this file has no compile-time
    /// dependency on the vault. The selectors match by name, which is what the
    /// ABI actually keys on, so a caller decodes them identically.
    error BadParam();

    /**
     * @notice Which role may queue `key`. Reverts for anything that is not a
     * recognised parameter.
     *
     * @dev This is load-bearing for role isolation, in two directions:
     *
     *  - it routes `platformAllocationBps` — the one key that redirects value
     *    to an operator — to ROLE_PLATFORM_ALLOCATION, so the risk key cannot
     *    reach it;
     *  - it REJECTS unrecognised keys outright. Without that, any parameter
     *    role could write a `keccak256("metric", token)` key into the shared
     *    `queuedParams` mapping and have `executeMetric` apply it, which
     *    would hand the risk role the admission role's re-weighting power
     *    through the back door. Whitelisting the key space closes that.
     *
     * `ecosystemFeeSplitBps` is keyed to the VALUE-FLOW
     * role, not the risk role, on purpose. Neither changes what anyone is
     * charged — the fee schedule is untouched by both — they change where an
     * already-charged fee is booked and in what asset it is paid out. That is
     * the same kind of decision `platformAllocationBps` makes, so they live
     * behind the same role, and the risk role (which owns the fee SCHEDULE)
     * cannot reach them. Neither role can reach the other's half, which is the
     * point.
     */
    function roleForParamKey(bytes32 key, bytes32 allocationRole, bytes32 riskRole)
        internal
        pure
        returns (bytes32)
    {
        if (
            key == "platformAllocationBps" ||
            key == "ecosystemFeeSplitBps" ||
            key == "ecosystemSink"
        ) {
            return allocationRole;
        }
        if (
            key == "concentrationCapBps" ||
            key == "baseImbalanceFeeBps" ||
            key == "imbalanceSlopeBps" ||
            key == "maxImbalanceFeeBps" ||
            key == "bandBps" ||
            key == "priceCapBps" ||
            key == "minCheckpointInterval" ||
            key == "staleAfter" ||
            key == "persistenceCheckpoints" ||
            key == "persistenceToleranceBps" ||
            key == "largeOpValueWei" ||
            key == "rampDuration" ||
            key == "targetHhiBps" ||
            key == "minEligibilityFeesWei" ||
            key == "minEligibilityBlocks"
        ) return riskRole;
        revert BadParam();
    }

    /**
     * @notice Apply `key = value` to the RISK-PARAMETER half of the key space
     * and hand back the updated set, already re-validated.
     *
     * Returns `handled = false` for every key that lives outside `Params` —
     * the vault keeps those branches itself, because they write standalone
     * storage variables and enforce their own ceilings, and shipping a storage
     * write out to a `pure` library is not a thing that can be done or should
     * be wanted.
     *
     * Hard ceilings are re-checked HERE, at EXECUTION, exactly as they were
     * before this move: a timelock bounds WHEN a bad change lands, never HOW
     * BAD it can be.
     */
    function applyRiskParam(IndexParamSet memory p, bytes32 key, uint256 value)
        internal
        pure
        returns (IndexParamSet memory, bool handled)
    {
        if (key == "concentrationCapBps") p.concentrationCapBps = value;
        else if (key == "baseImbalanceFeeBps") p.baseImbalanceFeeBps = value;
        else if (key == "imbalanceSlopeBps") p.imbalanceSlopeBps = value;
        else if (key == "maxImbalanceFeeBps") p.maxImbalanceFeeBps = value;
        else if (key == "bandBps") p.bandBps = value;
        else if (key == "priceCapBps") p.priceCapBps = value;
        else if (key == "minCheckpointInterval") p.minCheckpointInterval = value;
        else if (key == "staleAfter") p.staleAfter = value;
        else if (key == "persistenceCheckpoints") p.persistenceCheckpoints = value;
        else if (key == "persistenceToleranceBps") p.persistenceToleranceBps = value;
        else if (key == "largeOpValueWei") p.largeOpValueWei = value;
        else if (key == "rampDuration") p.rampDuration = value;
        else return (p, false);

        validate(p);
        return (p, true);
    }

    /// @notice Every compile-time ceiling and floor on the risk parameter set,
    /// in one place. No admin, no timelock and no future governance can raise
    /// any of them — they are constants in this file's bytecode.
    function validate(IndexParamSet memory p) internal pure {
        if (
            p.concentrationCapBps < MIN_CONCENTRATION_CAP_BPS ||
            p.concentrationCapBps > MAX_CONCENTRATION_CAP_BPS
        ) revert BadParam();
        if (p.maxImbalanceFeeBps > CEIL_IMBALANCE_FEE_BPS) revert BadParam();
        if (p.baseImbalanceFeeBps > p.maxImbalanceFeeBps) revert BadParam();
        if (p.imbalanceSlopeBps > CEIL_IMBALANCE_FEE_BPS) revert BadParam();
        if (p.bandBps > CEIL_BAND_BPS) revert BadParam();
        if (p.priceCapBps == 0 || p.priceCapBps > CEIL_PRICE_CAP_BPS) revert BadParam();
        if (p.minCheckpointInterval == 0 || p.minCheckpointInterval > 1 days) revert BadParam();
        if (p.staleAfter < p.minCheckpointInterval * 2 || p.staleAfter > 30 days) revert BadParam();
        if (p.persistenceCheckpoints < 2 || p.persistenceCheckpoints > OBS_SLOTS) revert BadParam();
        if (p.persistenceToleranceBps == 0 || p.persistenceToleranceBps > BPS) revert BadParam();
        if (p.largeOpValueWei == 0) revert BadParam();
        if (p.rampDuration < MIN_RAMP_DURATION || p.rampDuration > MAX_RAMP_DURATION) {
            revert BadParam();
        }
    }
}
