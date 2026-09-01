// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @notice TEST-ONLY Continuous Capped Settlement (CCS) candidate arithmetic.
/// @dev Wei-for-wei identical to docs/marketplank/sim-settlement-ccs/engine.mjs.
///      This contract does not select CCS for production; it makes the
///      candidate executable, differential-testable, and gas-measurable.
///
/// Survivor i (survived iff targetBps <= crashBps):
///   floor_i = f * s_i / BPS
///   g_i     = lnScaled(m_i)                          (ln * 1e6, floor)
///   c_i     = s_i * min(m_i, ceilMultBps) / BPS      (disclosed payout cap)
///   p_i(l)  = min(c_i, floor_i + l * s_i * g_i / 1e18)
///   lambda* = largest l in [0, 2^90] with sum p_i(l) <= D, exact bisection,
///             fixed 90 iterations. Residual dust -> Vault.
/// Branches: all-bust (D -> vault); cap-excess (sum c <= D: pay caps, excess
/// routed to the ratified 20/40/40 split, NOT vault); floor-scaled
/// (sum floors > D: p_i = D * floor_i / sumFloors); else interior bisection.
contract PlankCcsSettlement {
    uint256 internal constant BPS = 10_000;
    uint256 internal constant MIN_TARGET_BPS = 10_100;
    uint256 internal constant LN_SCALE = 1_000_000;
    uint256 internal constant LAMBDA_DENOM = 1e18;
    uint256 internal constant LAMBDA_BITS = 90;
    uint256 internal constant LN2_SCALED = 693_147;
    uint256 internal constant MAX_STAKE = 1e30;
    uint256 internal constant MAX_TARGET = 1e9;

    error InvalidSeat();
    error InvalidCrash();

    struct Seat {
        uint256 stake;
        uint256 targetBps;
    }

    struct Params {
        uint256 floorBps; // f, provisionally 7_500
        uint256 ceilMultBps; // global cap multiplier, provisionally 500_000
    }

    struct Result {
        uint8 mode; // 0 all-bust, 1 cap-excess, 2 floor-scaled, 3 interior
        uint256 lambda;
        uint256 totalPayout;
        uint256 capExcess; // routed to ratified split off-ledger, NOT vault
        uint256 vaultRemainder;
        uint256[] payouts;
    }

    /// @notice Fixed-point natural log: lnScaled(xBps) ~= ln(x/1e4)*1e6, floor.
    /// @dev Q96 normalization + 40 bits of log2 by repeated squaring; identical
    ///      to the JS reference bit-for-bit.
    function lnScaled(uint256 xBps) public pure returns (uint256) {
        if (xBps < BPS) revert InvalidSeat();
        if (xBps == BPS) return 0;
        uint256 z = (xBps << 96) / BPS;
        uint256 k = 0;
        while (z >= (2 << 96)) {
            z >>= 1;
            k += 1;
        }
        uint256 frac = 0;
        for (uint256 i = 0; i < 40; i++) {
            z = (z * z) >> 96;
            frac <<= 1;
            if (z >= (2 << 96)) {
                frac |= 1;
                z >>= 1;
            }
        }
        uint256 log2Scaled = (k << 40) + frac;
        return (log2Scaled * LN2_SCALED) >> 40;
    }

    function seatCap(uint256 stake, uint256 targetBps, uint256 ceilMultBps) public pure returns (uint256) {
        uint256 m = targetBps < ceilMultBps ? targetBps : ceilMultBps;
        return (stake * m) / BPS;
    }

    function _paidAt(uint256 lambda, uint256 floor_, uint256 stake, uint256 g, uint256 cap)
        private
        pure
        returns (uint256)
    {
        // stake <= 1e30, g < 2.1e7 (ln(1e9/1e4)*1e6 ~ 11.5e6), lambda < 2^90
        // => lambda*stake*g < 2^90 * 1e30 * 2.1e7 ~ 2^214 — no overflow.
        uint256 p = floor_ + (lambda * stake * g) / LAMBDA_DENOM;
        return p < cap ? p : cap;
    }

    /// @notice Settle one round under CCS. Memory-only; no state.
    function settle(uint256 distributable, uint256 crashBps, Seat[] calldata seats, Params memory params)
        public
        pure
        returns (Result memory r)
    {
        if (crashBps < BPS) revert InvalidCrash();
        uint256 n = seats.length;
        r.payouts = new uint256[](n);

        uint256[] memory floors = new uint256[](n);
        uint256[] memory caps = new uint256[](n);
        uint256[] memory gs = new uint256[](n);
        bool[] memory survived = new bool[](n);
        uint256 sumFloors = 0;
        uint256 sumCaps = 0;
        uint256 anySurvivor = 0;

        for (uint256 i = 0; i < n; i++) {
            uint256 s = seats[i].stake;
            uint256 m = seats[i].targetBps;
            if (s == 0 || s > MAX_STAKE || m < MIN_TARGET_BPS || m > MAX_TARGET) revert InvalidSeat();
            if (m > crashBps) continue;
            survived[i] = true;
            anySurvivor = 1;
            floors[i] = (params.floorBps * s) / BPS;
            caps[i] = seatCap(s, m, params.ceilMultBps);
            gs[i] = lnScaled(m);
            sumFloors += floors[i];
            sumCaps += caps[i];
        }

        if (anySurvivor == 0) {
            r.mode = 0;
            r.vaultRemainder = distributable;
            return r;
        }
        if (sumCaps <= distributable) {
            r.mode = 1;
            for (uint256 i = 0; i < n; i++) {
                if (survived[i]) r.payouts[i] = caps[i];
            }
            r.totalPayout = sumCaps;
            r.capExcess = distributable - sumCaps;
            return r;
        }
        if (sumFloors > distributable) {
            r.mode = 2;
            uint256 total = 0;
            for (uint256 i = 0; i < n; i++) {
                if (!survived[i]) continue;
                r.payouts[i] = (distributable * floors[i]) / sumFloors;
                total += r.payouts[i];
            }
            r.totalPayout = total;
            r.vaultRemainder = distributable - total;
            return r;
        }

        // interior: exact bisection, fixed LAMBDA_BITS iterations
        r.mode = 3;
        uint256 lo = 0;
        uint256 hi = 1 << LAMBDA_BITS; // P(hi) = sumCaps > D guaranteed
        for (uint256 iter = 0; iter < LAMBDA_BITS; iter++) {
            uint256 mid = (lo + hi) >> 1;
            uint256 t = 0;
            for (uint256 i = 0; i < n; i++) {
                if (!survived[i]) continue;
                t += _paidAt(mid, floors[i], seats[i].stake, gs[i], caps[i]);
            }
            if (t <= distributable) lo = mid;
            else hi = mid;
        }
        r.lambda = lo;
        uint256 paid = 0;
        for (uint256 i = 0; i < n; i++) {
            if (!survived[i]) continue;
            r.payouts[i] = _paidAt(lo, floors[i], seats[i].stake, gs[i], caps[i]);
            paid += r.payouts[i];
        }
        r.totalPayout = paid;
        r.vaultRemainder = distributable - paid;
    }

    /// @notice Non-pure wrapper so hardhat reports real gas for settle().
    uint256 private _sink;

    function settleGas(uint256 distributable, uint256 crashBps, Seat[] calldata seats, Params memory params)
        external
        returns (uint256 totalPayout)
    {
        Result memory r = settle(distributable, crashBps, seats, params);
        _sink = r.totalPayout ^ r.lambda; // force execution
        return r.totalPayout;
    }
}
