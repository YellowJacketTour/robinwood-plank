// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ReentrancyGuard} from "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import {IDrandBeacon} from "./IDrandBeacon.sol";
import {PlankStakeIndex} from "./lib/PlankStakeIndex.sol";
import {PlankCappedPoolMath} from "./lib/PlankCappedPoolMath.sol";

interface IPlankLottery {
    function recordRound(uint256 roundId, bytes32 resultSeed, address winner, uint256 rakeWei) external;
    function fund() external payable;
    function creditSpilloverRound() external;
}

interface IPlankRakeRouter {
    function routeRake() external payable;
}

interface IPlankBankCredit {
    function creditFor(address player) external payable;
}

/**
 * REVIEW CANDIDATE: indexed capped survivor pool with lazy claims.
 * Stakes must be multiples of 10,000 wei; this makes indexed floors exact.
 * Settlement and ticket selection are bounded independently of seat count.
 * Not selected by the mainnet deployment script pending integration/audit.
 *
 * Immutable capped survivor-pool crash game. Targets, rule hash, beacon round
 * and funded underwriting are committed before entropy. Visible flight is a
 * replay of that result; there is no post-entropy cash-out action.
 *
 * Surviving positions receive at most stake * target / BPS. Funded floors are
 * followed by stake-proportional capped allocation; unused player funding and
 * house seed return to the recyclable buffer. Fees remain separately escrowed.
 *
 * Underwriting is houseCapBps of the spendable buffer, clamped to the income
 * budget and arithmetic bound. Protected principal is never seeded. The old
 * fixed-seed, rake-bonus and participation-age settings remain ABI metadata
 * only and do not govern capped-pool v1. Any nonempty valid book settles;
 * wallet counts/concentration cannot cancel admitted bets.
 *
 * State transitions, exits, pull credits and accounting are permissionless.
 * Oracle finality, network availability and keeper funding remain assumptions.
 */
