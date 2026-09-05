// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ReentrancyGuard} from "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import {IDrandBeacon} from "./IDrandBeacon.sol";
import {PlankCcs2LMath} from "./lib/PlankCcs2LMath.sol";

interface IPlankLottery {
    function recordRound(uint256 roundId, bytes32 resultSeed, address winner) external;
    function fund() external payable;
}

interface IPlankRakeRouter {
    function routeRake() external payable;
}

interface IPlankBankCredit {
    function creditFor(address player) external payable;
}

/**
 * PlankCrash -- plank.love's crash game, rebuilt on the ratified CCS-2L
 * settlement (docs/marketplank/RATIFICATION-ccs2l-2026-09-02.md) and the
 * ratified Vault/lottery design (DESIGN-vault-lottery-progressive-carve-
 * 2026-09-04.md). Successor to PlankCrashDrand; the audit that motivated every
 * change is docs/marketplank/AUDIT-contracts-hardening-2026-09-04.md.
 *
 * WHAT A ROUND IS
 *   1. _startRound (in the previous round's settle/void/refund transaction)
 *      commits the randomness envelope BEFORE any stake exists: the target
 *      drand round, its emission time, the settlement rule + parameter hash
 *      (RATIFICATION s6.2), the Vault seed, and the house-cap base
 *      (reserveAtLock = the seedable buffer after the seed draw, exactly the
 *      lib kernel's snapshot).
 *   2. placeBet(targetBps): a seat commits (stake, target) once. There is NO
 *      manual cash-out, no cash-out window, no block-number time law: the
 *      flight is purely presentational off-chain. Survival is targetBps <=
 *      crashBps, a pure function of the drand output. (Closes audit B-1.)
 *   3. lockRound (optional, permissionless; settle implies it): after betting
 *      closes the round either voids (under-threshold / whale-dominated; all
 *      stakes refundable exactly, seed returns) or goes LIVE.
 *   4. settleRound: once the beacon holds the target round, ONE pass settles
 *      every seat with PlankCcs2LMath (player layer f*s + lambda*s*ln m with
 *      the survivor floor; house layer with the GLOBAL partition-invariant
 *      cap; no per-wallet cap of any kind), credits the in-contract pull
 *      ledger, pays the keeper, escrows net rake for the router, runs the
 *      round-only lottery draw, and starts the next round. No registration
 *      window (B-4); a settled seat's payout depends only on committed data
 *      and the crash.
 *   5. refundRound: OUTCOME-INDEPENDENT long-timeout refund (B-3). If the
 *      target drand round has still not been relayed refundTimeoutSeconds
 *      after its emission time, anyone may refund the round: every stake
 *      exactly, the seed back to the Vault. settle and refund are mutually
 *      exclusive by phase; whoever holds the signature can always settle
 *      first. The refund condition never reads the outcome.
 *
 * THE VAULT (one role: the solvency floor of the house layer)
 *   reserve            the whole Vault balance
 *   protectedPrincipal a monotone floor inside it -- credited, never spent;
 *                      the buffer (reserve - protectedPrincipal) is the only
 *                      seedable money  ......................... (I1)
 *   seedBudget         cumulative-income bound: seeds drawn - seeds returned
 *                      <= bootstrap + retained rake + donations .. (V2)
 *   emissionBufferCap  buffer above the cap cascades to the lottery (V3)
 *   The seed is the lib kernel's fixed crashSeedWei, clamped to the buffer
 *   and the budget. Unused seed (houseReturned) and busted pots return to
 *   the buffer, exactly as lib/casino/simulation.ts routes them.
 *
 * RAKE: effectiveRakeBps follows the ratified staircase (lib evolutionQuote):
 *   rakeBps - min(maxTiers, qualifiedVolume / rakeVolumeStepWei) * rakeStepBps,
 *   floored at rakeFloorBps, on the volume BEFORE the settling round. The
 *   keeper bounty is keeperRewardBps of gross rake (bps of realised rake =>
 *   farm-proof); the remainder goes to PlankRakeRouter's 40/40/20 of NET.
 *
 * POSTURE: no owner, no setters, no pause, no selfdestruct, no upgrade path.
 * Every trigger is permissionless. accountedBalance() is exact (B-12).
 */
