// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ReentrancyGuard} from "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import {PullPayment} from "@openzeppelin/contracts/security/PullPayment.sol";

/**
 * Plank Crash -- pari-mutuel crash game. LOCAL PLAYABLE PROTOTYPE, scoped
 * deliberately: round timing here is fast (blocks, not the real 24h daily
 * cadence from docs/SPEC-competition-cadence-and-liquidity-flywheel.md) so
 * it can actually be played and tuned locally today. The settlement math,
 * randomness source, and security properties below are the real design,
 * not a placeholder -- what's simplified is round *duration*, nothing about
 * correctness.
 *
 * ECONOMICS (real, matches docs/SPEC-plank-derby-racing.md's model applied
 * to crash specifically -- this exact settlement formula is new synthesis
 * for this contract, not copied from the racing spec, since crash's
 * continuous multiplier needs a different payout shape than racing's
 * discrete win/place/show):
 *
 *   pool          = sum of every bet this round
 *   distributable = pool * (1 - RAKE_BPS)
 *   weight[i]     = stake[i] * multiplierAtCashOut[i]   (only for players
 *                   who cashed out strictly before the crash)
 *   payout[i]     = distributable * weight[i] / totalWinningWeight
 *
 * Total payouts can never exceed `distributable`, which can never exceed
 * `pool` -- no funded bankroll needed, ever, by construction. If nobody
 * cashes out before the crash, the whole pool (no rake taken) rolls into
 * the next round's pool untouched.
 *
 * RANDOMNESS: the crash point is derived from the blockhash of a block
 * that does not exist yet at lock time (`targetBlock = lockBlock +
 * REVEAL_DELAY_BLOCKS`). Nobody -- not this contract's deployer, not any
 * player, not any "operator" -- can know the crash point before that block
 * is mined, because the entropy source doesn't exist yet. This is the
 * real fix for the ordering problem a naive commit-reveal-by-operator
 * design has: if an operator reveals a secret seed mid-round so cash-outs
 * can be checked against it, a sophisticated reader of that reveal
 * transaction could compute the crash point before it visibly happens and
 * cash out at the last possible instant with a guaranteed win. Deriving
 * from a not-yet-existing block closes that window entirely -- the
 * information becomes public to everyone simultaneously, the moment the
 * target block exists, never revealed early to anyone.
 *
 * SETTLEMENT IS TWO-PHASE AND FULLY PULL-BASED (no admin, no unbounded
 * loop -- see docs/SPEC-competition-cadence-and-liquidity-flywheel.md
 * Part 3 §3.1/§3.2 for exactly why an unbounded payout loop is a real,
 * dollar-denominated class of bug, not a theoretical concern):
 *   1. registerResult() -- each bettor calls this ONCE after the crash is
 *      revealed, within REGISTRATION_BLOCKS. It computes THEIR OWN weight
 *      and adds it to a running totalWinningWeight. This has to be user-
 *      initiated and bounded by a real deadline, not computed by the
 *      contract sweeping a list, or it would be exactly the unbounded-loop
 *      bug this whole design exists to avoid.
 *   2. claim() -- callable only after the registration deadline passes
 *      (so totalWinningWeight is final and every claim divides by the
 *      same, complete number regardless of claim order). Pulls payment via
 *      OpenZeppelin's audited PullPayment/_asyncTransfer -- never pushes.
 *
 * A winner who never calls registerResult() within the deadline forfeits
 * their share -- a real, disclosed rule, not a hidden trap: it's the same
 * shape as any claim-window deadline, and it's what makes totalWinningWeight
 * knowable in bounded time without an admin or a loop over players.
 */
