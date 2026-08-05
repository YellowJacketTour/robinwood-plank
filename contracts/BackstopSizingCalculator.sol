// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * ============================================================================
 *  BackstopSizingCalculator — a REFERENCE CALCULATOR, and nothing else
 *
 *  NOT FOR DEPLOYMENT (same gate as every other contract in this directory).
 *
 *  READ THIS BEFORE ADDING ANYTHING TO THIS FILE
 *  ---------------------------------------------
 *  This contract HOLDS NO VALUE AND MUST NEVER HOLD ANY. It has:
 *
 *    - ZERO storage variables. Not one. Every function is `pure`; there is no
 *      slot to write and nothing to read.
 *    - ZERO payable functions. There is no `receive`, no `fallback`, and no
 *      `payable` modifier anywhere in the file, so it cannot be sent ETH.
 *    - ZERO custody of any kind. It never sees a token address, never calls
 *      `transfer`, never approves anything, and has no reference to any
 *      vault, treasury, pool or reserve.
 *
 *  A FUNDED BACKSTOP / INSURANCE RESERVE IS EXPLICITLY OUT OF SCOPE. This file
 *  answers the question "how big SHOULD a reserve be?" and stops there. It
 *  does not create one, fund one, size one automatically, or acquire any
 *  claim on one. An actual funded backstop is a custodial contract, and a
 *  custodial contract is a separate design with its own audit gate — exactly
 *  the same argument PlankGauge.sol makes about `protocolShareWad` and
 *  GlobalIndexVault.sol makes about fee sweeps. If a future change to this
 *  file introduces a state variable that holds value, a payable function, or
 *  any transfer, that change is out of scope by construction and should be
 *  rejected on sight.
 *
 *  WHAT IT COMPUTES
 *  ----------------
 *  Conditional Value-at-Risk (CVaR), also called Expected Shortfall (ES): the
 *  MEAN of the losses in the worst (1 - confidence) tail of a historical loss
 *  sample. CVaR rather than plain VaR because VaR is the cutoff itself and
 *  says nothing about how bad things are BEYOND it — two loss distributions
 *  with an identical 99% VaR can have wildly different 99% CVaR, and a
 *  reserve sized to VaR is by construction exhausted exactly when it is
 *  needed. CVaR is also coherent (sub-additive), so the CVaR of a combined
 *  book never exceeds the sum of its parts' CVaRs; VaR is not, and can
 *  perversely reward splitting a book into pieces. Basel's FRTB moved bank
 *  market-risk capital from VaR to Expected Shortfall for precisely this
 *  reason.
 *
 *  THE HONEST LIMITS, STATED UP FRONT
 *  ----------------------------------
 *  This is the EMPIRICAL (historical-simulation) estimator: it is exactly as
 *  good as the loss sample handed to it and no better.
 *
 *   - It cannot see a loss larger than the worst one in the sample. A sample
 *     that has never contained a tail event will size a reserve that has
 *     never seen a tail event.
 *   - It has no parametric tail. Fitting a Generalized Pareto tail to the
 *     exceedances would extrapolate BEYOND the sample maximum, which is the
 *     honest way to answer "what about a loss worse than any we've had" — and
 *     that fit is not practically Solidity-computable (see the same tradeoff
 *     documented at GlobalIndexVault's `realizedVolBps`).
 *   - The tail average is over `n - floor(n * confidence)` observations. At
 *     n = 10 and 99% confidence that is ONE observation, which is an average
 *     of one number and carries no statistical weight at all. `tailCount` is
 *     returned explicitly so a caller can see how thin the estimate is
 *     instead of trusting a number that looks precise.
 *   - It is unweighted and order-blind: a loss from three years ago counts as
 *     much as yesterday's, and it assumes the sample is i.i.d.
 *
 *  Callers should treat the output as a FLOOR on a defensible reserve size,
 *  not a sufficient one.
 * ============================================================================
 */
contract BackstopSizingCalculator {
    /// @notice Generation marker so a caller never has to sniff bytecode.
    uint256 public constant CALCULATOR_VERSION = 1;

    uint256 private constant BPS = 10_000;

    /// @dev Hard bound on the sample count. A caller with more history than
    /// this should down-sample off-chain; an unbounded sort here would be a
    /// denial-of-service surface on a function that has no other one.
    ///
    /// ROUND-4 CORRECTION — the bound alone was NOT the defence it was
    /// documented to be. This constant previously described itself as "a gas
    /// bound on the O(n^2) insertion sort", and the test suite measured what
    /// that actually cost: at n = 256 a reverse-sorted sample already burned
    /// 14.8M gas, and anywhere past roughly n = 300 the call could not be made
    /// at all under a 30M block. So at the documented maximum of 512 the
    /// function was, for adversarially-ordered input, simply UNCALLABLE — a
    /// cap that bounds the array length while the WORK grows quadratically
    /// inside it is not a gas bound, and calling it one hid the gap rather
    /// than closing it. The sort was replaced (see `_sortedAscending`); the
    /// 512 is retained because it is now genuinely affordable at the worst
    /// case rather than only at the best one.
    uint256 public constant MAX_SAMPLES = 512;

    error NoSamples();
    error TooManySamples();
    error BadConfidence();

    /**
     * @notice Value-at-Risk and Conditional Value-at-Risk over a historical
     * per-vault loss sample.
     *
     * @param losses  historical realised loss amounts, in wei. ANY order —
     *                the function sorts a memory copy and never mutates the
     *                caller's array beyond that copy. Caller-supplied on
     *                purpose: this repo has no on-chain loss-event log yet,
     *                and inventing one that a privileged caller writes to
     *                would be an oracle wearing a different hat.
     * @param confidenceBps confidence level in bps. 9_000 = 90%, 9_900 = 99%.
     *                Must be < 10_000: a 100% confidence level has an empty
     *                tail and no defined expected shortfall.
     *
     * @return varWei    the VaR cutoff: the SMALLEST loss that falls inside
     *                   the worst (1 - confidence) tail.
     * @return cvarWei   the CVaR / expected shortfall: the arithmetic mean of
     *                   every loss at or beyond `varWei`. Divides with FLOOR,
     *                   which understates by at most 1 wei — and the returned
     *                   figure is a reserve SIZE, so the caller should round
     *                   up when acting on it.
     * @return tailCount how many observations that mean was taken over. Read
     *                   it. A `cvarWei` computed over 1 or 2 samples is a
     *                   number, not an estimate.
     *
     * INDEX CONVENTION, stated explicitly because every CVaR implementation
     * picks one and they disagree at the boundary. With the sample sorted
     * ASCENDING into s[0..n-1]:
     *
     *     cutIndex  = floor(n * confidence)        clamped to [0, n-1]
     *     tail      = s[cutIndex .. n-1]
     *     tailCount = n - cutIndex
     *     VaR       = s[cutIndex]
     *     CVaR      = mean(tail)
     *
     * At n = 10, confidence = 90%: cutIndex = 9, tail = {s[9]}, i.e. the
     * single worst observation — which is what "the worst 10% of 10 samples"
     * means, and is the case the test suite hand-computes.
     */
    function conditionalValueAtRisk(uint256[] memory losses, uint256 confidenceBps)
        public
        pure
        returns (uint256 varWei, uint256 cvarWei, uint256 tailCount)
    {
        uint256 n = losses.length;
        if (n == 0) revert NoSamples();
        if (n > MAX_SAMPLES) revert TooManySamples();
        if (confidenceBps >= BPS) revert BadConfidence();

        uint256[] memory s = _sortedAscending(losses);

        uint256 cutIndex = (n * confidenceBps) / BPS;
        if (cutIndex >= n) cutIndex = n - 1; // unreachable given confidence < BPS; belt and braces

        varWei = s[cutIndex];
        tailCount = n - cutIndex;

        uint256 sum;
        for (uint256 i = cutIndex; i < n; i++) sum += s[i];
        cvarWei = sum / tailCount; // floors; see the note on rounding above
    }

    /// @notice `conditionalValueAtRisk`'s CVaR leg alone, for a caller that
    /// only wants the reserve figure.
    function expectedShortfall(uint256[] memory losses, uint256 confidenceBps)
        external
        pure
        returns (uint256)
    {
        (, uint256 cvarWei, ) = conditionalValueAtRisk(losses, confidenceBps);
        return cvarWei;
    }

    /// @notice `conditionalValueAtRisk`'s VaR leg alone.
    function valueAtRisk(uint256[] memory losses, uint256 confidenceBps)
        external
        pure
        returns (uint256)
    {
        (uint256 varWei, , ) = conditionalValueAtRisk(losses, confidenceBps);
        return varWei;
    }

    /**
     * @notice A CVaR figure grossed up by a coverage multiple, in bps.
     * @dev Provided because the raw CVaR is the mean of the observed tail and
     * a reserve sized to exactly its own historical mean tail loss is, by
     * construction, insufficient about half the times it is drawn on. This
     * multiplies rather than models: it does NOT extrapolate a tail and must
     * not be presented as if it does. `coverageBps` is the caller's own
     * judgement, exposed as an argument so it is visible rather than buried.
     */
    function suggestedReserveWei(
        uint256[] memory losses,
        uint256 confidenceBps,
        uint256 coverageBps
    ) external pure returns (uint256) {
        (, uint256 cvarWei, ) = conditionalValueAtRisk(losses, confidenceBps);
        // Rounds UP: this one is a reserve size, and a reserve that rounds
        // down is a reserve that is short.
        return (cvarWei * coverageBps + BPS - 1) / BPS;
    }

    /// @notice Self-describing structural facts, all hardcoded and all true by
    /// construction rather than by setting: this contract has no storage, no
    /// payable function, and no custody.
    function capabilities()
        external
        pure
        returns (bool holdsValue, bool hasStorage, bool isPayable, uint256 version)
    {
        return (false, false, false, CALCULATOR_VERSION);
    }

    // ── Internals ──────────────────────────────────────────────────────────

    /**
     * @dev ITERATIVE BOTTOM-UP MERGE SORT over a MEMORY COPY.
     *
     * ROUND-4 CORRECTION. This was an insertion sort, chosen (correctly) over
     * quicksort because it has no recursion, no pivot, and therefore no
     * adversarial input that blows the stack. That reasoning was right about
     * quicksort and incomplete about insertion sort: insertion sort has no
     * stack-blowing input but it does have a WORST-CASE INPUT, and the worst
     * case — a reverse-sorted sample, which an adversary supplies for free
     * since `losses` is caller-provided in any order — is O(n^2). Measured
     * rather than assumed: 966k gas at n = 64, 3.7M at n = 128, 14.8M at
     * n = 256, and over a 30M block somewhere around n = 300. The contract
     * advertised MAX_SAMPLES = 512 and could not actually service 512 in the
     * one ordering an attacker would pick. That is the exact shape of gap this
     * file's own header warns about — a documented protection that does not
     * protect — so it is corrected rather than re-documented.
     *
     * Bottom-up merge sort keeps every property the original choice was made
     * for and adds the missing one:
     *   - NO RECURSION and NO PIVOT, so still no stack-depth surface and still
     *     no adversarial partition;
     *   - O(n log n) on EVERY input, best and worst alike, so the cost is a
     *     function of how much history was passed and not of how it was
     *     arranged. There is no longer an ordering that is more expensive than
     *     any other, which means there is no longer an ordering to attack with.
     * The cost is one extra n-word memory buffer, which is the cheapest thing
     * in this contract.
     *
     * The caller's array is still never mutated: everything happens on the
     * copy and on the scratch buffer.
     */
    function _sortedAscending(uint256[] memory input) private pure returns (uint256[] memory s) {
        uint256 n = input.length;
        s = new uint256[](n);
        for (uint256 i = 0; i < n; i++) s[i] = input[i];
        if (n < 2) return s;

        uint256[] memory buf = new uint256[](n);
        for (uint256 width = 1; width < n; width <<= 1) {
            for (uint256 lo = 0; lo < n; lo += width << 1) {
                uint256 mid = lo + width;
                if (mid > n) mid = n;
                uint256 hi = lo + (width << 1);
                if (hi > n) hi = n;

                uint256 i = lo;
                uint256 j = mid;
                uint256 k = lo;
                while (i < mid && j < hi) {
                    if (s[i] <= s[j]) {
                        buf[k++] = s[i++];
                    } else {
                        buf[k++] = s[j++];
                    }
                }
                while (i < mid) buf[k++] = s[i++];
                while (j < hi) buf[k++] = s[j++];
            }
            // Swap the roles of the two buffers rather than copying back.
            (s, buf) = (buf, s);
        }
    }
}
