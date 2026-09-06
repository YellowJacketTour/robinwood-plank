// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ReentrancyGuard} from "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import {PlankCcs2LMath} from "./lib/PlankCcs2LMath.sol";

interface IPlankCrashSpillover {
    function creditSpilloverRound() external;
}

/**
 * PlankLottery -- the site's ONE progressive lottery, on the ratified design
 * (docs/marketplank/DESIGN-vault-lottery-progressive-carve-2026-09-04.md) with
 * the actuarial hit rule of
 * docs/marketplank/RESEARCH-game-theory-lottery-seed-resolution-2026-09-05.md.
 *
 *  ROUND-ONLY ELIGIBILITY. There are no tickets, no epochs, no claimTickets.
 *  Every settled, qualified crash round IS a draw: PlankCrash picks the
 *  stake-weighted ticket holder among THAT round's seats from the round's own
 *  committed drand randomness and reports it here. A player is eligible for
 *  exactly the rounds they played.
 *
 *  ACTUARIAL HIT RULE (v2). A round's chance to hit is proportional to what
 *  the round paid into the prize, never more than the flat ceiling:
 *      c      = rakeWei * contributionBps / BPS       (the round's inflow)
 *      p      = min( 1/oddsOneIn , c / (kappa * W(P)) ),   kappa > 1
 *  so the pool's EXPECTED payout per round is at most c/kappa < c: the prize
 *  is a strict submartingale (grows in expectation every round, forever), and
 *  a round occupied by one principal nets at most c/kappa - rake < 0 for
 *  every pool size and every prize (research Thm 3, Thm 4). A flat per-round
 *  probability is provably farmable once W(P) > oddsOneIn * rake (audit F-1).
 *  There is NO forced hit: a progressive lottery pays when the ball falls.
 *
 *  THE POOL IS A POOL, NOT A METER. The headline `committedPrize` P is split by
 *  a pre-disclosed progressive carve:
 *      x(P) = xMin + (xMax - xMin) * P / (P + c)            (bps, saturating)
 *      winner receives W(P) = P * (1 - x(P)),  next board opens at S(P) = P * x(P)
 *  computed as ONE floor division so that S is non-decreasing in P with
 *  S(P+1) - S(P) <= 1, hence W = P - S is also non-decreasing: a bigger pool
 *  always means both a bigger winner take AND a bigger next seed, and
 *  W + S == P exactly. Displayed == redeemable.
 *
 *  UNCAPPED BASE. Nothing here bounds P. The next board opens at S(P) > 0.
 *
 *  PRIZE SNAPSHOT. A draw pays only `committedPrize`, the pool as it stood when
 *  the previous round settled. Funding that arrives while a round is open
 *  joins the NEXT board. (Audit L-4.)
 *
 *  FOUNDER FEE. Charged once, on fresh inflow only (design D7); the carried
 *  seed is never re-taxed.
 *
 *  Ownerless, immutable, no pause. All payouts are pull (owed/withdraw).
 */