contract PlankCrash is ReentrancyGuard {
    uint256 private constant BPS = 10_000;
    // A round that cannot be settled inside ONE transaction would strand every
    // stake in it, so the ceiling is sized to the smallest per-transaction gas
    // cap the EVM has standardised: EIP-7825 (Osaka) caps a transaction at
    // 2^24 = 16,777,216 gas. All-survive settlement measures ~47k per seat
    // (one cold SSTORE to the pull ledger, lnScaled, the event) after the
    // per-seat paidOf SSTORE was replaced by a view; 256 seats ~= 12.3M, ~27%
    // headroom under that cap (512 measured past 30M before this change).
    uint256 public constant MAX_SEATS_CEILING = 256;
    uint256 public constant MAX_TARGET_CEILING = 100_000_000; // 10,000x, the crash law's own maximum
    uint256 public constant MAX_STAKE_WEI = type(uint96).max; // < PlankCcs2LMath.MAX_STAKE
    uint256 public constant MAX_KEEPER_BPS = 500;
    // Whole drand rounds of headroom past the strictly-next round after betting
    // closes, absorbing chain/drand clock skew and Orbit idle-gap timestamp jumps.
    uint256 public constant TARGET_ROUND_SAFETY_PERIODS = 20;
    bytes32 public constant RESULT_DOMAIN = keccak256("PLANKCRASH_RESULT_V2");
    bytes32 public constant TICKET_DOMAIN = keccak256("PLANK_TICKET_V1");
    // PlankLottery.fund() on a never-touched lottery writes four zero->nonzero
    // slots (~91k gas); 100k left no margin, so the stipend is 2x that.
    uint256 public constant OVERFLOW_GAS_STIPEND = 200_000;
    // A LIVE round whose randomness IS on the beacon but which nobody has
    // settled for ABANDONED_ROUND_MULTIPLIER x refundTimeoutSeconds after its
    // emission time is treated as unsettleable (bricked lottery, gas ceiling,
    // dead beacon read) and becomes refundable. Settlement stays permissionless
    // and first-come the whole time, so this never reads the outcome.
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
    }

    struct Round {
        Phase phase;
        uint64 targetDrandRound;
        uint64 bettingEndsAt;
        uint64 revealNotBefore; // the target round's emission time
        bytes32 paramsHash; // PlankCcs2LMath.paramsHash at commitment
        uint256 seed;
        uint256 playerPool;
        uint256 reserveAtLock; // house-cap base: buffer after the seed draw
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
    error NotBank();
    error NothingToFund();
    error NothingToWithdraw();
    error AlreadyRefunded();
    error TransferFailed();
    error RuleMismatch();

    constructor(Config memory cfg) {
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
        if (cfg.rakeBps > BPS || cfg.rakeFloorBps > cfg.rakeBps || cfg.rakeStepBps == 0 || cfg.rakeVolumeStepWei == 0) {
            revert BadConfig();
        }
        if (cfg.keeperRewardBps > MAX_KEEPER_BPS) revert BadConfig();
        if (cfg.minParticipants == 0 || cfg.maxStakePerWalletBps == 0 || cfg.maxStakePerWalletBps > BPS) revert BadConfig();
        if (cfg.maxTargetBps < PlankCcs2LMath.MIN_TARGET_BPS || cfg.maxTargetBps > MAX_TARGET_CEILING) revert BadConfig();
        if (cfg.maxSeats == 0 || cfg.maxSeats > MAX_SEATS_CEILING) revert BadConfig();
        // A table that can never reach quorum, or a minimum stake no seat can
        // pay, would void every round forever (no setter can repair it).
        if (cfg.minParticipants > cfg.maxSeats || cfg.minStakeWei > MAX_STAKE_WEI) revert BadConfig();
        if (cfg.crashSeedWei > PlankCcs2LMath.MAX_POT) revert BadConfig();
        if (cfg.protectedPrincipalBps > BPS) revert BadConfig();
        // The survivor floor must be payable from the rake-net pot; otherwise the
        // math's floor-degenerate branch (defensive) would be the normal case.
        if (cfg.floorBps > BPS - cfg.rakeBps || cfg.houseCapBps > BPS) revert BadConfig();
        if (cfg.refundTimeoutSeconds == 0) revert BadConfig();

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
        seedBootstrapBudgetWei = cfg.seedBootstrapBudgetWei;
        seedBudget = cfg.seedBootstrapBudgetWei;
        refundTimeoutSeconds = cfg.refundTimeoutSeconds;
        settlementRuleId = PlankCcs2LMath.RULE_ID;
        settlementRuleVersion = PlankCcs2LMath.RULE_VERSION;
        settlementParamsHash = PlankCcs2LMath.paramsHash(_params());

        _startRound();
    }

    // ── Round lifecycle ─────────────────────────────────────────────────

    function _params() private view returns (PlankCcs2LMath.Params memory) {
        return PlankCcs2LMath.Params({floorBps: floorBps, houseCapBps: houseCapBps});
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
        emit RoundStarted(id, r.bettingEndsAt, target, r.revealNotBefore, seed, r.reserveAtLock, r.paramsHash);
    }

    /// @dev The ONLY place the Vault is debited: seed = min(crashSeedWei,
    ///      buffer, seedBudget). Never below protectedPrincipal (I1); never
    ///      beyond cumulative income (V2).
    function _drawSeed() private returns (uint256 seed) {
        seed = crashSeedWei;
        uint256 buf = _buffer();
        if (seed > buf) seed = buf;
        if (seed > seedBudget) seed = seedBudget;
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
        if (stake == 0 || stake < minStakeWei || stake > MAX_STAKE_WEI) revert BadStake();
        if (targetBps < PlankCcs2LMath.MIN_TARGET_BPS || targetBps > maxTargetBps) revert BadTarget();
        Seat[] storage seats = _seats[id];
        if (seats.length >= maxSeats) revert RoundFull();
        seats.push(Seat({player: player, stake: uint96(stake), targetBps: uint32(targetBps)}));
        stakeOf[id][player] = stake;
        targetOf[id][player] = targetBps;
        r.playerPool += stake;
        if (stake > r.largestStake) r.largestStake = stake;
        emit BetPlaced(id, player, stake, targetBps, fundedBy);
    }

    /// @notice Close betting: void (under-threshold / whale-dominated) or go
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
        bool whale = r.playerPool > 0 && r.largestStake * BPS > r.playerPool * maxStakePerWalletBps;
        if (n < minParticipants || r.playerPool < minPoolWei || whale) {
            r.phase = Phase.VOIDED;
            unclaimedRefunds += r.playerPool;
            _returnSeed(r);
            emit RoundVoided(id, r.playerPool, whale ? "whale-dominated" : "under-threshold");
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

    /// @notice One-pass settlement from committed seats. Anyone may call once
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

        Seat[] storage seats = _seats[id];
        uint256 n = seats.length;
        PlankCcs2LMath.Seat[] memory mseats = new PlankCcs2LMath.Seat[](n);
        for (uint256 i = 0; i < n; i++) {
            mseats[i] = PlankCcs2LMath.Seat({stake: seats[i].stake, targetBps: seats[i].targetBps});
        }
        PlankCcs2LMath.Result memory res =
            PlankCcs2LMath.settle(playerDistributable, r.seed, crashBps, mseats, r.reserveAtLock, _params());

        uint256 paidSum = 0;
        for (uint256 i = 0; i < n; i++) {
            uint256 p = res.playerPayouts[i] + res.bonuses[i];
            address player = seats[i].player;
            bool survived = seats[i].targetBps <= crashBps;
            if (p > 0) {
                owed[player] += p;
                paidSum += p;
            }
            emit SeatSettled(id, player, survived, res.playerPayouts[i], res.bonuses[i]);
        }
        totalOwed += paidSum;
        r.totalPlayerPaid = res.totalPlayerPaid;
        r.totalBonus = res.totalBonus;
        r.houseReturned = res.houseReturned;
        // Unused seed and busted pots return to the buffer (ratified routing).
        if (res.houseReturned > 0) {
            totalSeedReturned += res.houseReturned;
            _creditBuffer(res.houseReturned, true);
        }
        if (res.bustedToReserve > 0) {
            totalSeedReturned += r.seed;
            _creditBuffer(res.bustedToReserve, true);
        }

        // Rake: keeper bounty (bps of realised rake), remainder escrowed for the router.
        uint256 keeperReward = (grossRake * keeperRewardBps) / BPS;
        if (keeperReward > 0) {
            owed[msg.sender] += keeperReward;
            totalOwed += keeperReward;
        }
        pendingRake += grossRake - keeperReward;
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
        try IPlankLottery(lottery).recordRound(id, seedHash, winner) {}
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
        uint256 acc = 0;
        for (uint256 i = 0; i < n; i++) {
            acc += seats[i].stake;
            if (ticket < acc) return seats[i].player;
        }
        return seats[n - 1].player; // unreachable: ticket < playerPool == acc
    }

    /// @notice OUTCOME-INDEPENDENT liveness escape (B-3): if the target drand
    ///         round is still un-relayed refundTimeoutSeconds after its
    ///         emission time, refund every stake exactly and return the seed.
    ///         Reverts the moment the randomness exists on the beacon, so a
    ///         settle always wins the race; the condition never reads the crash.
    ///         ABANDONED ROUND: if the randomness exists but nobody has settled
    ///         for ABANDONED_ROUND_MULTIPLIER x the timeout (settlement is
    ///         permissionless and rewarded, so only an UNSETTLEABLE round gets
    ///         here), the refund is allowed anyway so no configuration or
    ///         dependency failure can lock stakes forever.
    function refundRound() external nonReentrant {
        uint256 id = currentRoundId;
        Round storage r = rounds[id];
        if (r.phase != Phase.LIVE) revert BadPhase();
        if (block.timestamp < uint256(r.revealNotBefore) + refundTimeoutSeconds) revert TooEarly();
        bool abandoned = block.timestamp >= uint256(r.revealNotBefore) + refundTimeoutSeconds * ABANDONED_ROUND_MULTIPLIER;
        if (!abandoned && beacon.randomnessOrZero(r.targetDrandRound) != bytes32(0)) revert RandomnessAvailable();
        r.phase = Phase.REFUNDED;
        unclaimedRefunds += r.playerPool;
        uint256 seed = r.seed;
        _returnSeed(r);
        emit RoundRefunded(id, r.playerPool, seed);
        _startRound();
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

    /// @notice Donations grow the buffer and count as bootstrap income.
    function fundVault() external payable nonReentrant {
        if (msg.value == 0) revert NothingToFund();
        _creditBuffer(msg.value, true);
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
        return _seats[roundId];
    }

    function seatCount(uint256 roundId) external view returns (uint256) {
        return _seats[roundId].length;
    }

    function buffer() external view returns (uint256) {
        return _buffer();
    }

    /// @notice What the next round will be seeded with, given the Vault now.
    function nextSeed() external view returns (uint256 seed) {
        seed = crashSeedWei;
        uint256 b = _buffer();
        if (seed > b) seed = b;
        if (seed > seedBudget) seed = seedBudget;
    }

    /// @notice What a settled seat was credited (player payout + house bonus).
    ///         Recomputed from the round's committed data -- the SAME library
    ///         call that settled it -- instead of a per-seat cold SSTORE, which
    ///         was ~1/3 of settle gas. 0 for a seat that busted, for a player
    ///         without a seat, or for a round not (yet) settled.
    function paidOf(uint256 roundId, address player) external view returns (uint256) {
        Round storage r = rounds[roundId];
        if (r.phase != Phase.SETTLED) return 0;
        Seat[] storage seats = _seats[roundId];
        uint256 n = seats.length;
        for (uint256 i = 0; i < n; i++) {
            if (seats[i].player != player) continue;
            PlankCcs2LMath.Result memory res = _preview(roundId, r.crashBps);
            return res.playerPayouts[i] + res.bonuses[i];
        }
        return 0;
    }

    /// @notice Exact settlement preview for a hypothetical crash -- the SAME
    ///         library call settleRound makes (displayed == redeemable).
    function previewSettlement(uint256 roundId, uint256 crashBps)
        external
        view
        returns (PlankCcs2LMath.Result memory)
    {
        return _preview(roundId, crashBps);
    }

    function _preview(uint256 roundId, uint256 crashBps) private view returns (PlankCcs2LMath.Result memory) {
        Round storage r = rounds[roundId];
        Seat[] storage seats = _seats[roundId];
        uint256 n = seats.length;
        PlankCcs2LMath.Seat[] memory mseats = new PlankCcs2LMath.Seat[](n);
        for (uint256 i = 0; i < n; i++) {
            mseats[i] = PlankCcs2LMath.Seat({stake: seats[i].stake, targetBps: seats[i].targetBps});
        }
        uint256 rake = r.phase == Phase.SETTLED ? r.effectiveRakeBps : effectiveRakeBps();
        uint256 playerDistributable = (r.playerPool * (BPS - rake)) / BPS;
        return PlankCcs2LMath.settle(playerDistributable, r.seed, crashBps, mseats, r.reserveAtLock, _params());
    }

    /// @notice Every wei this contract is responsible for (S-8). Equals
    ///         address(this).balance unless ETH was forced in.
    function accountedBalance() public view returns (uint256 total) {
        total = reserve + pendingRake + pendingOverflow + unclaimedRefunds + totalOwed;
        Round storage r = rounds[currentRoundId];
        if (r.phase == Phase.BETTING || r.phase == Phase.LIVE) total += r.seed + r.playerPool;
    }

    function unclassifiedSurplus() external view returns (uint256) {
        uint256 accounted = accountedBalance();
        return address(this).balance > accounted ? address(this).balance - accounted : 0;
    }
}