contract PlankScalableCrash is ReentrancyGuard {
    using PlankStakeIndex for PlankStakeIndex.Index;
    uint256 public constant STAKE_QUANTUM = 10_000;
    uint256 public immutable maxRoundStakeWei;
    uint256 public immutable maxUnderwritingWei;
    mapping(uint256 => PlankStakeIndex.Index) private _indexes;
    mapping(uint256 => PlankStakeIndex.Clearing) public clearings;
    mapping(uint256 => uint256) public claimEscrow;
    mapping(uint256 => uint256) public claimedUnits;
    mapping(uint256 => mapping(address => bool)) public payoutClaimed;
    uint256 public totalClaimEscrow;
    event PayoutClaimed(uint256 indexed roundId, address indexed player, uint256 payout);
    event ClaimDustReturned(uint256 indexed roundId, uint256 amount);
    error BadQuantum();
    error ExposureLimit();
    error AlreadyClaimed();
    error UsePagination();

    uint256 private constant BPS = 10_000;
    // An arithmetic/admission ceiling, not a throughput promise. Settlement
    // uses the fixed target domain; ticket selection needs at most 30 probes.
    // Every admission still consumes a transaction and permanent chain storage.
    uint256 public constant MAX_SEATS_CEILING = 1_000_000_000;
    uint256 public constant MAX_TARGET_CEILING = 100_000_000; // 10,000x, the crash law's own maximum
    uint256 public constant MAX_STAKE_WEI = type(uint96).max; // < PlankCappedPoolMath.MAX_STAKE
    uint256 public constant MAX_KEEPER_BPS = 500;
    // Whole drand rounds of headroom past the strictly-next round after betting
    // closes, absorbing chain/drand clock skew and Orbit idle-gap timestamp jumps.
    uint256 public constant TARGET_ROUND_SAFETY_PERIODS = 20;
    bytes32 public constant RECOVERY_POLICY = keccak256("PLANK_ORIGINAL_RESULT_ONLY_V1");
    bytes32 public constant RESULT_DOMAIN = keccak256("PLANKCRASH_RESULT_V2");
    bytes32 public constant TICKET_DOMAIN = keccak256("PLANK_TICKET_V1");
    // PlankLottery.fund() on a never-touched lottery writes four zero->nonzero
    // slots (~91k gas); 100k left no margin, so the stipend is 2x that.
    uint256 public constant OVERFLOW_GAS_STIPEND = 200_000;
    // Legacy ABI metadata only. No deadline permits cancellation of a live bet.
    uint256 public constant ABANDONED_ROUND_MULTIPLIER = 30;

    enum Phase {
        BETTING,
        LIVE,
        SETTLED,
        VOIDED,
        REFUNDED
    }

    struct Seat {
        address player;
        uint96 stake;
        uint32 targetBps;
        uint128 ticketEnd;
    }

    struct Round {
        Phase phase;
        uint64 targetDrandRound;
        uint64 bettingEndsAt;
        uint64 revealNotBefore; // the target round's emission time
        bytes32 paramsHash; // PlankCappedPoolMath.paramsHash at commitment
        uint256 seed;
        uint256 playerPool;
        uint256 reserveAtLock; // house-cap base: buffer after the seed draw
        // Snapshotted at the SAME moment as reserveAtLock (round start), same
        // reasoning: a later preview/view of an already-settled round must
        // reproduce its EXACT historical vault-bonus cap, never today's
        // higher (roundsContributed only ever grows) live counter.
        uint256 vaultRoundsContributedAtLock;
        uint256 largestStake;
        uint256 crashBps;
        uint256 effectiveRakeBps;
        uint256 playerDistributable;
        uint256 totalPlayerPaid;
        uint256 totalBonus;
        uint256 houseReturned;
        address lotteryWinner;
    }

    struct Config {
        address beacon;
        address router; // PlankRakeRouter (net rake)
        address lottery; // PlankLottery (draws + overflow)
        address bank; // PlankBank: the ONLY caller of placeBetFor / creditFor sink
        uint256 bettingDurationSeconds;
        uint256 roundIntervalSeconds; // 0 = reopen immediately
        uint256 rakeBps;
        uint256 rakeFloorBps;
        uint256 rakeStepBps;
        uint256 rakeVolumeStepWei;
        uint256 keeperRewardBps;
        uint256 minParticipants;
        uint256 minPoolWei;
        uint256 minStakeWei;
        uint256 maxStakePerWalletBps;
        uint256 maxTargetBps;
        uint256 maxSeats;
        uint256 crashSeedWei;
        uint256 emissionBufferCapWei; // 0 = uncapped
        uint256 protectedPrincipalBps;
        uint256 floorBps; // CCS-2L f (ratified 7_500)
        uint256 houseCapBps; // CCS-2L GLOBAL house cap (ratified 1_000)
        uint256 houseRakeCapBps; // CCS-2L v2 actuarial house cap, of the round's rake (ratified 5_000)
        // CCS-2L v3, SPEC-monotonic-vault-positive-sum-2026-09-05 §3.4/§4.
        // 0 = feature OFF (backward-compatible default; see PlankCappedPoolMath's
        // own _houseLayer guard) -- setting maxVaultBonusBps > 0 opts a
        // deployment into the participation-count vault bonus.
        uint256 maxVaultBonusBps; // ceiling, bps of the round's rake (ratified 2_500 = 25%)
        uint256 vaultBonusDecayWad; // r, WAD-scaled, must be < 1e18 (ratified 0.999e18)
        uint256 seedBootstrapBudgetWei;
        uint256 refundTimeoutSeconds;
    }

    IDrandBeacon public immutable beacon;
    address public immutable router;
    address public immutable lottery;
    address public immutable bank;
    uint256 public immutable genesisTimestamp;
    uint256 public immutable bettingDurationSeconds;
    uint256 public immutable roundIntervalSeconds;
    uint256 public immutable rakeBps;
    uint256 public immutable rakeFloorBps;
    uint256 public immutable rakeStepBps;
    uint256 public immutable rakeVolumeStepWei;
    uint256 public immutable keeperRewardBps;
    uint256 public immutable minParticipants;
    uint256 public immutable minPoolWei;
    uint256 public immutable minStakeWei;
    uint256 public immutable maxStakePerWalletBps;
    uint256 public immutable maxTargetBps;
    uint256 public immutable maxSeats;
    uint256 public immutable crashSeedWei;
    uint256 public immutable emissionBufferCapWei;
    uint256 public immutable protectedPrincipalBps;
    uint256 public immutable floorBps;
    uint256 public immutable houseCapBps;
    uint256 public immutable houseRakeCapBps;
    uint256 public immutable maxVaultBonusBps;
    uint256 public immutable vaultBonusDecayWad;
    uint256 public immutable seedBootstrapBudgetWei;
    uint256 public immutable refundTimeoutSeconds;
    bytes32 public immutable settlementRuleId;
    uint256 public immutable settlementRuleVersion;
    bytes32 public immutable settlementParamsHash;

    uint256 public currentRoundId;
    uint256 public reserve;
    uint256 public protectedPrincipal;
    uint256 public seedBudget;
    uint256 public qualifiedVolume;
    uint256 public pendingRake; // escrowed net rake, flushed to the router
    uint256 public pendingOverflow; // escrowed buffer overflow, delivered to the lottery
    uint256 public unclaimedRefunds; // voided/refunded stakes not yet pulled
    uint256 public totalOwed;
    uint256 public totalSeeded;
    uint256 public totalSeedReturned;
    // SPEC-monotonic-vault-positive-sum-2026-09-05 §3.4/§4.1. Monotone: only
    // ever incremented, by AT MOST one per real round, whichever of organic
    // rake-routing (fundCommunityReturn) or a fundVault() donation happens
    // FIRST in that round -- see the shared _creditRoundsContributed gate.
    // Reads only this counter, never a balance, so a single large donation
    // can never advance it faster than real time and real rounds allow.
    uint256 public roundsContributed;
    uint256 private _lastRoundCountedFor;
    // SPEC-monotonic-vault-positive-sum-2026-09-05 §3.5. Once this contract's
    // OWN curve is already at ~98.2% of its ceiling (25 x (1 - 0.999^4000) =
    // 24.55%, verified by direct computation), further contributing rounds
    // stop growing a curve that's effectively full and instead accelerate the
    // lottery's still-climbing curve -- the "unified economics" mechanism.
    uint256 public constant SPILLOVER_THRESHOLD_ROUNDS = 4_000;

    mapping(uint256 => Round) public rounds;
    mapping(uint256 => Seat[]) private _seats;
    mapping(uint256 => mapping(address => uint256)) public stakeOf;
    mapping(uint256 => mapping(address => uint256)) public targetOf;
    mapping(uint256 => mapping(address => bool)) public refunded;
    mapping(uint64 => uint256) public drandRoundToRoundId;
    mapping(address => uint256) public owed;

    event RoundStarted(
        uint256 indexed roundId,
        uint64 bettingEndsAt,
        uint64 targetDrandRound,
        uint64 revealNotBefore,
        uint256 seed,
        uint256 reserveAtLock,
        bytes32 paramsHash
    );
    event BetPlaced(uint256 indexed roundId, address indexed player, uint256 stake, uint256 targetBps, address indexed fundedBy);
    event RoundLocked(uint256 indexed roundId, uint256 playerPool, uint256 seatCount);
    event RoundVoided(uint256 indexed roundId, uint256 playerPool, string reason);
    event RoundSettled(
        uint256 indexed roundId,
        uint256 crashBps,
        uint256 effectiveRakeBps,
        uint256 grossRake,
        uint256 keeperReward,
        uint256 totalPlayerPaid,
        uint256 totalBonus,
        uint256 houseReturned,
        uint256 bustedToReserve,
        uint8 mode
    );
    event SeatSettled(uint256 indexed roundId, address indexed player, bool survived, uint256 playerPayout, uint256 houseBonus);
    event LotteryTicket(uint256 indexed roundId, address indexed winner, uint256 ticket, uint256 playerPool);
    event RoundRefunded(uint256 indexed roundId, uint256 playerPool, uint256 seedReturned);
    event RefundClaimed(uint256 indexed roundId, address indexed player, uint256 amount);
    event Withdrawn(address indexed player, address indexed to, uint256 amount);
    event VaultFunded(address indexed from, uint256 amount, uint256 reserveAfter);
    event CommunityReturn(uint256 amount, uint256 toPrincipal, uint256 toBuffer, uint256 reserveAfter);
    event OverflowQueued(uint256 amount, uint256 pendingTotal);
    event OverflowDelivered(uint256 amount, bool ok);
    event RakeFlushed(uint256 amount, bool ok);
    event LotteryRecordFailed(uint256 indexed roundId, address indexed winner, bytes reason);

    error ZeroAddress();
    error BadConfig();
    error BadPhase();
    error TooEarly();
    error TooLate();
    error AlreadyBet();
    error NoBet();
    error BadStake();
    error BadTarget();
    error RoundFull();
    error RandomnessNotYetAvailable();
    error RandomnessAvailable();
    error NotRouter();
    error NotLottery();
    error NotBank();
    error NothingToFund();
    error NothingToWithdraw();
    error AlreadyRefunded();
    error TransferFailed();
    error RuleMismatch();

    constructor(Config memory cfg, uint256 maxRoundStakeWei_, uint256 maxUnderwritingWei_) {
        if(maxRoundStakeWei_ == 0 || maxRoundStakeWei_ > 1e33 || maxUnderwritingWei_ > 1e33) revert ExposureLimit();
        maxRoundStakeWei = maxRoundStakeWei_; maxUnderwritingWei = maxUnderwritingWei_;

        if (cfg.beacon == address(0) || cfg.router == address(0) || cfg.lottery == address(0) || cfg.bank == address(0)) {
            revert ZeroAddress();
        }
        // The beacon, router and lottery are deployed BEFORE the crash and are
        // called from settlement: an address without code would brick the game.
        // The bank is deployed after (it takes this address), so only non-zero.
        if (cfg.beacon.code.length == 0 || cfg.router.code.length == 0 || cfg.lottery.code.length == 0) revert ZeroAddress();
        beacon = IDrandBeacon(cfg.beacon);
        router = cfg.router;
        lottery = cfg.lottery;
        bank = cfg.bank;
        uint256 period = beacon.period();
        // Two consecutive rounds must never share a target drand round.
        if (cfg.roundIntervalSeconds != 0 && cfg.roundIntervalSeconds <= (TARGET_ROUND_SAFETY_PERIODS + 1) * period) {
            revert BadConfig();
        }
        if (cfg.roundIntervalSeconds == 0 && cfg.bettingDurationSeconds < period) revert BadConfig();
        if (cfg.rakeBps > BPS || cfg.rakeFloorBps > cfg.rakeBps || cfg.rakeStepBps == 0 || cfg.rakeStepBps > BPS || cfg.rakeVolumeStepWei == 0) {
            revert BadConfig();
        }
        if (cfg.keeperRewardBps > MAX_KEEPER_BPS) revert BadConfig();
        if (cfg.minParticipants == 0 || cfg.maxStakePerWalletBps == 0 || cfg.maxStakePerWalletBps > BPS) revert BadConfig();
        if (cfg.maxTargetBps < PlankCappedPoolMath.MIN_TARGET_BPS || cfg.maxTargetBps > MAX_TARGET_CEILING) revert BadConfig();
        if (cfg.maxSeats == 0 || cfg.maxSeats > MAX_SEATS_CEILING) revert BadConfig();
        // Retired participation metadata remains range checked for ABI compatibility.
        if (cfg.minParticipants > cfg.maxSeats || cfg.minStakeWei > MAX_STAKE_WEI) revert BadConfig();
        if (cfg.minStakeWei < STAKE_QUANTUM || cfg.minStakeWei % STAKE_QUANTUM != 0) revert BadQuantum();
        if (cfg.minStakeWei > maxRoundStakeWei_) revert ExposureLimit();
        if (cfg.crashSeedWei > PlankCappedPoolMath.MAX_POT) revert BadConfig();
        if (cfg.protectedPrincipalBps > BPS) revert BadConfig();
        // The survivor floor must be payable from the rake-net pot; otherwise the
        // math's floor-degenerate branch (defensive) would be the normal case.
        if (cfg.floorBps > BPS - cfg.rakeBps || cfg.houseCapBps > BPS) revert BadConfig();
        // Actuarial identity: the house may never risk MORE than the round's
        // rake on that round (>= BPS would re-open the seed farm, F-2).
        if (cfg.houseRakeCapBps >= BPS) revert BadConfig();
        // v3 vault bonus: maxVaultBonusBps == 0 is the valid "feature off"
        // default (see PlankCappedPoolMath's own guard) so it is NOT bounded below;
        // only bounded above, same actuarial reasoning as houseRakeCapBps —
        // this additional cap must never be able to authorize MORE room than
        // houseRakeCapBps already permits. vaultBonusDecayWad must be a real
        // decay ratio strictly between 0 and 1 WAD: 0 would make the curve
        // jump to its ceiling on round 1 (defeats "constant growth, no
        // threshold" — the whole point of this mechanism), and >= 1 WAD would
        // make it non-decaying (r^n never shrinks, bonus never grows) or
        // divergent. Only checked when the feature is actually enabled — an
        // unused decay ratio on an off deployment is inert, not a real config.
        if (cfg.maxVaultBonusBps > cfg.houseRakeCapBps) revert BadConfig();
        if (cfg.maxVaultBonusBps > 0 && (cfg.vaultBonusDecayWad == 0 || cfg.vaultBonusDecayWad >= 1e18)) {
            revert BadConfig();
        }
        if (cfg.refundTimeoutSeconds == 0 || cfg.refundTimeoutSeconds > 30 days) revert BadConfig();

        genesisTimestamp = block.timestamp;
        bettingDurationSeconds = cfg.bettingDurationSeconds;
        roundIntervalSeconds = cfg.roundIntervalSeconds;
        rakeBps = cfg.rakeBps;
        rakeFloorBps = cfg.rakeFloorBps;
        rakeStepBps = cfg.rakeStepBps;
        rakeVolumeStepWei = cfg.rakeVolumeStepWei;
        keeperRewardBps = cfg.keeperRewardBps;
        minParticipants = cfg.minParticipants;
        minPoolWei = cfg.minPoolWei;
        minStakeWei = cfg.minStakeWei;
        maxStakePerWalletBps = cfg.maxStakePerWalletBps;
        maxTargetBps = cfg.maxTargetBps;
        maxSeats = cfg.maxSeats;
        crashSeedWei = cfg.crashSeedWei;
        emissionBufferCapWei = cfg.emissionBufferCapWei;
        protectedPrincipalBps = cfg.protectedPrincipalBps;
        floorBps = cfg.floorBps;
        houseCapBps = cfg.houseCapBps;
        houseRakeCapBps = cfg.houseRakeCapBps;
        maxVaultBonusBps = cfg.maxVaultBonusBps;
        vaultBonusDecayWad = cfg.vaultBonusDecayWad;
        seedBootstrapBudgetWei = cfg.seedBootstrapBudgetWei;
        seedBudget = cfg.seedBootstrapBudgetWei;
        refundTimeoutSeconds = cfg.refundTimeoutSeconds;
        settlementRuleId = keccak256("indexed-capped-survivor-pool");
        settlementRuleVersion = PlankCappedPoolMath.RULE_VERSION;
        settlementParamsHash = keccak256(abi.encode(settlementRuleId, uint256(1), floorBps, houseCapBps, STAKE_QUANTUM, maxRoundStakeWei_, maxUnderwritingWei_));

        _startRound();
    }

    // ── Round lifecycle ─────────────────────────────────────────────────

    function _params() private view returns (PlankCappedPoolMath.Params memory) {
        return PlankCappedPoolMath.Params({
            floorBps: floorBps,
            houseCapBps: houseCapBps,
            houseRakeCapBps: houseRakeCapBps,
            maxVaultBonusBps: maxVaultBonusBps,
            vaultBonusDecayWad: vaultBonusDecayWad
        });
    }

    function _nextSlot() private view returns (uint256) {
        uint256 elapsed = block.timestamp - genesisTimestamp;
        return genesisTimestamp + ((elapsed / roundIntervalSeconds) + 1) * roundIntervalSeconds;
    }

    function _startRound() private {
        currentRoundId += 1;
        uint256 id = currentRoundId;
        Round storage r = rounds[id];
        r.phase = Phase.BETTING;
        uint256 endsAt = (id == 1 || roundIntervalSeconds == 0) ? block.timestamp + bettingDurationSeconds : _nextSlot();
        r.bettingEndsAt = uint64(endsAt);
        // Bind the randomness envelope before any stake is visible.
        uint64 target = beacon.nextRoundAfter(endsAt) + uint64(TARGET_ROUND_SAFETY_PERIODS);
        if (drandRoundToRoundId[target] != 0) revert BadConfig();
        drandRoundToRoundId[target] = id;
        r.targetDrandRound = target;
        r.revealNotBefore = uint64(beacon.genesisTimestamp() + (uint256(target) - 1) * beacon.period());
        r.paramsHash = settlementParamsHash;
        uint256 seed = _drawSeed();
        r.seed = seed;
        r.reserveAtLock = _buffer();
        r.vaultRoundsContributedAtLock = roundsContributed;
        emit RoundStarted(id, r.bettingEndsAt, target, r.revealNotBefore, seed, r.reserveAtLock, r.paramsHash);
    }

    /// @dev Debit only the pre-funded nextSeed quote; protected principal and
    ///      other obligations are excluded by the spendable-buffer ledger.
    function _drawSeed() private returns (uint256 seed) {
        seed = nextSeed();
        if (seed == 0) return 0;
        reserve -= seed;
        seedBudget -= seed;
        totalSeeded += seed;
    }

    function _buffer() private view returns (uint256) {
        return reserve - protectedPrincipal;
    }

    /// @dev Credits the buffer (recyclable income) and cascades any excess
    ///      above emissionBufferCapWei to the lottery escrow (V3).
    function _creditBuffer(uint256 amount, bool isIncome) private {
        reserve += amount;
        if (isIncome) seedBudget += amount;
        uint256 cap = emissionBufferCapWei;
        if (cap != 0) {
            uint256 buf = _buffer();
            if (buf > cap) {
                uint256 excess = buf - cap;
                reserve -= excess;
                pendingOverflow += excess;
                emit OverflowQueued(excess, pendingOverflow);
            }
        }
    }

    /// @notice Commit a seat: (stake, targetBps) -- immutable for the round.
    function placeBet(uint256 targetBps) external payable nonReentrant {
        _placeBet(msg.sender, targetBps, msg.sender);
    }

    error WrongRound();

    /// @notice Bind the signed wager to the exact round shown to the player.
    function placeBetInRound(uint256 expectedRound, uint256 targetBps) external payable nonReentrant {
        if (expectedRound != currentRoundId) revert WrongRound();
        _placeBet(msg.sender, targetBps, msg.sender);
    }

    function placeBetForInRound(address player, uint256 expectedRound, uint256 targetBps) external payable nonReentrant {
        if (msg.sender != bank) revert NotBank();
        if (player == address(0)) revert ZeroAddress();
        if (expectedRound != currentRoundId) revert WrongRound();
        _placeBet(player, targetBps, msg.sender);
    }

    /// @notice Commit a seat FOR `player`, funded by the fixed PlankBank only.
    ///         A seat is one-per-player-per-round, so an OPEN third-party
    ///         funder would let anyone squat a player's seat for the round at
    ///         a bad target for the price of minStakeWei (seat-squatting /
    ///         forced-hit capture); the bank is the single funder that can
    ///         act for a player, and it only does so on the player's own
    ///         root- or session-key signature.
    function placeBetFor(address player, uint256 targetBps) external payable nonReentrant {
        if (msg.sender != bank) revert NotBank();
        if (player == address(0)) revert ZeroAddress();
        _placeBet(player, targetBps, msg.sender);
    }

    function _placeBet(address player, uint256 targetBps, address fundedBy) private {
        uint256 id = currentRoundId;
        Round storage r = rounds[id];
        if (r.phase != Phase.BETTING) revert BadPhase();
        if (block.timestamp >= r.bettingEndsAt) revert TooLate();
        if (stakeOf[id][player] != 0) revert AlreadyBet();
        uint256 stake = msg.value;
        if(stake % STAKE_QUANTUM != 0) revert BadQuantum();
        if(r.playerPool + stake > maxRoundStakeWei) revert ExposureLimit();
        if (stake == 0 || stake < minStakeWei || stake > MAX_STAKE_WEI) revert BadStake();
        if (targetBps < PlankCappedPoolMath.MIN_TARGET_BPS || targetBps > maxTargetBps) revert BadTarget();
        Seat[] storage seats = _seats[id];
        if (seats.length >= maxSeats) revert RoundFull();
        seats.push(Seat({player: player, stake: uint96(stake), targetBps: uint32(targetBps), ticketEnd: uint128(r.playerPool + stake)}));
        _indexes[id].insert(targetBps, stake / STAKE_QUANTUM);
        stakeOf[id][player] = stake;
        targetOf[id][player] = targetBps;
        r.playerPool += stake;
        if (stake > r.largestStake) r.largestStake = stake;
        emit BetPlaced(id, player, stake, targetBps, fundedBy);
    }

    /// @notice Close betting: void an empty book or go
    ///         LIVE. Permissionless; settleRound performs it implicitly.
    function lockRound() external nonReentrant {
        _lock();
    }

    function _lock() private returns (bool live) {
        uint256 id = currentRoundId;
        Round storage r = rounds[id];
        if (r.phase != Phase.BETTING) revert BadPhase();
        if (block.timestamp < r.bettingEndsAt) revert TooEarly();
        uint256 n = _seats[id].length;
        // Identity counts and concentration are not economic security. They
        // permit Sybil bypass and let a late whale cancel honest positions.
        // Any nonempty funded book settles under the same capped rule.
        if (n == 0) {
            r.phase = Phase.VOIDED;
            unclaimedRefunds += r.playerPool;
            _returnSeed(r);
            emit RoundVoided(id, r.playerPool, "empty");
            _startRound();
            return false;
        }
        r.phase = Phase.LIVE;
        emit RoundLocked(id, r.playerPool, n);
        return true;
    }

    function _returnSeed(Round storage r) private {
        uint256 seed = r.seed;
        if (seed == 0) return;
        totalSeedReturned += seed;
        _creditBuffer(seed, true); // never paid out => unspent budget
    }

    /// @notice Indexed settlement from committed stake totals. Anyone may call once
    ///         the shared beacon holds the round's target drand randomness.
    function settleRound() external nonReentrant {
        uint256 id = currentRoundId;
        Round storage r = rounds[id];
        if (r.phase == Phase.BETTING) {
            if (!_lock()) return; // voided and re-started
        }
        if (r.phase != Phase.LIVE) revert BadPhase();
        bytes32 randomness = beacon.randomnessOrZero(r.targetDrandRound);
        if (randomness == bytes32(0)) revert RandomnessNotYetAvailable();
        // S-9: a round can never settle under a different rule than it committed.
        if (r.paramsHash != settlementParamsHash) revert RuleMismatch();

        bytes32 seedHash = resultSeed(id, r.targetDrandRound, randomness);
        uint256 crashBps = _deriveCrash(seedHash);
        r.crashBps = crashBps;

        uint256 playerPool = r.playerPool;
        uint256 rake = effectiveRakeBps();
        r.effectiveRakeBps = rake;
        uint256 playerDistributable = (playerPool * (BPS - rake)) / BPS;
        r.playerDistributable = playerDistributable;
        uint256 grossRake = playerPool - playerDistributable;
        // Keeper bounty (bps of realised rake); the remainder is the rake the
        // round leaves behind, the base of BOTH actuarial caps (house, lottery).
        uint256 keeperReward = (grossRake * keeperRewardBps) / BPS;
        uint256 netRake = grossRake - keeperReward;

        Seat[] storage seats = _seats[id];
        uint256 n = seats.length;
        PlankStakeIndex.Clearing memory clearing = _indexes[id].clear(playerDistributable + r.seed, crashBps, floorBps);
        clearings[id] = clearing;
        claimEscrow[id] = clearing.allocated;
        totalClaimEscrow += clearing.allocated;
        // These source totals describe reserved claim funding. Per-position
        // rounding residue is returned only once every surviving unit is claimed.
        PlankCappedPoolMath.Result memory res;
        res.totalPlayerPaid = clearing.allocated < playerDistributable ? clearing.allocated : playerDistributable;
        res.totalBonus = clearing.allocated - res.totalPlayerPaid;
        res.houseReturned = r.seed - res.totalBonus;
        res.bustedToReserve = playerDistributable - res.totalPlayerPaid;
        res.mode = clearing.survivorUnits == 0 ? 0 : 2;
        r.totalPlayerPaid = res.totalPlayerPaid;
        r.totalBonus = res.totalBonus;
        r.houseReturned = res.houseReturned;
        // Unused seed and busted pots return to the buffer (ratified routing).
        if (res.houseReturned > 0) {
            totalSeedReturned += res.houseReturned;
            _creditBuffer(res.houseReturned, true);
        }
        if (res.bustedToReserve > 0) {
            // The capped rule reports only unused PLAYER money here. Seed
            // returns are always in houseReturned, including no-survivor rounds.
            _creditBuffer(res.bustedToReserve, true);
        }

        // Rake: keeper bounty paid now, remainder escrowed for the router.
        if (keeperReward > 0) {
            owed[msg.sender] += keeperReward;
            totalOwed += keeperReward;
        }
        pendingRake += netRake;
        qualifiedVolume += playerPool;
        r.phase = Phase.SETTLED;

        // Round-only lottery: the stake-weighted ticket among THIS round's seats.
        address winner = _ticketWinner(seats, n, seedHash, playerPool);
        r.lotteryWinner = winner;
        emit LotteryTicket(id, winner, uint256(keccak256(abi.encode(TICKET_DOMAIN, seedHash))) % playerPool, playerPool);
        // The draw must never be able to lock player money: PlankLottery.
        // recordRound is revert-free by analysis, but if it ever reverts the
        // round still settles and the failure is logged. Insufficient-gas
        // griefing (make the callee OOG, keep the caller alive) cannot skip a
        // healthy draw: the work after this call (_startRound) costs far more
        // than the 1/64 EIP-150 retains, so a starved call reverts the whole
        // transaction (proven in PlankCrash.adversarial.test.ts).
        try IPlankLottery(lottery).recordRound(id, seedHash, winner, netRake) {}
        catch (bytes memory reason) {
            emit LotteryRecordFailed(id, winner, reason);
        }

        emit RoundSettled(
            id,
            crashBps,
            rake,
            grossRake,
            keeperReward,
            res.totalPlayerPaid,
            res.totalBonus,
            res.houseReturned,
            res.bustedToReserve,
            res.mode
        );
        _startRound();
    }

    function _ticketWinner(Seat[] storage seats, uint256 n, bytes32 seedHash, uint256 playerPool)
        private
        view
        returns (address)
    {
        uint256 ticket = uint256(keccak256(abi.encode(TICKET_DOMAIN, seedHash))) % playerPool;
        uint256 low; uint256 high = n;
        while(low < high) {
            uint256 mid = (low + high) / 2;
            if(ticket < seats[mid].ticketEnd) high = mid;
            else low = mid + 1;
        }
        return seats[low].player;

    }

    error CommittedRoundCannotBeCancelled();
    /// @notice Deprecated ABI. Indexed commitments cannot be cancelled either.
    function refundRound() external view {
        if (rounds[currentRoundId].phase != Phase.LIVE) revert BadPhase();
        revert CommittedRoundCannotBeCancelled();
    }

    /// @notice Pull a voided/refunded stake into the player's ledger. Anyone
    ///         may trigger it for any player (neutral: it only credits them).
    function claimRefund(uint256 roundId, address player) external {
        Round storage r = rounds[roundId];
        if (r.phase != Phase.VOIDED && r.phase != Phase.REFUNDED) revert BadPhase();
        uint256 stake = stakeOf[roundId][player];
        if (stake == 0) revert NoBet();
        if (refunded[roundId][player]) revert AlreadyRefunded();
        refunded[roundId][player] = true;
        unclaimedRefunds -= stake;
        owed[player] += stake;
        totalOwed += stake;
        emit RefundClaimed(roundId, player, stake);
    }

    // ── Pull ledger ─────────────────────────────────────────────────────

    function withdraw() external nonReentrant {
        uint256 amount = _debit();
        (bool ok,) = msg.sender.call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit Withdrawn(msg.sender, msg.sender, amount);
    }

    /// @notice Recycle winnings into the fixed PlankBank play balance
    ///         (bank.creditFor). `bank_` must be the construction-time bank:
    ///         the crash makes no ETH call to a caller-chosen address.
    function withdrawToBank(address bank_) external nonReentrant {
        if (bank_ != bank) revert NotBank();
        uint256 amount = _debit();
        IPlankBankCredit(bank_).creditFor{value: amount}(msg.sender);
        emit Withdrawn(msg.sender, bank_, amount);
    }

    function _debit() private returns (uint256 amount) {
        amount = owed[msg.sender];
        if (amount == 0) revert NothingToWithdraw();
        owed[msg.sender] = 0;
        totalOwed -= amount;
    }

    // ── Vault funding and escrow delivery (all permissionless) ─────────

    /// @notice SPEC-monotonic-vault-positive-sum-2026-09-05 §4.1: advances
    ///         roundsContributed by AT MOST one per real round, whichever of
    ///         organic vault growth (fundCommunityReturn) or an external
    ///         fundVault() donation happens FIRST in that round. Both paths
    ///         check and set the SAME _lastRoundCountedFor, so neither can
    ///         double-count a round the other already claimed, and no amount
    ///         of donation calls -- however many, however large -- can ever
    ///         advance the counter faster than real rounds pass. Never called
    ///         for a zero-value vault credit (protectedPrincipalBps == 0 on
    ///         some deployment must not count as participation).
    function _creditRoundsContributed() private {
        uint256 id = currentRoundId;
        if (id == _lastRoundCountedFor) return;
        _lastRoundCountedFor = id;
        if (roundsContributed >= SPILLOVER_THRESHOLD_ROUNDS) {
            // Bounded, non-reverting: a paused/bricked lottery must never
            // block crash-side vault funding. Failure silently forfeits that
            // round's spillover credit; it never falls back to growing this
            // contract's own already-near-ceiling curve instead (that would
            // reopen the thing spillover exists to close off).
            try IPlankLottery(lottery).creditSpilloverRound() {} catch {}
            return;
        }
        roundsContributed += 1;
    }

    /// @notice Called by the lottery once ITS OWN curve has passed its
    ///         spillover threshold, crediting a round of participation here
    ///         instead. Mirrors the exploit-resistance of every other
    ///         `roundsContributed` write path: at most one call site
    ///         (the lottery, authenticated by address) can ever invoke this,
    ///         and it moves the counter by exactly one, unconditionally --
    ///         there is no size or amount for an attacker to inflate.
    function creditSpilloverRound() external {
        if (msg.sender != lottery) revert NotLottery();
        roundsContributed += 1;
    }

    /// @notice Donations grow the buffer and count as bootstrap income.
    function fundVault() external payable nonReentrant {
        if (msg.value == 0) revert NothingToFund();
        _creditBuffer(msg.value, true);
        _creditRoundsContributed();
        emit VaultFunded(msg.sender, msg.value, reserve);
    }

    /// @notice The router's retained community leg: protectedPrincipalBps of it
    ///         becomes floor (never spent), the rest becomes recyclable buffer.
    function fundCommunityReturn() external payable nonReentrant {
        if (msg.sender != router) revert NotRouter();
        if (msg.value == 0) revert NothingToFund();
        uint256 principal = (msg.value * protectedPrincipalBps) / BPS;
        protectedPrincipal += principal;
        reserve += principal;
        _creditBuffer(msg.value - principal, true);
        // Only real, positive vault (protectedPrincipal) growth counts as
        // participation -- a deployment with protectedPrincipalBps == 0 routes
        // every community-return wei into the recyclable buffer instead, which
        // is not the monotonic vault this counter tracks.
        if (principal > 0) _creditRoundsContributed();
        emit CommunityReturn(msg.value, principal, msg.value - principal, reserve);
    }

    /// @notice Push escrowed net rake to the router. CEI; restored on failure.
    function flushRake() external nonReentrant returns (bool ok) {
        uint256 amount = pendingRake;
        if (amount == 0) return false;
        pendingRake = 0;
        (ok,) = router.call{value: amount}(abi.encodeWithSelector(IPlankRakeRouter.routeRake.selector));
        if (!ok) pendingRake = amount;
        emit RakeFlushed(amount, ok);
    }

    /// @notice Push escrowed buffer overflow to the lottery. Bounded gas; restored on failure.
    function deliverOverflow() external nonReentrant returns (bool ok) {
        uint256 amount = pendingOverflow;
        if (amount == 0) return false;
        pendingOverflow = 0;
        (ok,) = lottery.call{value: amount, gas: OVERFLOW_GAS_STIPEND}(abi.encodeWithSelector(IPlankLottery.fund.selector));
        if (!ok) pendingOverflow = amount;
        emit OverflowDelivered(amount, ok);
    }

    // ── Pure math ───────────────────────────────────────────────────────

    /// @notice Inverse-uniform 1/m crash law (r == 0 => instant 1.00x crash).
    ///         g(m) = ln m in CCS-2L is exact ONLY for this law.
    function _deriveCrash(bytes32 seedHash) public pure returns (uint256 multiplierBps) {
        uint256 r = uint256(seedHash) % BPS;
        if (r == 0) return BPS;
        multiplierBps = (BPS * BPS) / (BPS - r);
    }

    /// @notice Domain-separate the public beacon output across chain,
    ///         deployment, beacon, game round and target round.
    function resultSeed(uint256 roundId, uint64 targetDrandRound, bytes32 drandRandomness) public view returns (bytes32) {
        return keccak256(
            abi.encode(RESULT_DOMAIN, block.chainid, address(this), address(beacon), roundId, targetDrandRound, drandRandomness)
        );
    }

    /// @notice Ratified rake staircase, identical to lib evolutionQuote().
    function effectiveRakeBpsAt(uint256 volume) public view returns (uint256) {
        uint256 possibleDrop = rakeBps - rakeFloorBps;
        uint256 maxTiers = possibleDrop == 0 ? 0 : (possibleDrop + rakeStepBps - 1) / rakeStepBps;
        uint256 earned = volume / rakeVolumeStepWei;
        uint256 tier = earned < maxTiers ? earned : maxTiers;
        uint256 drop = tier * rakeStepBps;
        if (drop > possibleDrop) drop = possibleDrop;
        return rakeBps - drop;
    }

    function effectiveRakeBps() public view returns (uint256) {
        return effectiveRakeBpsAt(qualifiedVolume);
    }

    // ── Views ───────────────────────────────────────────────────────────

    function currentRound() external view returns (Round memory) {
        return rounds[currentRoundId];
    }

    function seatsOf(uint256 roundId) external view returns (Seat[] memory) {
        if(_seats[roundId].length > 256) revert UsePagination();
        return _seats[roundId];
    }

    function seatsPage(uint256 roundId, uint256 offset, uint256 limit) external view returns(Seat[] memory page) {
        if(limit > 256) revert UsePagination();
        uint256 n = _seats[roundId].length;
        if(offset >= n) return new Seat[](0);
        if(limit > n - offset) limit = n - offset;
        page = new Seat[](limit);
        for(uint256 i; i < limit; ++i) page[i] = _seats[roundId][offset + i];
    }

    function seatCount(uint256 roundId) external view returns (uint256) {
        return _seats[roundId].length;
    }

    function buffer() external view returns (uint256) {
        return _buffer();
    }

    /// @notice What the next round will be seeded with, given the Vault now.
    function nextSeed() public view returns (uint256 seed) {
        // The same quote is used by _drawSeed: no preview/ledger divergence.
        seed = (_buffer() * houseCapBps) / BPS;
        if (seed > seedBudget) seed = seedBudget;
        if (seed > maxUnderwritingWei) seed = maxUnderwritingWei;
        if (seed > PlankCappedPoolMath.MAX_POT) seed = PlankCappedPoolMath.MAX_POT;
    }

    /// @notice A settled position's entitlement, whether claimed or not.
    ///         Use payoutClaimed to distinguish pending claims from pull credits.
    function paidOf(uint256 roundId, address player) public view returns (uint256) {
        if(rounds[roundId].phase != Phase.SETTLED) return 0;
        return PlankStakeIndex.payout(clearings[roundId], stakeOf[roundId][player], targetOf[roundId][player]);
    }

    /// Anyone may materialize a claim, but its owner alone can withdraw it.
    /// O(1) and independent of other users' claims or withdrawal behavior.
    function claimPayout(uint256 roundId, address player) external nonReentrant {
        Round storage r = rounds[roundId];
        uint256 stake = stakeOf[roundId][player];
        if(r.phase != Phase.SETTLED || stake == 0 || targetOf[roundId][player] > r.crashBps) revert NoBet();
        if(payoutClaimed[roundId][player]) revert AlreadyClaimed();
        payoutClaimed[roundId][player] = true;
        uint256 payout = paidOf(roundId, player);
        claimEscrow[roundId] -= payout; totalClaimEscrow -= payout;
        owed[player] += payout; totalOwed += payout;
        claimedUnits[roundId] += stake / STAKE_QUANTUM;
        emit PayoutClaimed(roundId, player, payout);
        if(claimedUnits[roundId] == clearings[roundId].survivorUnits) {
            uint256 dust = claimEscrow[roundId];
            if(dust != 0) {
                claimEscrow[roundId] = 0; totalClaimEscrow -= dust;
                uint256 seedDust = dust < r.totalBonus ? dust : r.totalBonus;
                r.totalBonus -= seedDust; r.houseReturned += seedDust;
                r.totalPlayerPaid -= dust - seedDust; totalSeedReturned += seedDust;
                _creditBuffer(dust, true);
                emit ClaimDustReturned(roundId, dust);
            }
        }
    }

    function previewPayout(uint256 roundId, address player, uint256 crashBps) external view returns(uint256) {
        Round storage r = rounds[roundId];
        uint256 rake = r.phase == Phase.SETTLED ? r.effectiveRakeBps : effectiveRakeBps();
        PlankStakeIndex.Clearing memory c = _indexes[roundId].clear(r.playerPool * (BPS-rake) / BPS + r.seed, crashBps, floorBps);
        return PlankStakeIndex.payout(c, stakeOf[roundId][player], targetOf[roundId][player]);
    }

    /// @notice Small-book compatibility preview. Quantized stakes reproduce
    ///         indexed entitlements; aggregate division dust stays escrowed in
    ///         the indexed implementation until all surviving units claim.
    function previewSettlement(uint256 roundId, uint256 crashBps)
        external
        view
        returns (PlankCappedPoolMath.Result memory)
    {
        return _preview(roundId, crashBps);
    }

    function _preview(uint256 roundId, uint256 crashBps) private view returns (PlankCappedPoolMath.Result memory) {
        Round storage r = rounds[roundId];
        Seat[] storage seats = _seats[roundId];
        uint256 n = seats.length;
        if(n > 256) revert UsePagination();
        PlankCappedPoolMath.Seat[] memory mseats = new PlankCappedPoolMath.Seat[](n);
        for (uint256 i = 0; i < n; i++) {
            mseats[i] = PlankCappedPoolMath.Seat({stake: seats[i].stake, targetBps: seats[i].targetBps});
        }
        uint256 rake = r.phase == Phase.SETTLED ? r.effectiveRakeBps : effectiveRakeBps();
        uint256 playerDistributable = (r.playerPool * (BPS - rake)) / BPS;
        uint256 grossRake = r.playerPool - playerDistributable;
        uint256 netRake = grossRake - (grossRake * keeperRewardBps) / BPS;
        return PlankCappedPoolMath.settle(
            playerDistributable, r.seed, crashBps, mseats, r.reserveAtLock, netRake, r.vaultRoundsContributedAtLock, _params()
        );
    }

    /// @notice Every wei this contract is responsible for (S-8). Equals
    ///         address(this).balance unless ETH was forced in.
    function accountedBalance() public view returns (uint256 total) {
        total = reserve + pendingRake + pendingOverflow + unclaimedRefunds + totalOwed + totalClaimEscrow;
        Round storage r = rounds[currentRoundId];
        if (r.phase == Phase.BETTING || r.phase == Phase.LIVE) total += r.seed + r.playerPool;
    }

    function unclassifiedSurplus() external view returns (uint256) {
        uint256 accounted = accountedBalance();
        return address(this).balance > accounted ? address(this).balance - accounted : 0;
    }
}