contract PlankLottery is ReentrancyGuard {
    uint256 private constant BPS = 10_000;
    /// @dev Probability fixed point: a threshold of PROB_ONE is certainty.
    uint256 public constant PROB_ONE = 1e18;
    bytes32 public constant BALL_DOMAIN = keccak256("PLANK_BALL_V1");

    address public immutable source; // the PlankCrash that reports draws
    address payable public immutable founderSink;
    uint256 public immutable founderFeeBps;
    uint256 public immutable oddsOneIn; // flat ceiling: never better than 1/oddsOneIn
    uint256 public immutable contributionBps; // share of a round's rake that reaches this pool
    uint256 public immutable kappaBps; // actuarial loading kappa (> 1x): pool keeps >= 1-1/kappa of inflow
    uint256 public immutable carveMinBps; // x_min
    uint256 public immutable carveMaxBps; // x_max (< BPS)
    uint256 public immutable carveHalfSaturationWei; // c (base value, at roundsContributed == 0)
    // v3 PARTICIPATION-COUNT CARVE ADAPTATION (docs/marketplank/SPEC-monotonic-
    // vault-positive-sum-2026-09-05.md §5.2, corrected 2026-09-05). Adapts the
    // EXISTING, audited carve formula rather than bolting a parallel
    // mechanism alongside it: x(P) = xMin + (xMax-xMin)*P/(P+c) is DECREASING
    // in c (verified by direct computation: larger c pushes x toward xMin,
    // i.e. MORE of the pool goes to the winner, less reseeds the next board)
    // -- so for the "same pool pays the winner more over time" goal, c must
    // GROW toward carveHalfSaturationCeilingWei as roundsContributed grows,
    // never shrink. (An earlier draft of this comment had the direction
    // backwards -- shrinking c toward a floor -- which a differential test
    // against this exact carve() caught as producing the OPPOSITE of the
    // intended effect; fixed before merge.) Every existing carve() proof
    // (exact conservation W+S==P, monotonicity S(P+1)-S(P)<=1) holds for ANY
    // positive c, verified by direct computation, not just today's fixed
    // constant. 0 for both fields (the default) means the feature is OFF:
    // carveHalfSaturationWei is used unconditionally, byte-for-byte identical
    // to pre-v3 behavior.
    uint256 public immutable carveDecayWad; // r, WAD-scaled (1e18 == 1.0); 0 = feature off
    uint256 public immutable carveHalfSaturationCeilingWei; // the ceiling c grows toward

    /// @notice Net (fee-paid) money banked on the board right now.
    uint256 public pool;
    /// @notice The prize the NEXT draw pays: `pool` as of the last draw.
    uint256 public committedPrize;
    uint256 public founderEscrow;
    mapping(address => uint256) public owed;
    uint256 public totalOwed;

    uint256 public draws;
    uint256 public hits;
    uint256 public totalFunded;
    uint256 public totalFees;
    uint256 public totalWinnerPaid;
    uint256 public totalSeeded;
    uint256 public highWaterPrize;
    // SPEC-monotonic-vault-positive-sum-2026-09-05 §5.2/§4.1. Monotone: only
    // ever incremented, by AT MOST one per real round, whichever of an
    // organic funded round (fund()) or an external donation happens FIRST in
    // that round -- mirrors PlankCrash's own _creditRoundsContributed gate
    // exactly (same exploit-resistance reasoning: no amount of donations can
    // advance it faster than real rounds pass).
    uint256 public roundsContributed;
    uint256 private _lastRoundCountedFor;
    // SPEC-monotonic-vault-positive-sum-2026-09-05 §3.5, mirrored from
    // PlankCrash's identical constant: once this pool's own carve-ceiling
    // curve is already ~98.2% saturated, further contributing rounds
    // accelerate the crash vault's still-climbing curve instead.
    uint256 public constant SPILLOVER_THRESHOLD_ROUNDS = 4_000;

    event Funded(address indexed from, uint256 amount, uint256 fee, uint256 poolAfter);
    event Draw(
        uint256 indexed roundId,
        uint256 prize,
        uint256 threshold,
        bool hit,
        address indexed winner,
        uint256 winnerPaid,
        uint256 seeded,
        uint256 committedPrizeAfter
    );
    event Withdrawn(address indexed player, uint256 amount);
    event FounderFeesWithdrawn(uint256 amount);

    error ZeroAddress();
    error BadConfig();
    error UnauthorizedSource();
    error NothingToFund();
    error NothingToWithdraw();
    error TransferFailed();

    struct Config {
        address source;
        address payable founderSink;
        uint256 founderFeeBps;
        uint256 oddsOneIn;
        uint256 contributionBps;
        uint256 kappaBps;
        uint256 carveMinBps;
        uint256 carveMaxBps;
        uint256 carveHalfSaturationWei;
        // v3 vault bonus (SPEC-monotonic-vault-positive-sum-2026-09-05 §5.2).
        // 0/0 = feature off (backward-compatible default).
        uint256 carveDecayWad;
        uint256 carveHalfSaturationCeilingWei;
    }

    constructor(Config memory cfg) {
        if (cfg.source == address(0) || cfg.founderSink == address(0)) revert ZeroAddress();
        if (cfg.founderFeeBps >= BPS) revert BadConfig();
        // oddsOneIn == 1 would make every funded round a hit: the ball must
        // be a genuine draw.
        if (cfg.oddsOneIn < 2) revert BadConfig();
        // The contribution share is a fact about the rake router (community
        // leg x lottery leg); 0 would make every round un-drawable.
        if (cfg.contributionBps == 0 || cfg.contributionBps > BPS) revert BadConfig();
        // kappa > 1 is what makes the prize a STRICT submartingale and every
        // manufactured round strictly negative-EV; kappa == 1 is a martingale
        // (no growth) and kappa < 1 re-opens the drain.
        if (cfg.kappaBps <= BPS) revert BadConfig();
        // x_max < 1 is what makes W(P) increasing for ALL P (design 2.3(d));
        // x_min > 0 is what makes the structural reset S(P) > 0 for every P
        // that carries a wei; x_min < x_max is what makes the carve
        // progressive (design directive 2) rather than constant.
        if (cfg.carveMaxBps >= BPS || cfg.carveMinBps == 0 || cfg.carveMinBps >= cfg.carveMaxBps) revert BadConfig();
        if (cfg.carveHalfSaturationWei == 0) revert BadConfig();
        // v3: carveDecayWad == 0 is the valid "feature off" default, so it is
        // NOT bounded below -- only checked when the feature is actually
        // enabled (carveHalfSaturationCeilingWei > 0). A real decay ratio
        // must be strictly between 0 and 1 WAD (same reasoning as PlankCrash's
        // own vaultBonusDecayWad validation: 0 would jump the curve straight
        // to its ceiling on round 1, >= 1 WAD would never grow at all). The
        // ceiling must be strictly GREATER than the base -- c GROWS toward it
        // (see the field's own docs on why growth, not shrinkage, is the
        // correct direction) -- otherwise the curve has nothing to grow
        // toward and the feature does nothing while still costing gas.
        if (cfg.carveHalfSaturationCeilingWei > 0) {
            if (cfg.carveDecayWad == 0 || cfg.carveDecayWad >= 1e18) revert BadConfig();
            if (cfg.carveHalfSaturationCeilingWei <= cfg.carveHalfSaturationWei) revert BadConfig();
        }
        source = cfg.source;
        founderSink = cfg.founderSink;
        founderFeeBps = cfg.founderFeeBps;
        oddsOneIn = cfg.oddsOneIn;
        contributionBps = cfg.contributionBps;
        kappaBps = cfg.kappaBps;
        carveMinBps = cfg.carveMinBps;
        carveMaxBps = cfg.carveMaxBps;
        carveHalfSaturationWei = cfg.carveHalfSaturationWei;
        carveDecayWad = cfg.carveDecayWad;
        carveHalfSaturationCeilingWei = cfg.carveHalfSaturationCeilingWei;
    }

    // ── Funding (router leg, Vault overflow, donations) ─────────────────

    /// @notice Permissionless. Fee is charged here, once, on fresh inflow.
    function fund() external payable {
        if (msg.value == 0) revert NothingToFund();
        uint256 fee = (msg.value * founderFeeBps) / BPS;
        founderEscrow += fee;
        pool += msg.value - fee;
        totalFunded += msg.value;
        totalFees += fee;
        emit Funded(msg.sender, msg.value, fee, pool);
    }

    /// @notice Called by PlankCrash once ITS OWN curve has passed its
    ///         spillover threshold, crediting a round of participation here
    ///         instead. Same authentication and exploit-resistance as
    ///         `recordRound`: only `source`, by exactly one per call, with no
    ///         amount or size for an attacker to inflate.
    function creditSpilloverRound() external {
        if (msg.sender != source) revert UnauthorizedSource();
        roundsContributed += 1;
    }

    // ── The draw (called by PlankCrash at every qualified settlement) ────

    /// @param roundId the crash round that was just settled.
    /// @param resultSeed the round's domain-separated drand-derived seed.
    /// @param winner the stake-weighted ticket holder among the round's seats.
    /// @param rakeWei the rake the round left behind (net of keeper bounty).
    function recordRound(uint256 roundId, bytes32 resultSeed, address winner, uint256 rakeWei) external {
        if (msg.sender != source) revert UnauthorizedSource();
        if (winner == address(0)) revert ZeroAddress();
        // SPEC-monotonic-vault-positive-sum-2026-09-05 §5.2: advances
        // roundsContributed by exactly one per real crash round. Unlike
        // PlankCrash's own fundVault()/fundCommunityReturn() pair, fund()
        // here has no roundId to gate on at all -- this contract has no
        // reference back to PlankCrash, so "a round happened" is a fact only
        // recordRound's caller (PlankCrash itself, enforced by the
        // UnauthorizedSource check above) can ever attest to. A donor
        // calling fund() any number of times, of any size, therefore cannot
        // move this counter even indirectly: only genuine settled crash
        // rounds can, at the fixed rate of one per round.
        if (roundId != _lastRoundCountedFor) {
            _lastRoundCountedFor = roundId;
            if (roundsContributed >= SPILLOVER_THRESHOLD_ROUNDS) {
                // Bounded, non-reverting: a paused/bricked crash-side vault
                // path must never block the lottery's own draw settlement.
                // Failure silently forfeits that round's spillover credit --
                // it never falls back to growing this pool's own
                // already-near-ceiling curve instead.
                try IPlankCrashSpillover(source).creditSpilloverRound() {} catch {}
            } else {
                roundsContributed += 1;
            }
        }
        uint256 prize = committedPrize;
        if (prize == 0) {
            // Nothing banked before this round was committed: no draw.
            committedPrize = pool;
            emit Draw(roundId, 0, 0, false, winner, 0, 0, pool);
            return;
        }
        draws += 1;
        uint256 threshold = hitThreshold(rakeWei, prize);
        // hash % PROB_ONE is uniform to within 2^256 mod 1e18 / 2^256 < 1e-59.
        bool hit = uint256(keccak256(abi.encode(BALL_DOMAIN, resultSeed))) % PROB_ONE < threshold;
        uint256 winnerPaid = 0;
        uint256 seeded = 0;
        if (hit) {
            (winnerPaid, seeded) = carve(prize);
            owed[winner] += winnerPaid;
            totalOwed += winnerPaid;
            // W + S == P exactly; the post-snapshot inflow (pool - prize) stays.
            pool = pool - prize + seeded;
            hits += 1;
            totalWinnerPaid += winnerPaid;
            totalSeeded += seeded;
        }
        committedPrize = pool;
        if (pool > highWaterPrize) highWaterPrize = pool;
        emit Draw(roundId, prize, threshold, hit, winner, winnerPaid, seeded, pool);
    }

    // ── Payouts ─────────────────────────────────────────────────────────

    function withdraw() external nonReentrant {
        uint256 amount = owed[msg.sender];
        if (amount == 0) revert NothingToWithdraw();
        owed[msg.sender] = 0;
        totalOwed -= amount;
        (bool ok,) = msg.sender.call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit Withdrawn(msg.sender, amount);
    }

    /// @notice Permissionless push of the accrued founder fee to the fixed sink.
    function withdrawFounderFees() external nonReentrant {
        uint256 amount = founderEscrow;
        if (amount == 0) revert NothingToWithdraw();
        founderEscrow = 0;
        (bool ok,) = founderSink.call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit FounderFeesWithdrawn(amount);
    }

    // ── Views (displayed == redeemable) ────────────────────────────────

    /// @notice The actuarial hit threshold (PROB_ONE == certainty) for a
    ///         round that leaves `rakeWei` of rake against a prize `prize`:
    ///             min( PROB_ONE / oddsOneIn , c * PROB_ONE / (kappa * W(prize)) )
    ///         with c = rakeWei * contributionBps / BPS and W the winner's take.
    function hitThreshold(uint256 rakeWei, uint256 prize) public view returns (uint256) {
        uint256 flat = PROB_ONE / oddsOneIn;
        (uint256 winnerPaid,) = carve(prize);
        if (winnerPaid == 0) return flat;
        uint256 c = (rakeWei * contributionBps) / BPS;
        // c <= 1e33 (PlankCrash pots), so c * 1e18 * 1e4 < 1e56: no overflow.
        uint256 actuarial = (c * PROB_ONE * BPS) / (kappaBps * winnerPaid);
        return actuarial < flat ? actuarial : flat;
    }

    /// @notice The real, on-chain-verified half-saturation `c` for THIS
    ///         moment: carveHalfSaturationWei unconditionally when the v3
    ///         feature is off (carveHalfSaturationCeilingWei == 0, byte-for-
    ///         byte pre-v3 behavior), or the geometric ratchet GROWING toward
    ///         the ceiling once enabled: c = cCeiling - (cCeiling - cBase) *
    ///         r^n. Growth, not shrinkage, is the correct direction: x(P) =
    ///         xMin + (xMax-xMin)*P/(P+c) is DECREASING in c (verified by
    ///         direct computation), so a LARGER c means a SMALLER reseed
    ///         fraction and a LARGER winner take for the same pool -- which is
    ///         the actual "the game pays the winner more as it matures" goal.
    ///         Every existing carve() proof holds for ANY positive c (verified
    ///         by direct computation, not just today's fixed constant) so
    ///         this substitution changes generosity over time without
    ///         touching the formula's own conservation/monotonicity
    ///         guarantees.
    function effectiveHalfSaturationWei() public view returns (uint256) {
        if (carveHalfSaturationCeilingWei == 0) return carveHalfSaturationWei;
        uint256 rn = PlankCcs2LMath.powWad(carveDecayWad, roundsContributed);
        // carveHalfSaturationCeilingWei > carveHalfSaturationWei by
        // construction (constructor validation), so this subtraction never
        // underflows.
        uint256 range = carveHalfSaturationCeilingWei - carveHalfSaturationWei;
        return carveHalfSaturationCeilingWei - (range * rn) / 1e18;
    }

    /// @notice The progressive carve as ONE floor division:
    ///   S = P * (xMin*(P+c) + (xMax-xMin)*P) / (BPS*(P+c)),  W = P - S.
    function carve(uint256 prize) public view returns (uint256 winnerPaid, uint256 seeded) {
        if (prize == 0) return (0, 0);
        uint256 denom = prize + effectiveHalfSaturationWei();
        uint256 numer = carveMinBps * denom + (carveMaxBps - carveMinBps) * prize;
        seeded = (prize * numer) / (BPS * denom);
        winnerPaid = prize - seeded;
    }

    /// @notice Effective carve rate at `prize`, in bps (informational). Uses
    ///         the SAME effectiveHalfSaturationWei() as carve() itself, so
    ///         this figure is never stale relative to what a real draw pays.
    function carveBps(uint256 prize) external view returns (uint256) {
        if (prize == 0) return carveMinBps;
        return carveMinBps + ((carveMaxBps - carveMinBps) * prize) / (prize + effectiveHalfSaturationWei());
    }

    /// @notice What the next draw pays: the committed pool, the winner's exact
    ///         receipt and the exact amount that seeds the following board.
    function quote() external view returns (uint256 prize, uint256 winnerPaid, uint256 seeded) {
        prize = committedPrize;
        (winnerPaid, seeded) = carve(prize);
    }

    function accountedBalance() public view returns (uint256) {
        return pool + founderEscrow + totalOwed;
    }

    function unclassifiedSurplus() external view returns (uint256) {
        uint256 accounted = accountedBalance();
        return address(this).balance > accounted ? address(this).balance - accounted : 0;
    }
}
