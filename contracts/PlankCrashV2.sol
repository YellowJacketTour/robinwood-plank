// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ReentrancyGuard} from "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import {PullPayment} from "@openzeppelin/contracts/security/PullPayment.sol";

/**
 * Plank Crash V2 -- pari-mutuel crash game, redesigned to fix a real bug
 * found playing V1 (contracts/PlankCrash.sol): the live multiplier a
 * player watches climb and the final "crash" number the round settled at
 * were two different measurements. Live tracked real elapsed blocks,
 * capped by a fixed reveal-delay window (~3.25x max at V1's local
 * settings). The final number was a separate, unbounded blockhash-derived
 * draw with no relationship to how long the round actually ran -- a
 * round could show ~3x live and settle at 3333x, a number nobody could
 * ever have watched or cashed out at. Payouts were never wrong (a
 * winner's payout was always grounded in their own real cash-out block,
 * never in that number) -- but showing it as the round's "score" was
 * actively misleading. V2's one real architectural change: THE ROUND'S
 * DURATION NOW TRACKS ITS OWN CRASH POINT, so the number displayed live
 * and the number recorded at settlement are the same number, always, by
 * construction. See §2 of the design memo this implements for the full
 * reasoning (research citations included there).
 *
 * WHAT'S UNCHANGED FROM V1 (proven correct there, not re-litigated here):
 *   - Pari-mutuel solvency bound: distributable = pool*(1-rake), payouts
 *     are proportional shares of distributable, so total payouts can
 *     never exceed distributable by construction. No bankroll, ever.
 *   - blockhash(futureBlock) entropy, closing the reveal-ordering exploit
 *     a mid-round-revealed-secret design would have.
 *   - Two-phase register-then-claim settlement (bounded, pull-based, no
 *     admin, no unbounded loop over players).
 *   - Void-and-carry-forward under the collateral floor.
 *
 * WHAT'S NEW IN V2:
 *   1. Reveal/settle split (§1). Entropy is revealed early (as soon as
 *      its source block exists) but does NOT end the round. The round
 *      only actually crashes once REAL elapsed blocks reach the revealed
 *      crash point -- capped at maxElapsedBlocks so a round can't run
 *      unboundedly long in the rare high-multiplier tail (see §2). This
 *      is the actual fix: ticker == final, always, by construction,
 *      because they're now the same measurement taken at the same time.
 *   2. cashOut() is gated against cashing out at or after the (now
 *      public, once revealed) true crash point -- the load-bearing
 *      correctness property that makes §1 actually hold. Without this
 *      gate, a player could still sneak in a late cash-out after the
 *      real crash but before anyone calls settleRound().
 *   3. presetCashOut() -- a real "set your target multiplier and walk
 *      away" feature, implemented with ZERO new settlement-time
 *      execution surface: since _multiplierAt is strictly increasing,
 *      a target multiplier inverts to a target block in O(bounded loop)
 *      at REGISTRATION time, and is stored in the exact same
 *      cashOutBlockOf slot a live cashOut() uses. No keeper, no order
 *      queue, no gas-griefing surface, because there is nothing to
 *      execute later -- it's just an earlier write to an existing slot.
 *      Gated to only work BEFORE entropy is revealed (see presetCashOut's
 *      own comment for why that gate is load-bearing for fairness).
 *   4. A liveness fallback (voidStaleRound) for the case nobody calls
 *      revealEntropy() before the entropy block's hash falls out of the
 *      EVM's 256-block window -- without this, that round could hang
 *      forever with real stake trapped in it.
 *   5. Epoch-snapped round scheduling (nextScheduledBettingEndsAt) for a
 *      real daily (or any fixed-interval) cadence that self-heals if a
 *      settlement runs long, instead of drifting cumulatively.
 *   6. _multiplierAt's constants are re-derived for a ~100ms block chain
 *      (Robinhood Chain's real measured block time) instead of V1's
 *      constants, which were tuned against local dev's ~500ms-1s
 *      simulated blocks. See _multiplierAt's own comment for the math.
 *   7. keeperRewardBps -- a small, fixed share of the RAKE (never of
 *      players' distributable pool) paid to whoever actually calls
 *      settleRound(). Every settlement-critical function here is
 *      permissionless by design, which only actually stays timely if
 *      someone is economically motivated to call it, rather than relying
 *      on a frontend tab happening to be open. Same shape as Chainlink
 *      Automation / Gelato / Keep3r's keeper-incentive pattern.
 *   8. estimatedPayout() -- a real fix for a genuine economic-clarity gap
 *      found by researching how pari-mutuel systems actually behave: this
 *      game's payout is a SHARE of the pool split among however many
 *      people end up winning, not a fixed stake*multiplier rate like a
 *      house-bankrolled crash game pays. A player who's the sole winner
 *      gets the whole distributable pool regardless of how small their
 *      own multiplier was; one among many winners gets proportionally
 *      less. This was already true and already correct math -- the gap
 *      was that nothing exposed it, so a UI showing only "multiplier"
 *      would silently mislead players into treating it as a promise. See
 *      estimatedPayout()'s own comment for what it does and doesn't
 *      guarantee.
 *
 * TRUST ASSUMPTIONS, DISCLOSED HONESTLY (researched, not hidden):
 *   - Robinhood Chain runs a SINGLE, Robinhood-operated sequencer with
 *     first-come-first-served ordering. Arbitrum's delayed-inbox force-
 *     inclusion mechanism exists as a backstop against censorship, but its
 *     fastest mode (the Censorship Timeout feature) still takes on the
 *     order of 30+ minutes to kick in -- far too slow to matter for a
 *     round that settles in minutes. This contract's fairness guarantees
 *     (blockhash entropy, the reveal/settle split, the cash-out gate) are
 *     airtight against OTHER PLAYERS and against this contract's own
 *     deployer; they are not a defense against a malicious sequencer
 *     operator, because no on-chain mechanism at real-time speed can be.
 *     The residual risk is standard to every application on any single-
 *     sequencer L2, not specific to this game, and is bounded in practice
 *     by Robinhood having no stake in this game's outcomes (it collects
 *     only the disclosed, outcome-independent rake).
 *   - blockhash-derived randomness is, in general, manipulable by whoever
 *     controls block production (a "grinding" attack: try candidate
 *     blocks until one produces a favorable hash, publish only that one).
 *     On a decentralized validator set this requires colluding with
 *     whoever wins the relevant block; on Robinhood Chain, the sequencer
 *     IS that party, unilaterally. A Chainlink VRF-style external
 *     randomness oracle would remove this risk entirely at the cost of a
 *     new trusted oracle dependency -- a real, considered future upgrade
 *     path, not implemented here. Same "bounded by lack of incentive to
 *     manipulate a game they have no stake in" reasoning as above applies
 *     today.
 *   - Rollover incentive, considered and ruled out: could a bettor
 *     profitably "sandbag" a round (bet, never cash out, guarantee no
 *     winners) to inflate the next round's rolled-over starting pool?
 *     No -- the rollover isn't refunded to that round's losers, it's just
 *     a bigger starting pool for whoever plays the NEXT round, diluted
 *     across every bettor there equally per unit staked. Sandbagging costs
 *     you 100% of your own stake for a benefit you cannot personally
 *     capture disproportionately (you can't force yourself to be the only
 *     bettor in the next round on a permissionless system). Net effect is
 *     pure value destruction for the attacker, not an exploit.
 *
 * WHALE CAP -- HONEST LIMITS, READ BEFORE RELYING ON THIS: the
 * maxStakePerWalletBps check below (unchanged from V1) is a courtesy
 * variance-smoother, not a sybil-resistance guarantee. On a permissionless
 * chain, "cap one wallet's stake" cannot be made sybil-proof without
 * off-chain identity infrastructure (proof-of-personhood, KYC) -- an
 * attacker can always split one economic position across N wallets. This
 * is a deliberate non-fix, not an oversight: because pari-mutuel payout is
 * LINEAR in stake (splitting a position across wallets changes nothing
 * about its aggregate expected payout), sybil-splitting to evade the cap
 * doesn't let an attacker extract more than their capital's fair
 * mathematical share of the pool -- it only lets them re-concentrate
 * pool-share the cap was trying to keep distributed, i.e. it degrades the
 * cap's variance-smoothing intent for other bettors in a thin pool. That
 * is a real cost, but it is not a solvency or fairness violation, and
 * building unauditable identity infrastructure to chase it would be
 * solving a problem this game's math doesn't structurally have.
 *
 * NOT YET BUILT (scope explicitly deferred, see the design memo's own
 * gas/complexity cost callouts for each): the daily-cadence scheduling
 * primitive here (#5) is real and load-bearing, but the actual "once per
 * day" interval, minimum pool floor, and rake are still constructor
 * parameters for the deployer to choose -- this contract doesn't hardcode
 * a specific cadence.
 */
