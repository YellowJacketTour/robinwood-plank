// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ReentrancyGuard} from "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import {PullPayment} from "@openzeppelin/contracts/security/PullPayment.sol";
import {IDrandBeacon} from "./IDrandBeacon.sol";
import {IPlankProgression} from "./IPlankProgression.sol";

/// Pari-mutuel horse race. Real collateral only: payouts are strictly bounded
/// by the race's real distributable pool, split among bettors on the
/// winning horse in proportion to their real stake. No house edge, no
/// funded bankroll, no oracle. Two-phase register+claim so payout order can
/// never matter, same pattern as PlankCrashV2.sol.
///
/// RANDOMNESS, MIGRATED OFF BLOCKHASH (2026-08-18): this contract used to
/// draw the winning horse from blockhash(targetBlock) -- a future block that
/// did not exist at lock time, unknowable to anyone until mined. That
/// reasoning was already wrong for the reason PlankCrashDrand.sol's own
/// header documents at length: on Robinhood Chain, block production is
/// controlled by a single Robinhood-operated sequencer, and Arbitrum's own
/// docs say L2 block hashes are NOT cryptographically secure and can be
/// derived in advance by the sequencer. "Unknowable to anyone" was never
/// true for the one party who actually decides what goes into that block.
/// PlankCrashV2 was deliberately migrated off this exact scheme into
/// PlankCrashDrand.sol; PlankDerby was not migrated at the same time even
/// though it shares the identical entropy source and the identical
/// adversary. This fixes that inconsistency by porting the SAME pattern
/// PlankCrashDrand uses, verbatim where it applies:
///   - lockRace() commits the race to a specific future drand round
///     (beacon.nextRoundAfter(now) + a real safety margin -- see
///     TARGET_ROUND_SAFETY_PERIODS's own comment, copied unchanged from
///     PlankCrashDrand.sol for the identical L2-timestamp-jump reasoning).
///   - finishRace() reads that round's already-BLS-verified randomness
///     straight from the shared DrandBeacon (beacon.randomnessOrZero()) --
///     no signature is passed or re-verified here, exactly like
///     PlankCrashDrand.revealEntropy(). This contract reads from the SAME
///     beacon MarketplankVaultV3 and PlankCrashDrand already depend on, so
///     the whole protocol shares one audited BLS-verification surface.
/// ONE STRUCTURAL SIMPLIFICATION vs PlankCrashDrand, deliberate: Derby has
/// no live, resolution-order-sensitive action analogous to cashOut() or
/// presetCashOut() -- nobody can act on a race's outcome before it settles,
/// because there IS no action available while LOCKED except finishRace()
/// itself. PlankCrashDrand needs a separate revealEntropy() step specifically
/// to close a real information-asymmetry window against cashOut()/
/// presetCashOut() (see that contract's own MEDIUM-severity-fix comments).
/// No such window exists here, so reveal and finish are safely the SAME
/// function, and there is no analogous "AwaitingEntropyReveal" gate to add.
/// voidStaleRound() below is likewise the DRAND-timeout version, not the old
/// blockhash-window version -- see its own comment for why the condition
/// changed shape, not just its threshold.
contract PlankDerby is ReentrancyGuard, PullPayment {
    enum Phase { BETTING, LOCKED, FINISHED, SETTLED }

    struct Race {
        Phase phase;
        uint256 bettingEndsAt;
        uint256 lockBlock;
        uint64 targetDrandRound;
        uint256 winningHorse; // valid only once phase >= FINISHED
        uint256 pool;
        uint256 distributable;
        uint256 totalWinningWeight;
        uint256 registrationDeadlineBlock;
    }

    uint256 public constant NUM_HORSES = 6;

    // Real safety margin, in whole drand rounds, added on top of the
    // strictly-next round the beacon reports -- copied unchanged from
    // PlankCrashDrand.sol's own TARGET_ROUND_SAFETY_PERIODS. See that
    // constant's own comment for the full reasoning (absorbs clock skew
    // between this chain's block.timestamp and drand's genesis-time math,
    // and specifically guards against Arbitrum-style Orbit sequencers
    // snapping block.timestamp forward after an idle gap). Not re-derived
    // here -- Derby shares the identical L2 and the identical beacon, so it
    // shares the identical risk and the identical margin.
    uint256 private constant TARGET_ROUND_SAFETY_PERIODS = 20;

    uint256 public immutable bettingDurationSeconds;
    // How long, in blocks, this contract will wait for ANYONE to relay the
    // target round to the beacon and call finishRace() before
    // voidStaleRound() becomes callable. Same anti-griefing/keeper-liveness
    // safety net as PlankCrashDrand.maxAwaitBlocks -- a drand round's
    // signature never expires the way blockhash's real 256-block window
    // did, so this exists purely because nobody is economically bonded to
    // relay/finish promptly, not because the entropy could become
    // unavailable.
    uint256 public immutable maxAwaitBlocks;
    uint256 public immutable registrationWindowBlocks;
    uint256 public immutable rakeBps;
    uint256 public immutable minParticipants;
    uint256 public immutable minPoolSize;
    uint256 public immutable maxStakePerWalletBps; // of pool, e.g. 5000 = 50%
    uint256 public immutable keeperRewardBps; // of rake, paid to whoever calls finishRace()
    address public immutable treasury;

    // The shared, protocol-wide drand round cache -- the SAME beacon
    // PlankCrashDrand.sol and MarketplankVaultV3.sol already depend on. See
    // DrandBeacon.sol's own header for the full trust-model writeup.
    IDrandBeacon public immutable beacon;

    // ── Optional progression/leveling layer -- see setProgression() and
    // PlankProgression.sol's own header. Same deployer-gated, settable-once
    // pattern as PlankCrashDrand/PlankFuelBooster/PlankPowerboard.
    //
    // DELIBERATELY RANK-TRACKING ONLY, NOT PREMIUM/CAP: PlankCrashDrand's
    // _applyProgression() also enforces a rank-based absolute stake cap and
    // skims a rank-based entry premium straight into its Vault reserve --
    // neither concept has a real equivalent here. Derby's own header is
    // explicit: "Real collateral only... no house edge, no funded bankroll,
    // no oracle" -- there is no Vault, no reserve, and nothing for a premium
    // to fund; skimming ETH out of a pari-mutuel pool into a reserve that
    // doesn't exist would just be a stealth rake increase on the exact
    // players the whale cap already protects, not a Sybil-cost defense. The
    // existing maxStakePerWalletBps pool-relative cap is Derby's own
    // whale-dominance defense and is left completely untouched. What DOES
    // carry over unmodified is the underlying motivation from
    // PlankProgression's own header: raising the cost of the whale-cap-
    // bypass Sybil attack (splitting one bettor's capital across many
    // wallets) by giving grinding wallets something to grind for.
    //
    // REAL, DISCLOSED LIMITATION -- rank is NOT shared with Crash's own
    // PlankProgression instance: PlankProgression.recordBet is gated by an
    // `onlyCrash` modifier checking msg.sender against a single immutable
    // address baked into ITS OWN constructor at deploy time (see
    // PlankProgression.sol's constructor -- `crash_`). Wiring Derby into
    // the exact same deployed instance Crash uses would require either a
    // second authorized-caller slot or a set-based check in
    // PlankProgression itself, which is out of scope here (read-only
    // precedent per this change's constraints). Derby therefore points
    // `progression` at its OWN separately-deployed PlankProgression
    // instance (constructed with THIS contract's address as its `crash_`
    // slot) if an operator wants on-chain rank tracking for Derby -- a
    // separate ledger/rank from whatever a wallet has earned in Crash, not
    // a merged one. Real, still-useful Sybil-cost friction on ITS OWN
    // terms; just not the cross-game unification a shared instance would
    // have given for free had PlankProgression's access control supported it.
    address private immutable _deployer;
    IPlankProgression public progression; // address(0) == feature disabled, exact pre-existing behavior

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
    event RaceLocked(uint256 indexed raceId, uint256 lockBlock, uint64 targetDrandRound);
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
    error RandomnessNotYetAvailable();
    error ZeroBeacon();
    error ProgressionAlreadySet();
    error NotDeployer();

    constructor(
        uint256 _bettingDurationSeconds,
        uint256 _maxAwaitBlocks,
        uint256 _registrationWindowBlocks,
        uint256 _rakeBps,
        uint256 _minParticipants,
        uint256 _minPoolSize,
        uint256 _maxStakePerWalletBps,
        uint256 _keeperRewardBps,
        address _treasury,
        address _beacon
    ) {
        // Captured automatically as the constructor's own caller -- see
        // PlankCrashDrand.setProgression's own comment for the full
        // reasoning (narrow, one-shot, never touches funds/odds/outcomes).
        _deployer = msg.sender;
        if (_treasury == address(0)) revert ZeroAddress();
        if (_beacon == address(0)) revert ZeroBeacon();
        if (_beacon.code.length == 0) revert ZeroBeacon();
        beacon = IDrandBeacon(_beacon);
        bettingDurationSeconds = _bettingDurationSeconds;
        maxAwaitBlocks = _maxAwaitBlocks;
        registrationWindowBlocks = _registrationWindowBlocks;
        rakeBps = _rakeBps;
        minParticipants = _minParticipants;
        minPoolSize = _minPoolSize;
        maxStakePerWalletBps = _maxStakePerWalletBps;
        keeperRewardBps = _keeperRewardBps;
        treasury = _treasury;
        _startRace(0);
    }

    /// Wires this contract to a deployed PlankProgression, EXACTLY once,
    /// restricted to whoever deployed THIS contract -- identical pattern and
    /// reasoning to PlankCrashDrand.setProgression / PlankFuelBooster.setProgression.
    function setProgression(address progression_) external {
        if (msg.sender != _deployer) revert NotDeployer();
        if (address(progression) != address(0)) revert ProgressionAlreadySet();
        progression = IPlankProgression(progression_);
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

        // Optional rank-tracking only -- see progression's own comment
        // above for why this is recordBet() and nothing else. A pure no-op
        // when progression is unset (address(0)): every existing round of
        // behavior is preserved exactly when this optional feature was
        // never wired up. A plain (non try/catch) call, deliberately
        // matching PlankCrashDrand._applyProgression's own call shape, not
        // PlankFuelBooster/PlankPowerboard's try/catch: this runs BEFORE any
        // ETH has left custody or been credited anywhere, so a revert here
        // simply reverts the whole placeBet() atomically -- there is no
        // already-completed, irreversible action (like a real token burn)
        // that a broken progression contract could strand.
        IPlankProgression p = progression;
        if (address(p) != address(0)) {
            p.recordBet(msg.sender, msg.value);
        }
    }

    /// Same non-custodial "real collateral or no launch" recovery path as
    /// PlankCrashV2.carryForwardStake(): a voided race's pool total does NOT
    /// move automatically (individual stakeOf/horseOf entries stay keyed
    /// to the dead race id), so each affected bettor pulls their own stake
    /// into whatever race is currently open, bounded and per-user.
    ///
    /// Deliberately has NO progression call, same reasoning as
    /// PlankCrashDrand.carryForwardStake(): this moves already-recorded
    /// capital between races, and running it through recordBet again would
    /// double-count wagering volume already attributed on the original bet.
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

    /// Locks the race and commits it to a specific future drand round -- no
    /// request/response step, no fee. Anyone can independently recompute
    /// targetDrandRound off-chain from lockBlock's timestamp via the same
    /// beacon.nextRoundAfter() this calls -- nothing here is a secret.
    /// Mirrors PlankCrashDrand.lockRound()'s exact math.
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
        r.targetDrandRound = beacon.nextRoundAfter(block.timestamp) + uint64(TARGET_ROUND_SAFETY_PERIODS);
        emit RaceLocked(id, r.lockBlock, r.targetDrandRound);
    }

    /// Draws the winning horse from the shared DrandBeacon's already-BLS-
    /// verified randomness for this race's committed target round -- no
    /// signature is passed or re-verified here, exactly like
    /// PlankCrashDrand.revealEntropy(). Reverts (does not partially
    /// advance) until that round has actually been relayed, which itself
    /// cannot happen before the round's real due time -- so this is
    /// unknowable to anyone, including this contract's deployer, until then.
    /// Permissionless, with a real keeper reward out of the race's own rake
    /// (never out of bettors' distributable pool) -- see voidStaleRound's
    /// own comment for why this incentive matters given Robinhood Chain's
    /// real block time.
    function finishRace(uint256 raceId) external nonReentrant {
        Race storage r = races[raceId];
        if (r.phase != Phase.LOCKED) revert BadPhase();

        bytes32 entropy = beacon.randomnessOrZero(r.targetDrandRound);
        if (entropy == bytes32(0)) revert RandomnessNotYetAvailable();

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

    /// Anti-griefing liveness fallback -- DRAND-TIMEOUT version, not the old
    /// blockhash-window version. Without this, a race that nobody relays
    /// targetDrandRound's signature for (or nobody calls finishRace() on
    /// once it IS relayed) would hang in LOCKED forever with every bettor's
    /// real stake trapped inside it. Unlike the old blockhash scheme, a
    /// drand round's signature never expires -- it is permanently, publicly
    /// fetchable forever once its due time passes -- so there is no real
    /// "window closes" condition to mirror; this exists purely as the same
    /// anti-griefing/keeper-liveness safety net PlankCrashDrand.voidStaleRound()
    /// is (nobody bonded to relay/finish promptly), gated on ELAPSED BLOCKS
    /// since lock (maxAwaitBlocks), not on a signature deadline that no
    /// longer exists. Permissionless; voids exactly like an under-threshold
    /// race in lockRace() -- pool total doesn't move automatically, each
    /// bettor carries their own stake forward via the existing
    /// carryForwardStake() path.
    function voidStaleRound(uint256 raceId) external nonReentrant {
        Race storage r = races[raceId];
        if (r.phase != Phase.LOCKED) revert BadPhase();
        if (block.number <= r.lockBlock + maxAwaitBlocks) revert TooEarly();

        emit RaceVoided(raceId, r.pool, "reveal-timeout");
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
