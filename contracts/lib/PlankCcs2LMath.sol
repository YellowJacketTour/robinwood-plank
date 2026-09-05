// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @notice Exact CCS-2L (Two-Layer Continuous Capped Settlement) arithmetic,
///         isolated as a production-shaped library for audit and differential
///         tests. This library does not select CCS-2L for production; it makes
///         the canonical variant-A rule executable on-chain, wei-for-wei
///         identical to the TypeScript reference (lib/casino/economics-ccs2l.ts)
///         and the simulation engine (docs/marketplank/sim-settlement-ccs2l/
///         engine.mjs).
///
/// SHARED FIXED-POINT CONVENTIONS (JS <-> Solidity, must never diverge):
///  - Multipliers: 1.00x == 10_000 (BPS). Accepted lock m and crash are bps.
///  - lnScaled(xBps) ~= ln(xBps / 1e4) * 1e6, floor-rounded: Q96 normalization,
///    40 bits of log2 by repeated squaring, then * 693_147 (ln 2 * 1e6) >> 40.
///    Deterministic and bit-identical across implementations by construction.
///  - lambda (informational clearing price) is premium * 1e18 / W (LAMBDA_DENOM).
///  - All divisions are floor divisions; all residue routing is deterministic.
///  - Bounds: stake <= 1e30, target <= 1e9 bps, pots <= 1e33 wei. Worst product
///    premium * w <= 1e33 * (1e30 * 2.08e7) ~ 2.1e70 < 2^256; hAvail * w and
///    stake * (m - BPS) are smaller. No unchecked blocks are used.
///
/// LAYER 1 — PLAYER purse D_players = playerPool - rake (never house-capped):
///   floor_i = floorBps * s_i / BPS
///   w_i     = s_i * lnScaled(m_i)              (cumulative hazard of the
///                                               1/(1-r) inverse-uniform law)
///   premium = D_players - sum(floors);  p_i = floor_i + premium * w_i / W
///   Integer residue (< survivorCount wei) goes to the largest-w survivor
///   (lowest index tie) so sum(p_i) == D_players EXACTLY. Defensive
///   floor-degenerate branch (pro-rata floors, same dust rule) only when
///   sum(floors) > D_players, i.e. floorBps > BPS - rakeBps.
///
/// LAYER 2 — HOUSE purse (v1.1, PARTITION-INVARIANT). Every house-protection
/// constraint is identity-independent and positively homogeneous in stake, so
/// splitting one economic position across wallets cannot raise the aggregate
/// house bonus beyond deterministic rounding dust:
///   H_avail = min(H, reserveAtLock * houseCapBps / BPS,
///                 rakeWei * houseRakeCapBps / BPS)          (GLOBAL cap)
///   w_i     = s_i * lnScaled(m_i)                          (linear in stake)
///   b_i     = min(H_avail * w_i / W, s_i * (m_i - BPS) / BPS)  (fair-odds cap,
///             linear in stake => a lawful local cap; implies the aggregate
///             constraint sum(b) <= sum(s * (m - 1)))
///   H_returned = H - sum(b_i) -> PROTECTED RESERVE (never players/treasury).
///   REMOVED (v1.0 -> v1.1): the per-WALLET reserveAtLock * bps cap — constant
///   per address, therefore split-relaxable (N wallets got N caps).
///   ADDED (v1.1 -> v2, ACTUARIAL IDENTITY): the round's house draw is capped
///   by a fraction of the round's OWN rake (rakeWei * houseRakeCapBps / BPS).
///   A fixed seed against a player-chosen pool is farmable whenever
///   seed > pool * r*w/(w-r) (~4.9% at r=4.5%, w=60%; RESEARCH-game-theory-
///   lottery-seed-resolution-2026-09-05 Thm 1). With the rake cap every
///   solo-principal round nets <= (houseRakeCapBps/BPS - 1) * rake < 0 for
///   every pool, split, target, seed and reserve (Thm 2).
///
/// NO SURVIVOR: bustedToReserve = D_players + H (ratified busted-round routing).
/// There is NO treasury cap residue anywhere, structurally.
library PlankCcs2LMath {
    uint256 internal constant BPS = 10_000;
    uint256 internal constant MIN_TARGET_BPS = 10_100;
    uint256 internal constant LAMBDA_DENOM = 1e18;
    uint256 internal constant LN2_SCALED = 693_147;
    uint256 internal constant MAX_STAKE = 1e30;
    uint256 internal constant MAX_TARGET = 1e9;
    uint256 internal constant MAX_POT = 1e33;

    /// @dev Rule identity for commitment-time persistence (see paramsHash).
    bytes32 internal constant RULE_ID = keccak256("ccs-2l");
    uint256 internal constant RULE_VERSION = 2;

    error InvalidSeat();
    error InvalidCrash();
    error InvalidPot();

    struct Seat {
        uint256 stake;
        uint256 targetBps;
    }

    struct Params {
        uint256 floorBps; // f, provisionally 7_500
        uint256 houseCapBps; // GLOBAL house-purse cap, of reserveAtLock
        uint256 houseRakeCapBps; // GLOBAL house-purse cap, of the round's own rake (v2)
    }

    struct Result {
        uint8 mode; // 0 no-survivor, 1 floor-degenerate, 2 normal
        uint256 lambda; // closed-form clearing price, informational
        uint256 totalPlayerPaid;
        uint256 totalBonus;
        uint256 houseReturned; // -> protected reserve
        uint256 bustedToReserve; // no-survivor only
        uint256 playerDust; // awarded inside the player pot (dustIndex)
        int256 dustIndex;
        uint256[] playerPayouts;
        uint256[] bonuses;
    }

    /// @notice Commitment-time parameter hash. Persist alongside the rule id at
    ///         round commitment; never re-derive settlement semantics from the
    ///         then-current configuration. Matches lib/casino/settlement-rules.ts
    ///         ccs2lParamsHash() byte-for-byte:
    ///         keccak256(abi.encode(RULE_ID, RULE_VERSION, floorBps, houseCapBps, houseRakeCapBps)).
    function paramsHash(Params memory params) internal pure returns (bytes32) {
        return keccak256(abi.encode(RULE_ID, RULE_VERSION, params.floorBps, params.houseCapBps, params.houseRakeCapBps));
    }

    /// @notice Fixed-point natural log: lnScaled(xBps) ~= ln(x/1e4)*1e6, floor.
    /// @dev Q96 normalization + 40 bits of log2 by repeated squaring; identical
    ///      to the JS reference bit-for-bit. Bounded: <= ~30 + 40 iterations.
    function lnScaled(uint256 xBps) internal pure returns (uint256) {
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

    /// @dev Per-seat pre-pass: survival, floors, hazard weights and their sums.
    struct Prep {
        uint256[] floors;
        uint256[] ws;
        bool[] survived;
        uint256 sumFloors;
        uint256 W;
        bool anySurvivor;
    }

    function _prepare(Seat[] memory seats, uint256 crashBps, uint256 floorBps_) private pure returns (Prep memory p) {
        uint256 n = seats.length;
        p.floors = new uint256[](n);
        p.ws = new uint256[](n);
        p.survived = new bool[](n);
        for (uint256 i = 0; i < n; i++) {
            uint256 s = seats[i].stake;
            uint256 m = seats[i].targetBps;
            if (s == 0 || s > MAX_STAKE || m < MIN_TARGET_BPS || m > MAX_TARGET) revert InvalidSeat();
            if (m > crashBps) continue;
            p.survived[i] = true;
            p.anySurvivor = true;
            p.floors[i] = (floorBps_ * s) / BPS;
            p.ws[i] = s * lnScaled(m); // <= 1e30 * 2.1e7 — no overflow
            p.sumFloors += p.floors[i];
            p.W += p.ws[i];
        }
    }

    /// @notice Settle one round under CCS-2L (variant A). Memory-only; no state.
    /// @param playerDistributable D_players = playerPool - rake (player money).
    /// @param seedH the round's rolled/committed seed (house money).
    /// @param reserveAtLock reserve snapshot for the GLOBAL house-purse cap.
    /// @param rakeWei the rake this round leaves behind (actuarial house cap, v2).
    function settle(
        uint256 playerDistributable,
        uint256 seedH,
        uint256 crashBps,
        Seat[] memory seats,
        uint256 reserveAtLock,
        uint256 rakeWei,
        Params memory params
    ) internal pure returns (Result memory r) {
        if (crashBps < BPS) revert InvalidCrash();
        if (playerDistributable > MAX_POT || seedH > MAX_POT || rakeWei > MAX_POT) revert InvalidPot();
        uint256 n = seats.length;
        r.playerPayouts = new uint256[](n);
        r.bonuses = new uint256[](n);
        r.dustIndex = -1;

        Prep memory p = _prepare(seats, crashBps, params.floorBps);

        if (!p.anySurvivor) {
            r.mode = 0;
            r.bustedToReserve = playerDistributable + seedH;
            return r;
        }

        _playerLayer(r, p, playerDistributable);
        _houseLayer(r, p, seats, seedH, reserveAtLock, rakeWei, params);
    }

    /// ── LAYER 1: player purse, distributed in full ──────────────────
    function _playerLayer(Result memory r, Prep memory p, uint256 playerDistributable) private pure {
        uint256 n = p.floors.length;
        uint256 paidSum = 0;
        if (p.sumFloors > playerDistributable) {
            r.mode = 1; // floor-degenerate (defensive; f > 1-rake only)
            for (uint256 i = 0; i < n; i++) {
                if (!p.survived[i]) continue;
                r.playerPayouts[i] = (playerDistributable * p.floors[i]) / p.sumFloors;
                paidSum += r.playerPayouts[i];
            }
            _awardDust(r, p.floors, p.survived, n, playerDistributable - paidSum);
        } else {
            r.mode = 2;
            uint256 premium = playerDistributable - p.sumFloors;
            // W > 0: every survivor has m >= 1.01x => lnScaled > 0.
            r.lambda = (premium * LAMBDA_DENOM) / p.W; // premium <= 1e33 — no overflow
            for (uint256 i = 0; i < n; i++) {
                if (!p.survived[i]) continue;
                // premium * ws[i] <= 1e33 * 2.1e37 = 2.1e70 < 2^256
                r.playerPayouts[i] = p.floors[i] + (premium * p.ws[i]) / p.W;
                paidSum += r.playerPayouts[i];
            }
            _awardDust(r, p.ws, p.survived, n, playerDistributable - paidSum);
        }
        r.totalPlayerPaid = playerDistributable; // exact by dust award
    }

    /// ── LAYER 2: house purse — partition-invariant (v1.1) ───────────
    function _houseLayer(
        Result memory r,
        Prep memory p,
        Seat[] memory seats,
        uint256 seedH,
        uint256 reserveAtLock,
        uint256 rakeWei,
        Params memory params
    ) private pure {
        uint256 reserveCap = (reserveAtLock * params.houseCapBps) / BPS;
        uint256 hAvail = seedH < reserveCap ? seedH : reserveCap;
        // v2 actuarial identity: the house never risks more than a fraction of
        // what THIS round paid it. Sybil-proof by construction (Thm 2).
        uint256 rakeCap = (rakeWei * params.houseRakeCapBps) / BPS;
        if (rakeCap < hAvail) hAvail = rakeCap;
        if (hAvail > 0 && p.W > 0) {
            uint256 bSum = 0;
            uint256 n = seats.length;
            for (uint256 i = 0; i < n; i++) {
                if (!p.survived[i]) continue;
                uint256 b = (hAvail * p.ws[i]) / p.W; // hAvail <= 1e33, w <= 2.1e37 — ok
                uint256 fairCap = (seats[i].stake * (seats[i].targetBps - BPS)) / BPS;
                if (b > fairCap) b = fairCap;
                r.bonuses[i] = b;
                bSum += b;
            }
            r.totalBonus = bSum;
        }
        r.houseReturned = seedH - r.totalBonus; // -> protected reserve, exact
    }

    function _awardDust(Result memory r, uint256[] memory weights, bool[] memory survived, uint256 n, uint256 dust)
        private
        pure
    {
        r.playerDust = dust;
        if (dust == 0) return;
        int256 best = -1;
        for (uint256 i = 0; i < n; i++) {
            if (!survived[i]) continue;
            if (best == -1 || weights[i] > weights[uint256(best)]) best = int256(i);
        }
        r.dustIndex = best;
        r.playerPayouts[uint256(best)] += dust;
    }
}