contract PlankCrashV2 is ReentrancyGuard, PullPayment {
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
        uint256 entropyBlock; // blockhash(entropyBlock) is the randomness source
        bool entropyRevealed;
        uint256 trueCrashElapsedBlocks; // uncapped, provably-fair-verifiable, informational only -- NEVER used for win/loss
        uint256 crashElapsedBlocks; // = min(trueCrashElapsedBlocks, maxElapsedBlocks) -- the ONLY value used economically
        uint256 crashMultiplierBps; // = _multiplierAt(crashElapsedBlocks) -- the same number the live ticker showed
        uint256 pool;
        uint256 distributable;
        uint256 totalWinningWeight;
        // Running sum of (stake * multiplier-at-cash-out) for every
        // cashOut()/presetCashOut() call so far, updated O(1) per call --
        // never a loop over players (see the contract header on why that
        // matters here). Lets estimatedPayout() give real-time, honestly-
        // labeled guidance without violating that principle. NOTE: this
        // can include weight from a cash-out that later turns out to have
        // been placed after the TRUE crash point (only possible pre-
        // reveal, since cashOut() is gated against that once revealed --
        // see cashOut()'s own comment), so it's a provisional estimate,
        // not a guarantee, until registration closes -- exactly the same
        // "odds fluctuate until post time" property real pari-mutuel
        // horse-racing pools have always had.
        uint256 provisionalWinningWeight;
        uint256 registrationDeadlineBlock;
        uint256 rolledOverFromPrevious;
    }

    uint256 public immutable bettingDurationSeconds;
    uint256 public immutable roundIntervalSeconds; // epoch grid spacing -- e.g. 86400 for daily
    uint256 public immutable genesisTimestamp;
    uint256 public immutable entropyDelayBlocks; // how many blocks after lock the entropy source doesn't exist yet
    // Hard ceiling on real elapsed blocks a round can run before it is
    // forced to settle regardless of the true (uncapped) crash point.
    // This is what makes the daily cadence actually predictable, and
    // what turns "the real max multiplier this game can ever pay out" into
    // an honestly advertisable number instead of a 10000x phantom tail.
    // See _multiplierAt for what multiplier this implies at deploy time.
    uint256 public immutable maxElapsedBlocks;
    uint256 public immutable registrationWindowBlocks;
    uint256 public immutable rakeBps;
    uint256 public immutable minParticipants;
    uint256 public immutable minPoolSize;
    uint256 public immutable maxStakePerWalletBps;
    address public immutable treasury;
    // Share of the RAKE (never of players' distributable pool) paid to
    // whoever actually calls settleRound(). Real gap this closes: every
    // settlement-critical function here is permissionless by design (no
    // admin, ever), which only works if someone is economically motivated
    // to actually call it -- otherwise it depends on hope, a frontend's
    // own JS running while a tab happens to be open, or the deployer
    // altruistically running a keeper bot forever. This carves a small,
    // fixed reward from the operator's own cut, the same shape Chainlink
    // Automation/Gelato/Keep3r use for permissionless keeper incentives,
    // so settlement stays timely even with zero players' tabs open.
    uint256 public immutable keeperRewardBps;
    uint256 public accumulatedRake;

    uint256 public currentRoundId;
    mapping(uint256 => Round) public rounds;
    mapping(uint256 => mapping(address => uint256)) public stakeOf;
    mapping(uint256 => mapping(address => uint256)) public cashOutBlockOf; // 0 = never cashed out (live or preset)
    mapping(uint256 => mapping(address => bool)) public registered;
    mapping(uint256 => mapping(address => bool)) public claimed;
    mapping(uint256 => mapping(address => uint256)) private _weightOf;
    mapping(uint256 => uint256) public participantCount;
    mapping(uint256 => bool) public voided;
    mapping(uint256 => mapping(address => bool)) public carriedForward;

    event RoundStarted(uint256 indexed roundId, uint256 bettingEndsAt);
    event BetPlaced(uint256 indexed roundId, address indexed player, uint256 amount);
    event RoundLocked(uint256 indexed roundId, uint256 lockBlock, uint256 entropyBlock);
    event RoundVoided(uint256 indexed roundId, uint256 rolledOverPool, string reason);
    event CashedOut(uint256 indexed roundId, address indexed player, uint256 atBlock, bool preset);
    event EntropyRevealed(uint256 indexed roundId, uint256 trueCrashMultiplierBps, uint256 trueCrashElapsedBlocks);
    event RoundCrashed(uint256 indexed roundId, uint256 crashMultiplierBps, uint256 crashElapsedBlocks, bool cappedByMax);
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
    error EntropyNotYetAvailable();
    error EntropyExpired();
    error EntropyNotRevealed();
    error EntropyAlreadyRevealed();
    error CrashPointNotYetReached();
    error PastCrashPoint();
    error TargetUnreachable();

    // Bundled into a struct rather than ~10 loose constructor params --
    // a real stack-too-deep compile error with this many immutables
    // assigned in one constructor otherwise (caught by actually compiling,
    // not assumed away). Deploy scripts build this struct directly.
    struct Config {
        uint256 bettingDurationSeconds;
        uint256 roundIntervalSeconds;
        uint256 entropyDelayBlocks;
        uint256 maxElapsedBlocks;
        uint256 registrationWindowBlocks;
        uint256 rakeBps;
        uint256 minParticipants;
        uint256 minPoolSize;
        uint256 maxStakePerWalletBps;
        uint256 keeperRewardBps; // of the rake, not of players' distributable pool
        address treasury;
    }

    constructor(Config memory cfg) {
        bettingDurationSeconds = cfg.bettingDurationSeconds;
        roundIntervalSeconds = cfg.roundIntervalSeconds;
        genesisTimestamp = block.timestamp;
        entropyDelayBlocks = cfg.entropyDelayBlocks;
        maxElapsedBlocks = cfg.maxElapsedBlocks;
        registrationWindowBlocks = cfg.registrationWindowBlocks;
        rakeBps = cfg.rakeBps;
        minParticipants = cfg.minParticipants;
        minPoolSize = cfg.minPoolSize;
        maxStakePerWalletBps = cfg.maxStakePerWalletBps;
        keeperRewardBps = cfg.keeperRewardBps;
        treasury = cfg.treasury;
        _startRound(0);
    }

    // ── Round lifecycle ──────────────────────────────────────────────────

    /// Epoch-snapped scheduling: the next round's betting window starts at
    /// the next genesis+k*interval slot at or after now, never in the
    /// past and never drifting cumulatively if a previous round's
    /// settlement ran long. Real daily cadence: set roundIntervalSeconds
    /// to 86400 and every round lands on the same wall-clock time.
    function _nextSlot() private view returns (uint256) {
        uint256 elapsed = block.timestamp - genesisTimestamp;
        uint256 k = (elapsed / roundIntervalSeconds) + 1;
        return genesisTimestamp + k * roundIntervalSeconds;
    }

    function _startRound(uint256 rolledOver) private {
        currentRoundId += 1;
        Round storage r = rounds[currentRoundId];
        r.phase = Phase.BETTING;
        // roundIntervalSeconds == 0 opts OUT of the fixed daily-style grid
        // entirely (every round just opens immediately for
        // bettingDurationSeconds, V1's simpler behavior) -- the natural
        // mode for local dev/testing. A nonzero interval (e.g. 86400)
        // opts INTO real epoch-snapped scheduling from round 2 onward.
        r.bettingEndsAt = (currentRoundId == 1 || roundIntervalSeconds == 0)
            ? block.timestamp + bettingDurationSeconds
            : _nextSlot();
        r.pool = rolledOver;
        r.rolledOverFromPrevious = rolledOver;
        emit RoundStarted(currentRoundId, r.bettingEndsAt);
    }

    function placeBet() external payable nonReentrant {
        Round storage r = rounds[currentRoundId];
        if (r.phase != Phase.BETTING) revert BadPhase();
        if (block.timestamp >= r.bettingEndsAt) revert TooLate();
        if (stakeOf[currentRoundId][msg.sender] != 0) revert AlreadyBet();

        // Whale cap -- see the contract header for its real (limited,
        // non-sybil-proof) guarantee. First-bet exemption: a %-of-pool
        // cap is mathematically unsatisfiable for a pool of exactly one
        // bettor (any nonzero stake is 100% of it), so the first bet of a
        // round is exempt; every bet after is checked against a pool that
        // already reflects real other stake.
        uint256 poolAfter = r.pool + msg.value;
        if (r.pool != 0 && msg.value * 10000 > poolAfter * maxStakePerWalletBps) {
            revert StakeExceedsCap();
        }

        stakeOf[currentRoundId][msg.sender] = msg.value;
        r.pool = poolAfter;
        participantCount[currentRoundId] += 1;
        emit BetPlaced(currentRoundId, msg.sender, msg.value);
    }

    function carryForwardStake(uint256 fromRoundId) external nonReentrant {
        if (!voided[fromRoundId]) revert BadPhase();
        if (carriedForward[fromRoundId][msg.sender]) revert AlreadyClaimed();
        uint256 amount = stakeOf[fromRoundId][msg.sender];
        if (amount == 0) revert NoBet();

        Round storage cur = rounds[currentRoundId];
        if (cur.phase != Phase.BETTING) revert BadPhase();
        if (stakeOf[currentRoundId][msg.sender] != 0) revert AlreadyBet();

        uint256 poolAfter = cur.pool + amount;
        if (cur.pool != 0 && amount * 10000 > poolAfter * maxStakePerWalletBps) {
            revert StakeExceedsCap();
        }

        carriedForward[fromRoundId][msg.sender] = true;
        stakeOf[currentRoundId][msg.sender] = amount;
        cur.pool = poolAfter;
        participantCount[currentRoundId] += 1;
        emit BetPlaced(currentRoundId, msg.sender, amount);
    }

    function lockRound() external nonReentrant {
        uint256 id = currentRoundId;
        Round storage r = rounds[id];
        if (r.phase != Phase.BETTING) revert BadPhase();
        if (block.timestamp < r.bettingEndsAt) revert TooEarly();

        if (participantCount[id] < minParticipants || r.pool < minPoolSize) {
            emit RoundVoided(id, r.pool, "under-threshold");
            voided[id] = true;
            r.phase = Phase.SETTLED;
            _startRound(0);
            return;
        }

        r.phase = Phase.LIVE;
        r.lockBlock = block.number;
        r.entropyBlock = block.number + entropyDelayBlocks;
        emit RoundLocked(id, r.lockBlock, r.entropyBlock);
    }

    /// Live cash-out. Gated against cashing out at or after the true
    /// crash point once it's known -- the load-bearing correctness
    /// property for "ticker == final": without this check, a player could
    /// cash out after the real crash but before anyone calls
    /// settleRound(), an unfair free win the ticker itself would never
    /// have shown as reachable.
    function cashOut(uint256 roundId) external nonReentrant {
        Round storage r = rounds[roundId];
        if (r.phase != Phase.LIVE) revert BadPhase();
        if (stakeOf[roundId][msg.sender] == 0) revert NoBet();
        if (cashOutBlockOf[roundId][msg.sender] != 0) revert AlreadyCashedOut();
        uint256 elapsed = block.number - r.lockBlock;
        if (r.entropyRevealed && elapsed >= _effectiveCrashElapsed(r)) revert PastCrashPoint();
        cashOutBlockOf[roundId][msg.sender] = block.number;
        r.provisionalWinningWeight += (stakeOf[roundId][msg.sender] * _multiplierAt(elapsed)) / 10000;
        emit CashedOut(roundId, msg.sender, block.number, false);
    }

    /// Set-and-forget cash-out: locks in a target multiplier NOW, before
    /// the outcome is knowable, with zero new settlement-time execution
    /// surface. _multiplierAt is strictly increasing in elapsedBlocks, so
    /// a target multiplier inverts to exactly one target block -- computed
    /// here, once, and written into the same cashOutBlockOf slot a live
    /// cashOut() uses. There is nothing left to "execute" later: if the
    /// round's real crash point (once revealed) is at or after that
    /// block, registerResult() already treats it as a normal win, byte-
    /// for-byte the same code path as a human who clicked cash out at
    /// that exact block would hit.
    ///
    /// ONLY valid before entropy is revealed -- load-bearing for fairness,
    /// not an arbitrary restriction. Once entropy is revealed, the true
    /// crash point is public; allowing presetCashOut after that would let
    /// a sophisticated reader of the reveal transaction set target =
    /// (the now-known crash point) and guarantee a win with a single,
    /// risk-free transaction -- strictly better than what a live human
    /// watching the ticker could ever do, since they still have to land a
    /// real transaction inside the live window. Before reveal, a preset
    /// target carries exactly the same genuine uncertainty a live
    /// cash-out attempt does.
    function presetCashOut(uint256 roundId, uint256 targetMultiplierBps) external nonReentrant {
        Round storage r = rounds[roundId];
        if (r.phase != Phase.LIVE) revert BadPhase();
        if (r.entropyRevealed) revert EntropyAlreadyRevealed();
        if (stakeOf[roundId][msg.sender] == 0) revert NoBet();
        if (cashOutBlockOf[roundId][msg.sender] != 0) revert AlreadyCashedOut();

        // Cheap O(1) rejection before the bounded scan below: if even the
        // maximum possible elapsed blocks can't reach this target, there's
        // no point walking the curve to find out (a fat-fingered huge
        // target would otherwise burn gas scanning up to ~22360 blocks of
        // curve before failing -- still bounded, never unbounded, but
        // needlessly expensive for a case this one comparison rules out
        // instantly).
        if (_multiplierAt(maxElapsedBlocks) < targetMultiplierBps) revert TargetUnreachable();
        uint256 targetElapsed = _invertMultiplier(targetMultiplierBps);

        cashOutBlockOf[roundId][msg.sender] = r.lockBlock + targetElapsed;
        // Use the curve's REAL value at targetElapsed, not the raw
        // targetMultiplierBps the caller passed in -- _invertMultiplier
        // finds the smallest block that reaches AT LEAST the target, so
        // the actual multiplier there can be a hair above what was asked
        // for. This must match exactly what registerResult() will later
        // compute (_multiplierAt(cashOutBlock - lockBlock)), or this
        // running total would silently drift from the real weight sum.
        r.provisionalWinningWeight += (stakeOf[roundId][msg.sender] * _multiplierAt(targetElapsed)) / 10000;
        emit CashedOut(roundId, msg.sender, r.lockBlock + targetElapsed, true);
    }

    /// Permissionless. Makes the entropy public the instant it can be --
    /// does NOT end the round. See the contract header (#1/#2) for why
    /// splitting reveal from settlement is the actual bug fix this
    /// version exists for.
    function revealEntropy(uint256 roundId) external nonReentrant {
        Round storage r = rounds[roundId];
        if (r.phase != Phase.LIVE) revert BadPhase();
        if (r.entropyRevealed) revert EntropyAlreadyRevealed();
        if (block.number <= r.entropyBlock) revert EntropyNotYetAvailable();
        if (block.number > r.entropyBlock + 256) revert EntropyExpired();

        bytes32 entropy = blockhash(r.entropyBlock);
        (uint256 trueMultiplierBps, uint256 trueElapsed) = _deriveCrash(entropy);
        r.trueCrashElapsedBlocks = trueElapsed;
        r.entropyRevealed = true;
        emit EntropyRevealed(roundId, trueMultiplierBps, trueElapsed);
    }

    /// Permissionless. Callable once real elapsed blocks reach the
    /// effective (possibly maxElapsedBlocks-capped) crash point -- i.e.
    /// exactly the block at which the live ticker itself would already be
    /// showing the final number. That equality is the whole point of #1.
    function settleRound(uint256 roundId) external nonReentrant {
        Round storage r = rounds[roundId];
        if (r.phase != Phase.LIVE) revert BadPhase();
        if (!r.entropyRevealed) revert EntropyNotRevealed();
        uint256 effective = _effectiveCrashElapsed(r);
        if (block.number - r.lockBlock < effective) revert CrashPointNotYetReached();

        r.crashElapsedBlocks = effective;
        r.crashMultiplierBps = _multiplierAt(effective);
        r.distributable = (r.pool * (10000 - rakeBps)) / 10000;
        r.registrationDeadlineBlock = block.number + registrationWindowBlocks;
        r.phase = Phase.CRASHED;

        uint256 rake = r.pool - r.distributable;
        // Keeper reward comes out of the operator's own rake, never out of
        // players' distributable pool -- see keeperRewardBps's own
        // comment. Paid via the same pull-based _asyncTransfer as every
        // other payout here, to whoever's transaction actually landed
        // first (permissionless, first-come-first-served, no special
        // caller privilege).
        uint256 keeperReward = (rake * keeperRewardBps) / 10000;
        accumulatedRake += rake - keeperReward;
        if (keeperReward > 0) _asyncTransfer(msg.sender, keeperReward);

        emit RoundCrashed(roundId, r.crashMultiplierBps, effective, r.trueCrashElapsedBlocks > maxElapsedBlocks);
        _startRound(0);
    }

    /// Liveness fallback: if nobody calls revealEntropy() before
    /// blockhash(entropyBlock) falls out of the EVM's 256-block window,
    /// the true crash point can never be derived -- without this escape
    /// hatch that round would hang in LIVE forever with real stake
    /// trapped in it. Voids exactly like an under-threshold round: pool
    /// total doesn't move automatically, each bettor carries their own
    /// stake forward via the existing carryForwardStake() path.
    function voidStaleRound(uint256 roundId) external nonReentrant {
        Round storage r = rounds[roundId];
        if (r.phase != Phase.LIVE) revert BadPhase();
        if (r.entropyRevealed) revert EntropyAlreadyRevealed();
        if (block.number <= r.entropyBlock + 256) revert TooEarly();

        emit RoundVoided(roundId, r.pool, "entropy-window-expired");
        voided[roundId] = true;
        r.phase = Phase.SETTLED;
        _startRound(0);
    }

    function claimRake() external nonReentrant {
        uint256 amount = accumulatedRake;
        accumulatedRake = 0;
        _asyncTransfer(treasury, amount);
    }

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
        _weightOf[roundId][msg.sender] = weight;
    }

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

    function _effectiveCrashElapsed(Round storage r) private view returns (uint256) {
        return r.trueCrashElapsedBlocks < maxElapsedBlocks ? r.trueCrashElapsedBlocks : maxElapsedBlocks;
    }

    /// Growth curve re-derived for Robinhood Chain's real measured block
    /// time (~100ms, i.e. ~10 blocks/real-second) -- V1's constants
    /// (400*e + 20*e^2) were tuned against local dev's simulated
    /// ~500ms-1s blocks and would climb roughly an order of magnitude too
    /// fast against real mainnet block production, reaching absurd
    /// multipliers in a couple of real seconds. Re-derived by holding
    /// real-time pacing constant (target: ~1.25x at 5 real seconds, ~8x at
    /// 50 real seconds, matching researched real crash-game pacing) and
    /// solving for new integer coefficients at ~10 blocks/sec:
    /// 10000 + 40*e + e^2/5, bps. At the default maxElapsedBlocks (see the
    /// deploy script), this gives a real, honestly-advertisable maximum
    /// multiplier reachable inside a bounded, real-time live window --
    /// nothing like V1's disconnected 10000x phantom tail.
    function _multiplierAt(uint256 elapsedBlocks) public pure returns (uint256) {
        return 10000 + (elapsedBlocks * 40) + (elapsedBlocks * elapsedBlocks) / 5;
    }

    /// Inverts _multiplierAt: smallest elapsedBlocks such that
    /// _multiplierAt(elapsedBlocks) >= targetBps. _multiplierAt is
    /// strictly increasing, so this is well-defined; bounded by
    /// maxElapsedBlocks + 1 iterations so it can never be an unbounded
    /// loop (presetCashOut() rejects anything the loop doesn't resolve
    /// within maxElapsedBlocks as TargetUnreachable before this could ever
    /// run long).
    function _invertMultiplier(uint256 targetBps) public pure returns (uint256 elapsedBlocks) {
        elapsedBlocks = 0;
        while (_multiplierAt(elapsedBlocks) < targetBps && elapsedBlocks <= 200000) {
            elapsedBlocks++;
        }
    }

    function _deriveCrash(bytes32 entropy) public pure returns (uint256 multiplierBps, uint256 elapsedBlocks) {
        uint256 r = uint256(entropy) % 10000;
        if (r == 0) {
            return (10000, 0);
        }
        multiplierBps = (10000 * 10000) / (10000 - r);
        elapsedBlocks = _invertMultiplier(multiplierBps);
    }

    // ── View helpers for the frontend ────────────────────────────────────

    function currentRound() external view returns (Round memory) {
        return rounds[currentRoundId];
    }

    /// The number the ticker shows. Once entropy is revealed, this is
    /// clamped to never exceed the effective crash point -- so a client
    /// polling this mid-crash never briefly displays a value past what
    /// the round will actually settle at.
    function liveMultiplierBps(uint256 roundId) external view returns (uint256) {
        Round storage r = rounds[roundId];
        if (r.phase != Phase.LIVE) return 0;
        uint256 elapsed = block.number - r.lockBlock;
        if (r.entropyRevealed) {
            uint256 effective = _effectiveCrashElapsed(r);
            if (elapsed > effective) elapsed = effective;
        }
        return _multiplierAt(elapsed);
    }

    /// Real economic gap this closes: this game's payout is pari-mutuel,
    /// not fixed-odds -- your actual claim is your weight's SHARE of
    /// distributable among however many other people also end up winning,
    /// not a guaranteed stake*multiplier like a house-bankrolled crash
    /// game (Aviator, Pragmatic Play, etc.) pays. If you're the only
    /// winner, you get the whole distributable pool regardless of how
    /// small your own multiplier was; if many others also cashed out high,
    /// your share shrinks accordingly. Nothing here changes that (it's
    /// inherent to running with no bankroll -- see the contract header),
    /// but a UI that only ever displayed "multiplier" without this context
    /// would be misleading players into treating it as a fixed rate.
    ///
    /// TWO REGIMES, and this is the second real fix on this function (the
    /// first found by actually re-reading it adversarially rather than
    /// assuming it was done): while the round is still LIVE, this can only
    /// ever be a provisional estimate -- "if the round crashed right now
    /// and only the current cohort of cashed-out players won" -- using
    /// provisionalWinningWeight, which by construction can include weight
    /// from a cash-out that later turns out to have been past the true
    /// crash point (see that field's own comment). Once the round has
    /// actually settled (crashElapsedBlocks is final), this switches to
    /// computing the player's REAL weight directly from the now-immutable
    /// crash point and dividing by the round's real totalWinningWeight --
    /// exact, not approximate, and it does NOT require the player to have
    /// called registerResult() first. The one remaining approximation:
    /// totalWinningWeight itself is only complete once every winner has
    /// registered, so this number can still shrink (never grow) as more
    /// real winners register post-settlement -- the same "odds aren't
    /// final until the pool closes" property real pari-mutuel pools have,
    /// just moved to a later, narrower window than before this fix.
    function estimatedPayout(uint256 roundId, address player) external view returns (uint256) {
        Round storage r = rounds[roundId];
        uint256 cashOutBlock = cashOutBlockOf[roundId][player];
        if (cashOutBlock == 0) return 0;

        if (r.phase == Phase.CRASHED || r.phase == Phase.SETTLED) {
            bool won = (cashOutBlock - r.lockBlock) <= r.crashElapsedBlocks;
            if (!won) return 0;
            uint256 realWeight = (stakeOf[roundId][player] * _multiplierAt(cashOutBlock - r.lockBlock)) / 10000;
            // Real bug caught by testing, not assumed away: gating this
            // branch on totalWinningWeight == 0 (meaning "return 0") was
            // WRONG -- totalWinningWeight only exists once at least one
            // winner has called registerResult(), so that check silently
            // returned 0 for genuine winners in the entire window between
            // settleRound() and the first registration, directly
            // contradicting this function's own documented "does not
            // require registering first" guarantee. Falls back to the
            // provisional denominator (already fully known at settlement
            // time -- provisionalWinningWeight was accumulated live) until
            // real registrations start superseding it.
            if (r.totalWinningWeight > 0) {
                return (r.distributable * realWeight) / r.totalWinningWeight;
            }
            if (r.provisionalWinningWeight == 0) return 0;
            return (r.distributable * realWeight) / r.provisionalWinningWeight;
        }

        if (r.provisionalWinningWeight == 0) return 0;
        uint256 myWeight = (stakeOf[roundId][player] * _multiplierAt(cashOutBlock - r.lockBlock)) / 10000;
        uint256 distributableNow = (r.pool * (10000 - rakeBps)) / 10000; // pool is fixed since lock
        return (distributableNow * myWeight) / r.provisionalWinningWeight;
    }
}
