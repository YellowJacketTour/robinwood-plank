// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ReentrancyGuard} from "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import {PullPayment} from "@openzeppelin/contracts/security/PullPayment.sol";

/// Pari-mutuel horse race. Real collateral only: payouts are strictly bounded
/// by the round's real distributable pool, split among bettors on the
/// winning horse in proportion to their real stake. No house edge, no
/// funded bankroll, no oracle. Winner is drawn from the blockhash of a
/// block that does not exist yet at bet-lock time (see PlankCrashV2.sol for
/// the same reasoning on why that specific randomness source closes the
/// reveal-ordering front-running exploit that a secret-seed design would
/// have). Two-phase register+claim so payout order can never matter, same
/// pattern as PlankCrashV2.sol.
contract PlankDerby is ReentrancyGuard, PullPayment {
    enum Phase { BETTING, LOCKED, FINISHED, SETTLED }

    struct Race {
        Phase phase;
        uint256 bettingEndsAt;
        uint256 lockBlock;
        uint256 targetBlock;
        uint256 winningHorse; // valid only once phase >= FINISHED
        uint256 pool;
        uint256 distributable;
        uint256 totalWinningWeight;
        uint256 registrationDeadlineBlock;
    }

    uint256 public constant NUM_HORSES = 6;

    uint256 public immutable bettingDurationSeconds;
    uint256 public immutable revealDelayBlocks;
    uint256 public immutable registrationWindowBlocks;
    uint256 public immutable rakeBps;
    uint256 public immutable minParticipants;
    uint256 public immutable minPoolSize;
    uint256 public immutable maxStakePerWalletBps; // of pool, e.g. 5000 = 50%
    uint256 public immutable keeperRewardBps; // of rake, paid to whoever calls finishRace()
    address public immutable treasury;

    uint256 public accumulatedRake;
    uint256 public currentRaceId;

    mapping(uint256 => Race) public races;
    // raceId => horseId => total staked on that horse (for odds display)
    mapping(uint256 => mapping(uint256 => uint256)) public horsePool;
    // raceId => bettor => horseId+1 they backed (0 = no bet)
    mapping(uint256 => mapping(address => uint256)) public horseOf;
    mapping(uint256 => mapping(address => uint256)) public stakeOf;
    mapping(uint256 => mapping(address => bool)) public registered;
    mapping(uint256 => mapping(address => bool)) public claimed;
    mapping(uint256 => uint256) public participantCount;
    mapping(uint256 => bool) public voided;
    mapping(uint256 => mapping(address => bool)) public carriedForward;
    mapping(uint256 => mapping(address => uint256)) private _weightOf;

    event RaceStarted(uint256 indexed raceId, uint256 bettingEndsAt);
    event BetPlaced(uint256 indexed raceId, address indexed player, uint256 indexed horseId, uint256 amount);
    event RaceLocked(uint256 indexed raceId, uint256 lockBlock, uint256 targetBlock);
    event RaceVoided(uint256 indexed raceId, uint256 rolledOverPool, string reason);
    event RaceFinished(uint256 indexed raceId, uint256 winningHorse);
    event ResultRegistered(uint256 indexed raceId, address indexed player, bool won, uint256 weight);
    event Claimed(uint256 indexed raceId, address indexed player, uint256 payout);

    error BadPhase();
    error TooEarly();
    error TooLate();
    error AlreadyBet();
    error NoBet();
    error ZeroAddress();
    error BadHorse();
    error AlreadyRegistered();
    error AlreadyClaimed();
    error NotWinner();
    error StakeExceedsCap();
    error TargetBlockNotYetMined();
    error TargetBlockExpired();

    constructor(
        uint256 _bettingDurationSeconds,
        uint256 _revealDelayBlocks,
        uint256 _registrationWindowBlocks,
        uint256 _rakeBps,
        uint256 _minParticipants,
        uint256 _minPoolSize,
        uint256 _maxStakePerWalletBps,
        uint256 _keeperRewardBps,
        address _treasury
    ) {
        if (_treasury == address(0)) revert ZeroAddress();
        bettingDurationSeconds = _bettingDurationSeconds;
        revealDelayBlocks = _revealDelayBlocks;
        registrationWindowBlocks = _registrationWindowBlocks;
        rakeBps = _rakeBps;
        minParticipants = _minParticipants;
        minPoolSize = _minPoolSize;
        maxStakePerWalletBps = _maxStakePerWalletBps;
        keeperRewardBps = _keeperRewardBps;
        treasury = _treasury;
        _startRace(0);
    }

    // ── Race lifecycle ───────────────────────────────────────────────────

    function _startRace(uint256 rolledOver) private {
        currentRaceId += 1;
        Race storage r = races[currentRaceId];
        r.phase = Phase.BETTING;
        r.bettingEndsAt = block.timestamp + bettingDurationSeconds;
        r.pool = rolledOver;
        emit RaceStarted(currentRaceId, r.bettingEndsAt);
    }

    function placeBet(uint256 horseId) external payable nonReentrant {
        if (horseId >= NUM_HORSES) revert BadHorse();
        Race storage r = races[currentRaceId];
        if (r.phase != Phase.BETTING) revert BadPhase();
        if (block.timestamp >= r.bettingEndsAt) revert TooLate();
        if (horseOf[currentRaceId][msg.sender] != 0) revert AlreadyBet();

        // Same structural exemption as PlankCrashV2.sol's placeBet(): the
        // very first bet of a race is necessarily 100% of the resulting
        // pool, so a percentage cap is only meaningful once a real second
        // participant exists to be disproportionate relative to.
        uint256 poolAfter = r.pool + msg.value;
        if (r.pool != 0 && msg.value * 10000 > poolAfter * maxStakePerWalletBps) {
            revert StakeExceedsCap();
        }

        horseOf[currentRaceId][msg.sender] = horseId + 1;
        stakeOf[currentRaceId][msg.sender] = msg.value;
        horsePool[currentRaceId][horseId] += msg.value;
        r.pool = poolAfter;
        participantCount[currentRaceId] += 1;
        emit BetPlaced(currentRaceId, msg.sender, horseId, msg.value);
    }

    /// Same non-custodial "real collateral or no launch" recovery path as
    /// PlankCrashV2.carryForwardStake(): a voided race's pool total does NOT
    /// move automatically (individual stakeOf/horseOf entries stay keyed
    /// to the dead race id), so each affected bettor pulls their own stake
    /// into whatever race is currently open, bounded and per-user.
    function carryForwardStake(uint256 fromRaceId) external nonReentrant {
        if (!voided[fromRaceId]) revert BadPhase();
        if (carriedForward[fromRaceId][msg.sender]) revert AlreadyClaimed();
        uint256 amount = stakeOf[fromRaceId][msg.sender];
        uint256 horseId = horseOf[fromRaceId][msg.sender];
        if (amount == 0 || horseId == 0) revert NoBet();

        Race storage cur = races[currentRaceId];
        if (cur.phase != Phase.BETTING) revert BadPhase();
        if (horseOf[currentRaceId][msg.sender] != 0) revert AlreadyBet();

        uint256 poolAfter = cur.pool + amount;
        if (cur.pool != 0 && amount * 10000 > poolAfter * maxStakePerWalletBps) {
            revert StakeExceedsCap();
        }

        carriedForward[fromRaceId][msg.sender] = true;
        horseOf[currentRaceId][msg.sender] = horseId;
        stakeOf[currentRaceId][msg.sender] = amount;
        horsePool[currentRaceId][horseId - 1] += amount;
        cur.pool = poolAfter;
        participantCount[currentRaceId] += 1;
        emit BetPlaced(currentRaceId, msg.sender, horseId - 1, amount);
    }

    function lockRace() external nonReentrant {
        uint256 id = currentRaceId;
        Race storage r = races[id];
        if (r.phase != Phase.BETTING) revert BadPhase();
        if (block.timestamp < r.bettingEndsAt) revert TooEarly();

        if (participantCount[id] < minParticipants || r.pool < minPoolSize) {
            emit RaceVoided(id, r.pool, "under-threshold");
            voided[id] = true;
            r.phase = Phase.SETTLED;
            _startRace(0);
            return;
        }

        r.phase = Phase.LOCKED;
        r.lockBlock = block.number;
        r.targetBlock = block.number + revealDelayBlocks;
        emit RaceLocked(id, r.lockBlock, r.targetBlock);
    }

    /// Draws the winning horse from the blockhash of a block that did not
    /// exist at lock time -- unknowable to anyone, including the deployer,
    /// until it is mined. Same entropy source and 256-block window
    /// constraint as PlankCrashV2.revealEntropy(). Permissionless, with a
    /// real keeper reward out of the round's own rake (never out of
    /// bettors' distributable pool) -- see voidStaleRound's own comment
    /// for why this incentive matters given Robinhood Chain's real block
    /// time.
    function finishRace(uint256 raceId) external nonReentrant {
        Race storage r = races[raceId];
        if (r.phase != Phase.LOCKED) revert BadPhase();
        if (block.number <= r.targetBlock) revert TargetBlockNotYetMined();
        if (block.number > r.targetBlock + 256) revert TargetBlockExpired();

        bytes32 entropy = blockhash(r.targetBlock);
        r.winningHorse = uint256(entropy) % NUM_HORSES;
        r.distributable = (r.pool * (10000 - rakeBps)) / 10000;
        r.registrationDeadlineBlock = block.number + registrationWindowBlocks;
        r.phase = Phase.FINISHED;

        uint256 rake = r.pool - r.distributable;
        uint256 keeperReward = (rake * keeperRewardBps) / 10000;
        accumulatedRake += rake - keeperReward;
        if (keeperReward > 0) _asyncTransfer(msg.sender, keeperReward);

        emit RaceFinished(raceId, r.winningHorse);
        _startRace(0);
    }

    /// Anti-griefing liveness fallback -- without this, a race that nobody
    /// calls finishRace() on before blockhash(targetBlock) falls out of
    /// the EVM's real 256-block window would hang in LOCKED forever with
    /// every bettor's real stake trapped inside it (finishRace() itself
    /// reverts once past that window, and no other function can move a
    /// LOCKED race to any other phase). On Robinhood Chain's real ~100ms
    /// block time that 256-block window is only ~25 real seconds --
    /// exactly the same liveness gap PlankCrashV2.voidStaleRound() exists
    /// to close for its own blockhash-based entropy, ported here
    /// verbatim. Permissionless; voids exactly like an under-threshold
    /// race in lockRace() -- pool total doesn't move automatically, each
    /// bettor carries their own stake forward via the existing
    /// carryForwardStake() path.
    function voidStaleRound(uint256 raceId) external nonReentrant {
        Race storage r = races[raceId];
        if (r.phase != Phase.LOCKED) revert BadPhase();
        if (block.number <= r.targetBlock + 256) revert TooEarly();

        emit RaceVoided(raceId, r.pool, "target-block-expired");
        voided[raceId] = true;
        r.phase = Phase.SETTLED;
        _startRace(0);
    }

    function claimRake() external nonReentrant {
        uint256 amount = accumulatedRake;
        accumulatedRake = 0;
        _asyncTransfer(treasury, amount);
    }

    /// Bounded, per-user aggregate step -- see PlankCrashV2.sol's own
    /// registerResult() for why this two-phase pattern exists (computing
    /// totalWinningWeight without an unbounded loop over every bettor).
    function registerResult(uint256 raceId) external nonReentrant {
        Race storage r = races[raceId];
        if (r.phase != Phase.FINISHED) revert BadPhase();
        if (block.number > r.registrationDeadlineBlock) revert TooLate();
        if (registered[raceId][msg.sender]) revert AlreadyRegistered();

        uint256 horseId = horseOf[raceId][msg.sender];
        uint256 stake = stakeOf[raceId][msg.sender];
        if (horseId == 0) revert NoBet();

        registered[raceId][msg.sender] = true;
        bool won = (horseId - 1) == r.winningHorse;
        uint256 weight = 0;
        if (won) {
            weight = stake;
            r.totalWinningWeight += weight;
        }
        _weightOf[raceId][msg.sender] = weight;
        emit ResultRegistered(raceId, msg.sender, won, weight);
    }

    function claim(uint256 raceId) external nonReentrant {
        Race storage r = races[raceId];
        if (r.phase != Phase.FINISHED) revert BadPhase();
        if (block.number <= r.registrationDeadlineBlock) revert TooEarly();
        if (!registered[raceId][msg.sender]) revert NoBet();
        if (claimed[raceId][msg.sender]) revert AlreadyClaimed();

        uint256 weight = _weightOf[raceId][msg.sender];
        if (weight == 0) revert NotWinner();

        claimed[raceId][msg.sender] = true;
        uint256 payout = (r.distributable * weight) / r.totalWinningWeight;
        _asyncTransfer(msg.sender, payout);
        emit Claimed(raceId, msg.sender, payout);
    }

    // ── Views ────────────────────────────────────────────────────────────

    function currentRace() external view returns (Race memory) {
        return races[currentRaceId];
    }

    function horsePoolsOf(uint256 raceId) external view returns (uint256[NUM_HORSES] memory pools) {
        for (uint256 i = 0; i < NUM_HORSES; i++) {
            pools[i] = horsePool[raceId][i];
        }
    }
}
