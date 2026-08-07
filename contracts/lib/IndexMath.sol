// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/**
 * ============================================================================
 *  IndexMath — GlobalIndexVault's closed-form math, moved out of its bytecode
 *
 *  WHY THIS FILE EXISTS
 *  --------------------
 *  GlobalIndexVault.sol sat at 24,513 of the EIP-170 limit's 24,576 bytes —
 *  63 bytes of headroom — with `viaIR` and `runs: 1` already spent. Adding the
 *  on-chain dividend accumulator to it needed real room, and the only lever
 *  left that does not change the vault's semantics is moving code OUT of its
 *  deployed bytecode entirely.
 *
 *  WHY EXTERNAL, AND WHY THAT IS NOT THE DELEGATECALL RISK IT SOUNDS LIKE
 *  ---------------------------------------------------------------------
 *  A Solidity library only reduces the CALLER's deployed size when its
 *  functions are `external`/`public`, because `internal` library functions are
 *  inlined into the caller and save nothing. External library functions are
 *  reached by DELEGATECALL, and delegatecall is normally a trust and storage
 *  hazard — the callee runs in the caller's storage context.
 *
 *  It is not a hazard here, and the reason is structural rather than careful:
 *  EVERY function in this library is `pure`. A `pure` function cannot read or
 *  write storage, cannot read the environment, cannot call out, and cannot
 *  emit. The compiler enforces that at compile time on the library's OWN
 *  source, so the delegatecall executes code that provably cannot touch the
 *  vault's storage layout, its roles, its reserves, or its share balances. The
 *  library is also stateless — it declares no storage variables at all, so
 *  there is no layout to collide with in the first place. The library address
 *  is fixed at LINK time, baked into the vault's bytecode as an immutable
 *  constant, so there is no admin-settable target and no upgrade lever: the
 *  usual "delegatecall to a mutable address" failure mode has no address to
 *  mutate.
 *
 *  WHAT WAS AND WAS NOT MOVED, AND WHY (measured, not assumed)
 *  ----------------------------------------------------------
 *  hardhat.config.ts's header already records an earlier, FAILED attempt at
 *  exactly this, and its finding is correct and worth preserving: moving
 *  `applyCapAndRedistribute` — which takes and returns a `uint256[] memory` —
 *  made the vault BIGGER, because an external library call must ABI-encode its
 *  arguments and decode its return, and encoding a dynamic array costs more
 *  code than the loop body it replaced.
 *
 *  The rule that falls out of that measurement, and the rule this file follows:
 *  extract only functions whose arguments and returns are SCALARS. A
 *  scalar-only external call encodes to a fixed-size, straight-line memory
 *  write; a dynamic-array one drags in the encoder. Every function below takes
 *  and returns nothing but `uint256`/`bool`, and every one of them wraps a body
 *  that is arithmetically dense — square roots, multi-branch clamps, quadratic
 *  discriminants — so the moved body is large relative to the stub that
 *  replaces it. That is the whole selection criterion.
 *
 *  The bodies themselves are moved VERBATIM. Every parameter that used to be
 *  read from storage inside them is now an explicit argument passed by the
 *  vault at the call site, in the same order, with the same meaning. Nothing
 *  here rounds differently, clamps differently, or short-circuits differently
 *  from the code it replaced — the extraction commit is a pure relocation, and
 *  the unmodified pre-existing test suite is what proves it.
 * ============================================================================
 */