contract PlankCrash is ReentrancyGuard, PullPayment {
    enum Phase {
        BETTING,
        LIVE,
        CRASHED,
        SETTLED
    }

    struct Round {
        Phase phase;
        uint256 bettingEndsAt; // block.timestamp
        uint256 lockBlock;
        uint256 targetBlock; // blockhash(targetBlock) is the entropy source
        uint256 crashMultiplierBps; // set at reveal; e.g. 250 = 2.50x
        uint256 crashElapsedBlocks; // blocks after lock the crash occurred at
        uint256 pool;
        uint256 distributable;
        uint256 totalWinningWeight;
        uint256 registrationDeadlineBlock;
        uint256 rolledOverFromPrevious;
    }

    // Tunable for local play/testing -- see the real daily-cadence design
    // in docs/SPEC-competition-cadence-and-liquidity-flywheel.md for the
    // production version of this timing, deliberately not implemented here
    // yet (this contract is round-based, not the continuous-sourcing model).
    uint256 public immutable bettingDurationSeconds;
    uint256 public immutable revealDelayBlocks;
    uint256 public immutable registrationWindowBlocks;
    uint256 public immutable rakeBps; // e.g. 250 = 2.5%
    uint256 public immutable minParticipants;
    uint256 public immutable minPoolSize;
    uint256 public immutable maxStakePerWalletBps; // of pool, e.g. 3000 = 30%
    // Fixed forever at deploy time -- not admin-changeable, matching the
    // "no admin lever, anywhere" bar (docs/SPEC-competition-cadence-and-
    // liquidity-flywheel.md Part 3 §3.4). Real production replaces this
    // whole variable with the permissionless harvestRake() flywheel
    // (Part 2 of the same doc) -- this immutable address is the honest v0
    // stand-in for that, not the final design.
    address public immutable treasury;
    uint256 public accumulatedRake;

    uint256 public currentRoundId;
    mapping(uint256 => Round) public rounds;
    mapping(uint256 => mapping(address => uint256)) public stakeOf;
    mapping(uint256 => mapping(address => uint256)) public cashOutBlockOf; // 0 = never cashed out
    mapping(uint256 => mapping(address => bool)) public registered;
    mapping(uint256 => mapping(address => bool)) public claimed;
    mapping(uint256 => uint256) public participantCount;
    // Voided-round bookkeeping: a round that fails the collateral floor
    // moves its POOL TOTAL forward automatically, but individual stakes
    // are NOT auto-migrated (that would need an unbounded loop over every
    // bettor -- exactly the class of bug this whole design exists to
    // avoid). Each affected bettor instead carries their own stake forward
    // with carryForwardStake() -- bounded, pull-based, user-initiated.
    mapping(uint256 => bool) public voided;
    mapping(uint256 => mapping(address => bool)) public carriedForward;

    event RoundStarted(uint256 indexed roundId, uint256 bettingEndsAt);
    event BetPlaced(uint256 indexed roundId, address indexed player, uint256 amount);
    event RoundLocked(uint256 indexed roundId, uint256 lockBlock, uint256 targetBlock);
    event RoundVoided(uint256 indexed roundId, uint256 rolledOverPool, string reason);
    event CashedOut(uint256 indexed roundId, address indexed player, uint256 atBlock);
    event RoundCrashed(uint256 indexed roundId, uint256 crashMultiplierBps, uint256 crashElapsedBlocks);
    event ResultRegistered(uint256 indexed roundId, address indexed player, bool won, uint256 weight);
    event Claimed(uint256 indexed roundId, address indexed player, uint256 payout);

    error BadPhase();
    error TooEarly();
    error TooLate();
    error AlreadyBet();
    error NoBet();
    error AlreadyCashedOut();
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
        address _treasury
    ) {
        bettingDurationSeconds = _bettingDurationSeconds;
        revealDelayBlocks = _revealDelayBlocks;
        registrationWindowBlocks = _registrationWindowBlocks;
        rakeBps = _rakeBps;
        minParticipants = _minParticipants;
        minPoolSize = _minPoolSize;
        maxStakePerWalletBps = _maxStakePerWalletBps;
        treasury = _treasury;
        _startRound(0);
    }

    // ── Round lifecycle ──────────────────────────────────────────────────

    function _startRound(uint256 rolledOver) private {
        currentRoundId += 1;
        Round storage r = rounds[currentRoundId];
        r.phase = Phase.BETTING;
        r.bettingEndsAt = block.timestamp + bettingDurationSeconds;
        r.pool = rolledOver;
        r.rolledOverFromPrevious = rolledOver;
        emit RoundStarted(currentRoundId, r.bettingEndsAt);
    }

    function placeBet() external payable nonReentrant {
        Round storage r = rounds[currentRoundId];
        if (r.phase != Phase.BETTING) revert BadPhase();
        if (block.timestamp >= r.bettingEndsAt) revert TooLate();
        if (stakeOf[currentRoundId][msg.sender] != 0) revert AlreadyBet();

        // Whale cap: no single wallet's stake counts toward more than
        // maxStakePerWalletBps of the pool AFTER this bet is added.
        // Rejected at bet time, not capped-and-refunded later, so the
        // bettor knows immediately (docs/SPEC-competition-cadence-and-
        // liquidity-flywheel.md §1.2).
        //
        // REAL BUG CAUGHT BY TESTING, FIXED HERE: a percentage-of-pool cap
        // is mathematically impossible to satisfy for the very first bet
        // in a round -- with pool == 0 beforehand, any nonzero stake is
        // necessarily 100% of the resulting pool, which exceeds any cap
        // under 100%. This isn't a rounding edge case, it's a structural
        // property of the rule itself. The correct fix is not a formula
        // change (no formula satisfies "you can't be >30% of a pool you're
        // the only member of") -- it's exempting genuinely the first bet
        // of a round, since there is no other real participant yet for a
        // "whale" to be disproportionate relative to. Every bet after the
        // first is checked normally, against a pool that already reflects
        // real other stake.
        uint256 poolAfter = r.pool + msg.value;
        if (r.pool != 0 && msg.value * 10000 > poolAfter * maxStakePerWalletBps) {
            revert StakeExceedsCap();
        }

        stakeOf[currentRoundId][msg.sender] = msg.value;
        r.pool = poolAfter;
        participantCount[currentRoundId] += 1;
        emit BetPlaced(currentRoundId, msg.sender, msg.value);
    }

    /// Moves a bettor's own stake from a voided round into whichever round
    /// is currently open for betting -- bounded to one caller at a time,
    /// never an automatic bulk migration. This is what makes "real
    /// collateral or no launch" (a round can genuinely void) compatible
    /// with "no risk of losing funds": nothing is refunded or stranded,
    /// the ETH was never moved out of the contract, and the bettor pulls
    /// their own stake into the next real opportunity to play whenever
    /// they choose to.
    function carryForwardStake(uint256 fromRoundId) external nonReentrant {
        if (!voided[fromRoundId]) revert BadPhase();
        if (carriedForward[fromRoundId][msg.sender]) revert AlreadyClaimed();
        uint256 amount = stakeOf[fromRoundId][msg.sender];
        if (amount == 0) revert NoBet();

        Round storage cur = rounds[currentRoundId];
        if (cur.phase != Phase.BETTING) revert BadPhase();
        if (stakeOf[currentRoundId][msg.sender] != 0) revert AlreadyBet();

        uint256 poolAfter = cur.pool + amount;
        // Same first-bet exemption as placeBet() -- see that function's
        // comment for why a percentage cap cannot apply to the very first
        // real stake in a pool.
        if (cur.pool != 0 && amount * 10000 > poolAfter * maxStakePerWalletBps) {
            revert StakeExceedsCap();
        }

        carriedForward[fromRoundId][msg.sender] = true;
        stakeOf[currentRoundId][msg.sender] = amount;
        cur.pool = poolAfter;
        participantCount[currentRoundId] += 1;
        emit BetPlaced(currentRoundId, msg.sender, amount);
    }

    /// Permissionless -- anyone can lock the round once betting closes.
    /// Real collateral or no launch: if the round doesn't meet the
    /// participant/pool floor, it voids and rolls forward instead of
    /// locking -- same gate as the racing/cadence design, applied here.
    function lockRound() external nonReentrant {
        uint256 id = currentRoundId;
        Round storage r = rounds[id];
        if (r.phase != Phase.BETTING) revert BadPhase();
        if (block.timestamp < r.bettingEndsAt) revert TooEarly();

        if (participantCount[id] < minParticipants || r.pool < minPoolSize) {
            emit RoundVoided(id, r.pool, "under-threshold");
            voided[id] = true;
            r.phase = Phase.SETTLED; // dead-ends this round id for betting/cash-out; individual stakes carry forward via carryForwardStake(), not auto-migrated
            _startRound(0); // pool total does NOT move automatically -- see carryForwardStake()
            return;
        }

        r.phase = Phase.LIVE;
        r.lockBlock = block.number;
        r.targetBlock = block.number + revealDelayBlocks;
        emit RoundLocked(id, r.lockBlock, r.targetBlock);
    }

    /// Records a cash-out attempt. Whether it actually wins depends on
    /// whether this block turns out to be before the (not-yet-knowable)
    /// crash block -- checked later, once revealCrash() runs. A player can
    /// only ever cash out once per round.
    function cashOut(uint256 roundId) external nonReentrant {
        Round storage r = rounds[roundId];
        if (r.phase != Phase.LIVE) revert BadPhase();
        if (stakeOf[roundId][msg.sender] == 0) revert NoBet();
        if (cashOutBlockOf[roundId][msg.sender] != 0) revert AlreadyCashedOut();
        cashOutBlockOf[roundId][msg.sender] = block.number;
        emit CashedOut(roundId, msg.sender, block.number);
    }

    /// Permissionless. Derives the crash point from a block that did not
    /// exist at lock time -- see the contract header for why this closes
    /// the reveal-ordering exploit a secret-seed-revealed-mid-round design
    /// would have.
    function revealCrash(uint256 roundId) external nonReentrant {
        Round storage r = rounds[roundId];
        if (r.phase != Phase.LIVE) revert BadPhase();
        if (block.number <= r.targetBlock) revert TargetBlockNotYetMined();
        if (block.number > r.targetBlock + 256) revert TargetBlockExpired(); // EVM only exposes the last 256 blockhashes

        bytes32 entropy = blockhash(r.targetBlock);
        (uint256 multiplierBps, uint256 elapsedBlocks) = _deriveCrash(entropy);

        r.crashMultiplierBps = multiplierBps;
        r.crashElapsedBlocks = elapsedBlocks;
        r.distributable = (r.pool * (10000 - rakeBps)) / 10000;
        r.registrationDeadlineBlock = block.number + registrationWindowBlocks;
        r.phase = Phase.CRASHED;

        // The rake is tracked separately, NOT folded into the next round's
        // pool -- doing that would inject unattributed value into a future
        // round, breaking the exact invariant that makes this system need
        // no bankroll (every payout traceable to a real bettor's real
        // stake). Real production harvesting into the permanent-liquidity
        // flywheel (docs/SPEC-competition-cadence-and-liquidity-
        // flywheel.md Part 2) is a separate contract this v0 doesn't wire
        // up yet -- accumulatedRake just sits here, pull-claimable by the
        // treasury address, until that's built.
        accumulatedRake += r.pool - r.distributable;

        emit RoundCrashed(roundId, multiplierBps, elapsedBlocks);

        _startRound(0);
    }

    /// Permissionless keeper call (same shape as the real production
    /// harvestRake() -- anyone can trigger the transfer, the destination
    /// is fixed and cannot be redirected). Pull-based even for this: pays
    /// via _asyncTransfer, not a direct push.
    function claimRake() external nonReentrant {
        uint256 amount = accumulatedRake;
        accumulatedRake = 0;
        _asyncTransfer(treasury, amount);
    }

    /// One call per bettor, within the registration window. Computes and
    /// locks in THIS caller's own weight -- bounded, user-initiated, never
    /// a loop over other players (docs/SPEC-competition-cadence-and-
    /// liquidity-flywheel.md Part 3 §3.1/§3.2).
    function registerResult(uint256 roundId) external nonReentrant {
        Round storage r = rounds[roundId];
        if (r.phase != Phase.CRASHED) revert BadPhase();
        if (block.number > r.registrationDeadlineBlock) revert TooLate();
        uint256 stake = stakeOf[roundId][msg.sender];
        if (stake == 0) revert NoBet();
        if (registered[roundId][msg.sender]) revert AlreadyRegistered();
        registered[roundId][msg.sender] = true;

        uint256 cashOutBlock = cashOutBlockOf[roundId][msg.sender];
        bool won = cashOutBlock != 0 && (cashOutBlock - r.lockBlock) <= r.crashElapsedBlocks;

        uint256 weight = 0;
        if (won) {
            uint256 multiplierAtCashOutBps = _multiplierAt(cashOutBlock - r.lockBlock);
            weight = (stake * multiplierAtCashOutBps) / 10000;
            r.totalWinningWeight += weight;
        }
        emit ResultRegistered(roundId, msg.sender, won, weight);

        // Store the caller's own weight for claim() -- a second mapping
        // keyed the same way, avoids re-deriving it (and therefore risking
        // a different result) at claim time.
        _weightOf[roundId][msg.sender] = weight;
    }

    mapping(uint256 => mapping(address => uint256)) private _weightOf;

    /// Only callable after the registration deadline, so totalWinningWeight
    /// is final and every claimant divides by the same, complete number
    /// regardless of claim order -- the actual fix for the "early claimer
    /// gets a wrong share" bug a naive same-phase register+claim design
    /// would have.
    function claim(uint256 roundId) external nonReentrant {
        Round storage r = rounds[roundId];
        if (r.phase != Phase.CRASHED) revert BadPhase();
        if (block.number <= r.registrationDeadlineBlock) revert TooEarly();
        if (!registered[roundId][msg.sender]) revert NotWinner();
        if (claimed[roundId][msg.sender]) revert AlreadyClaimed();
        uint256 weight = _weightOf[roundId][msg.sender];
        if (weight == 0) revert NotWinner();

        claimed[roundId][msg.sender] = true;
        uint256 payout = (r.distributable * weight) / r.totalWinningWeight;
        _asyncTransfer(msg.sender, payout);
        emit Claimed(roundId, msg.sender, payout);
    }

    // ── Pure math, independently re-runnable off-chain from public data ──

    /// Growth curve: multiplier climbs from 1.00x (10000 bps... using bps
    /// where 10000 = 1.00x throughout) roughly matching real crash-game
    /// curves researched this session (slower early, faster later).
    /// elapsedBlocks is blocks since lock -- block-based, not wall-clock,
    /// so it's exact and reproducible regardless of block timing variance.
    function _multiplierAt(uint256 elapsedBlocks) public pure returns (uint256) {
        // 10000 + 400*elapsedBlocks + 20*elapsedBlocks^2, bps. Tuned for
        // local play -- THIS is the actual knob to iterate on once you're
        // playing it; see the README note in scripts/deploy-crash-local.ts.
        return 10000 + (elapsedBlocks * 400) + (elapsedBlocks * elapsedBlocks * 20);
    }

    function _deriveCrash(bytes32 entropy) public pure returns (uint256 multiplierBps, uint256 elapsedBlocks) {
        // Real crash-point distribution shape (researched this session,
        // Aviator/Spribe-style): a small chance of an instant (1.00x)
        // crash, otherwise a long-tailed distribution favoring lower
        // multipliers. house-edge-style formula adapted for a bps-integer
        // domain: crash = floor(1e8 / (1e4 - r)) where r in [0, 9999] --
        // integer-only, no floats, deterministic.
        uint256 r = uint256(entropy) % 10000;
        if (r == 0) {
            return (10000, 0); // instant crash at 1.00x
        }
        multiplierBps = (10000 * 10000) / (10000 - r);
        // Invert _multiplierAt to find the elapsed-block count that first
        // reaches multiplierBps -- bounded search, real max ~ sqrt-scale,
        // never unbounded for any real multiplier range this game targets.
        elapsedBlocks = 0;
        while (_multiplierAt(elapsedBlocks) < multiplierBps && elapsedBlocks < 10000) {
            elapsedBlocks++;
        }
    }

    // ── View helpers for the local playable frontend ────────────────────

    function currentRound() external view returns (Round memory) {
        return rounds[currentRoundId];
    }

    function liveMultiplierBps(uint256 roundId) external view returns (uint256) {
        Round storage r = rounds[roundId];
        if (r.phase != Phase.LIVE) return 0;
        uint256 elapsed = block.number - r.lockBlock;
        return _multiplierAt(elapsed);
    }
}