library IndexMath {
    uint256 private constant BPS = 10_000;

    /**
     * @notice The maximum single-constituent weight, in bps, consistent with a
     * basket HHI of `targetHhiBps` across `n` eligible constituents.
     *
     * THE DERIVATION, worked rather than asserted.
     *
     * The Herfindahl-Hirschman Index of a weight vector is HHI = sum_i w_i^2.
     * The binding configuration for a single-name cap is the one that makes a
     * given maximum weight as CHEAP as possible in HHI terms: one constituent
     * at w, and the remaining mass (1 - w) spread perfectly evenly over the
     * other (n - 1). Any other spread of that remainder has a strictly higher
     * sum of squares (by Cauchy-Schwarz / QM-AM), so this is the configuration
     * that admits the largest w for a given HHI. Hence
     *
     *     HHI(w) = w^2 + (n - 1) * ((1 - w) / (n - 1))^2
     *            = w^2 + (1 - w)^2 / (n - 1)
     *
     * Setting HHI(w) = T and writing m = n - 1:
     *
     *     m*w^2 + (1 - w)^2         = T*m
     *     m*w^2 + 1 - 2w + w^2      = T*m
     *     (m + 1)*w^2 - 2w + 1 - T*m = 0
     *     n*w^2 - 2w + (1 - T*(n - 1)) = 0
     *
     * which is a quadratic in w with a = n, b = -2, c = 1 - T*(n-1):
     *
     *     w = [2 +/- sqrt(4 - 4*n*(1 - T*(n-1)))] / (2n)
     *       = [1 +/- sqrt(1 - n*(1 - T*(n-1)))] / n
     *
     * The MAXIMUM feasible weight is the upper root, so the cap is
     *
     *     w = (1 + sqrt(1 - n*(1 - T*(n-1)))) / n                          (*)
     *
     * VERIFICATION, n = 10, T = 0.20:
     *     1 - 10*(1 - 0.2*9) = 1 - 10*(1 - 1.8) = 1 + 8 = 9; sqrt = 3
     *     w = (1 + 3)/10 = 0.40  ->  4000 bps.
     *     Check: 0.4^2 + 0.6^2/9 = 0.16 + 0.04 = 0.20 = T. Exact.
     * VERIFICATION, n = 50, T = 0.20:
     *     1 - 50*(1 - 0.2*49) = 1 - 50*(1 - 9.8) = 1 + 440 = 441; sqrt = 21
     *     w = (1 + 21)/50 = 0.44  ->  4400 bps.
     *     Check: 0.44^2 + 0.56^2/49 = 0.1936 + 0.0064 = 0.20 = T. Exact.
     *
     * AN HONEST CORRECTION TO THE OBVIOUS INTUITION. (*) is INCREASING in n,
     * not decreasing. That is not a bug in the algebra, it is what fixed-HHI
     * means: the more legs there are to absorb the remainder, the less a given
     * large leg costs in sum-of-squares, so a fixed HHI budget buys a LARGER
     * single name. The cap runs from 1/n at the feasibility boundary up to an
     * asymptote of sqrt(T) (0.4472 at T = 0.20) as n grows. The quantity that
     * does fall with n is the AVERAGE weight 1/n, which is a different number.
     * This is stated here because the intuition "more constituents must mean a
     * tighter single-name cap" is natural, widespread, and false, and a
     * contract that silently implemented the intuition instead of the algebra
     * would be wrong in a way nobody would notice.
     *
     * DEGENERATE AND INFEASIBLE CASES.
     *  - n <= 1: a single constituent is trivially 100% of the basket and the
     *    formula's (n-1) denominator is undefined. Cap = 100%.
     *  - T < 1/n: the discriminant goes negative. This is not a numerical
     *    accident either — the MINIMUM achievable HHI for n names is 1/n
     *    (equal weights), so a target below it is unreachable by any
     *    allocation. The tightest honest answer is the equal-weight cap, 1/n,
     *    and that is what is returned. (At T = 0.20 this covers n = 2, 3, 4.)
     *
     * KNOWN, REAL, UNCLOSED GAP: CORRELATION BLINDNESS.
     * HHI measures SIZE concentration and nothing else. Ten constituents at
     * 10% each score a perfect HHI of 0.10 whether they are ten unrelated
     * collections or ten wrappers around the same underlying asset, moving
     * together, drawing down together, and going bid-less together. This cap
     * therefore bounds "how much of the basket is one NAME", not "how much of
     * the basket is one BET", and the two can be arbitrarily far apart. Closing
     * it would need a real correlation estimate over per-constituent price
     * history — a covariance matrix over n series, recomputed as prices move —
     * which this contract cannot compute cheaply or honestly on-chain, and
     * which would reintroduce exactly the off-chain-submission trust problem
     * the rest of this design refuses. It is flagged as open rather than
     * approximated: a correlation check that is cheap enough to run here would
     * be too crude to trust, and trusting a crude one is worse than knowing
     * the gap is there.
     */
    function capBpsFor(uint256 n, uint256 targetHhiBps) internal pure returns (uint256) {
        if (n <= 1) return BPS; // one leg IS the basket

        uint256 t = targetHhiBps;
        // lhs/rhs are (*)'s discriminant, multiplied through by BPS to stay in
        // integers: sign(1 - n + T*n*(n-1)) == sign(BPS + T_bps*n*(n-1) - BPS*n).
        uint256 lhs = t * n * (n - 1) + BPS;
        uint256 rhs = BPS * n;
        if (lhs <= rhs) return BPS / n; // infeasible target: equal weights is the tightest there is

        uint256 dNum = lhs - rhs; // == BPS * discriminant
        // sqrt(discriminant) * BPS == sqrt(dNum * BPS), so the whole result
        // stays in bps with a single integer square root and no fixed-point
        // scaling error. `Math.sqrt` floors, which floors the cap — the
        // conservative direction.
        uint256 w = (BPS + Math.sqrt(dNum * BPS)) / n;

        uint256 equalWeight = BPS / n;
        if (w < equalWeight) w = equalWeight; // flooring can never take it below 1/n
        if (w > BPS) w = BPS;
        return w;
    }

    /**
     * @notice Curve-flavoured imbalance fee: free at the margin, steeper the
     * more concentrated the ask. `d` is the requested amount as a fraction of
     * what the constituent has left, in bps; the fee is base + slope*d, capped.
     * A withdrawal that takes 100% of the remaining leg pays base + slope.
     *
     * DIRECTION SYMMETRY (audited, and the finding stated in full).
     * This is the ONE fee formula, and BOTH priced paths charge it:
     * `mintSingleAsset` (buy side) and `_previewSingleExit` (sell side) each
     * call exactly this function with exactly the same shape of arguments —
     * (the non-pro-rata amount, the depth it is charged against). There is no
     * `isBuy` argument, no direction branch, no second fee table, and no
     * directional multiplier anywhere in it: for identical (amount, against),
     * a buy and a sell are charged the identical number of bps. That is what
     * makes a round trip strictly loss-making rather than free in one
     * direction, and the audit suite asserts it directly.
     */
    function imbalanceFeeBps(
        uint256 amount,
        uint256 against,
        uint256 baseBps,
        uint256 slopeBps,
        uint256 maxBps
    ) internal pure returns (uint256 fee) {
        if (against == 0) return maxBps;
        uint256 d = (amount * BPS) / against;
        if (d > BPS) d = BPS;
        fee = baseBps + (slopeBps * d) / BPS;
        if (fee > maxBps) fee = maxBps;
    }

    /**
     * @notice The DIRECTIONAL mint-side adjustment, layered on top of the
     * depth-based fee `imbalanceFeeBps` already charges.
     *
     * A deposit into an UNDERWEIGHT constituent moves the basket toward its
     * target vector, so it is discounted; a deposit into an OVERWEIGHT one
     * moves it away, so it is surcharged. Both are measured against the same
     * `targetWeightsBps()` vector the rest of the contract publishes, so there
     * is no second, private notion of "correct" anywhere.
     *
     * TWO CONSERVATIVE CHOICES, both resolved in existing holders' favour
     * where the spec left the edge open (§2.9 doctrine):
     *
     *  1. The discount FLOORS AT `baseBps` and can never reach zero, let alone
     *     go negative. A true negative fee — paying someone to rebalance —
     *     would be a transfer from the pool to a depositor, i.e. an
     *     externalisation path, i.e. exactly the class of thing §2.8's anchor
     *     rule exists to keep off this contract. Rebalancing is rewarded by
     *     charging less, never by paying out.
     *  2. A constituent with a ZERO target weight (ramping in from t=0, or a
     *     leg whose metric is unset) pays the maximum. Unknown is treated as
     *     overweight, never as underweight. The vault applies that branch at
     *     the call site, before it gets here, because it also covers the
     *     "token is not in the vector at all" case.
     */
    function mintFeeBps(
        uint256 depthFee,
        uint256 currentBps,
        uint256 targetBps,
        uint256 baseBps,
        uint256 slopeBps,
        uint256 maxBps
    ) internal pure returns (uint256) {
        if (currentBps < targetBps) {
            // UNDERWEIGHT: discount, proportional to how far below target it
            // sits, floored at the base fee.
            uint256 gap = ((targetBps - currentBps) * BPS) / targetBps; // 0..BPS
            uint256 relief = (depthFee * gap) / BPS;
            uint256 fee = depthFee > relief ? depthFee - relief : 0;
            return fee < baseBps ? baseBps : fee;
        }

        // OVERWEIGHT: surcharge on the same slope the depth fee uses, capped.
        uint256 over = ((currentBps - targetBps) * BPS) / targetBps;
        if (over > BPS) over = BPS;
        uint256 up = depthFee + (slopeBps * over) / BPS;
        return up > maxBps ? maxBps : up;
    }

    /**
     * @notice SIZE-PROPORTIONAL PERSISTENCE. How many settled checkpoints an
     * operation worth `ethValue` must see a constituent's band hold across.
     *
     * A fixed N is defeatable by a patient attacker with a simple, cheap
     * plan: hold the pushed price for exactly N checkpoints, take the whole
     * basket-moving trade on checkpoint N, and let the price fall on N+1. The
     * cost of holding is linear in N and the profit is linear in SIZE, so at
     * a fixed N there is always a size at which the attack pays. Making the
     * requirement grow with size removes that: the bigger the extraction, the
     * longer the push has to be financed before it can be cashed.
     *
     *     required = base + floor(ethValue / unit) - 1
     *
     * clamped above at `obsSlots`.
     */
    function requiredCheckpoints(
        uint256 ethValue,
        uint256 base,
        uint256 unit,
        uint256 obsSlots
    ) internal pure returns (uint256) {
        if (ethValue < unit) return base; // not a large op at all
        uint256 steps = ethValue / unit; // >= 1
        uint256 required = base + steps - 1;
        return required > obsSlots ? obsSlots : required;
    }

    /**
     * @notice A constituent's target-weight scaling, 0..BPS.
     *
     * RAMP-IN (active): a new constituent reaches its target over a real
     * window, never in one block (§2.7 step 4). A stale constituent's ramp-in
     * is FROZEN at zero progress — §2.9's "freeze further weight ramp-in", and
     * the vault signals that by passing `frozen = true`.
     *
     * RAMP-OUT (deactivated): symmetric. A queued removal used to drop the
     * target weight from full to zero the instant it executed, which is exactly
     * the cliff §2.7 forbids on the way in: it publishes "sell all of this leg,
     * now" to every rebalancing solver in one block, and it does so for the
     * constituent most likely to be illiquid, since illiquidity is usually why
     * it is being removed. The target therefore decays linearly to zero over
     * the same `rampDuration`, so the intent is public and gradual and the
     * order is not.
     *
     * Staleness does NOT freeze a ramp-OUT — the vault passes `frozen` only on
     * the active branch. Freezing it would pin a silent, being-removed
     * constituent at full target weight: the opposite of the conservative
     * direction, and the one case where "freeze on stale" would help an
     * attacker rather than the basket.
     */
    function rampFactorBps(
        bool active,
        uint256 elapsed,
        uint256 rampDuration,
        bool frozen
    ) internal pure returns (uint256) {
        if (active) {
            if (rampDuration == 0) return BPS;
            if (frozen) elapsed = 0;
            if (elapsed >= rampDuration) return BPS;
            return (elapsed * BPS) / rampDuration;
        }
        if (rampDuration == 0) return 0;
        if (elapsed >= rampDuration) return 0;
        return BPS - (elapsed * BPS) / rampDuration;
    }
}
