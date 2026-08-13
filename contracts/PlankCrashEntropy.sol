// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ReentrancyGuard} from "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import {PullPayment} from "@openzeppelin/contracts/security/PullPayment.sol";
import {IEntropyV2} from "@pythnetwork/entropy-sdk-solidity/IEntropyV2.sol";
import {IEntropyConsumer} from "@pythnetwork/entropy-sdk-solidity/IEntropyConsumer.sol";

/**
 * Plank Crash Entropy -- same pari-mutuel game as PlankCrashV2.sol (its
 * header is required reading first; this file only documents the delta),
 * with the same one real architectural change PlankCrashVRF.sol makes:
 * the crash point's entropy no longer comes from blockhash(futureBlock).
 *
 * WHY THIS EXISTS, NOT PlankCrashVRF: Chainlink VRF v2.5's specific
 * deployment on Robinhood Chain could not be confirmed (only Data Feeds/
 * Data Streams/CCIP are confirmed live there from mainnet launch -- VRF
 * is a separate per-chain service). Pyth Entropy is the real alternative:
 * live on 76 chains including Arbitrum (the stack Robinhood Chain is
 * built on), with real confirmed production usage by on-chain provably-
 * fair casino dApps (e.g. the public apt-casino project). Pyth Entropy's
 * specific deployment on ROBINHOOD Chain itself is, honestly, ALSO not
 * independently confirmed -- see the deploy checklist at the bottom.
 * Ship whichever of PlankCrashVRF / PlankCrashEntropy has a real,
 * confirmed deployment on the actual target chain; if neither does,
 * PlankCrashV2 (blockhash-based, sequencer-trust-bounded, and disclosed
 * as such) is the only deployable option today.
 *
 * HOW PYTH ENTROPY WORKS (real mechanism, not assumed): a classical
 * two-party commit-reveal protocol. The requester commits to a secret
 * `userRandomNumber` at request time (only its hash is ever needed
 * on-chain up front); an independent Pyth provider has already committed
 * to their own hash-chain value. The final random number is a
 * combination of both parties' contributions, revealed by the provider's
 * off-chain service and delivered here via entropyCallback(). Pyth's own
 * SDK documents that the overload used here -- requestV2(provider,
 * userRandomNumber, gasLimit) -- is the STRONG variant: the other
 * requestV2() overloads that omit userRandomNumber generate the
 * requester's contribution with an in-contract PRNG instead, which Pyth's
 * own NatSpec says "modifies the security guarantees such that a
 * dishonest validator and provider can collude to manipulate the
 * result." Using this contract's own real client-committed value avoids
 * that specific weakened path.
 *
 * THIS CONTRACT'S userRandomNumber, DISCLOSED HONESTLY: this contract has
 * no off-chain human to supply a private secret, so its contribution is
 * derived on-chain at lockRound() time from blockhash(block.number - 1),
 * block.prevrandao, address(this) and the round id -- the same class of
 * sequencer-visible input PlankCrashV2's blockhash design already relies
 * on alone. That does NOT make this contract's contribution unpredictable
 * to the sequencer by itself. What it DOES add is real: to bias the FINAL
 * combined result, an attacker now needs to control both this
 * contribution AND Pyth's independent, off-chain-committed provider
 * value -- i.e. needs the Robinhood sequencer operator and a Pyth
 * randomness provider to collude, not just one party acting alone. That
 * is a genuine, structural uplift over blockhash alone (one party ->
 * two independent parties, differently operated, must collude), even
 * though it is a real, disclosed step below Chainlink VRF's fully
 * off-chain-secret-keypair guarantee.
 *
 * FEE ECONOMICS, DISCLOSED HONESTLY: Pyth Entropy charges a real fee,
 * payable as msg.value at request time (see getFeeV2()); per the SDK's
 * own NatSpec, "excess value is not refunded to the caller" and fees
 * "can change over time." lockRound() is payable and requires the caller
 * to front exactly the current fee (checked via getFeeV2() immediately
 * before requesting, then any strictly-positive excess IS refunded here,
 * a stronger behavior than the SDK's own base guarantee); settleRound()
 * reimburses that caller from the round's rake, capped at the rake
 * actually collected -- if the fee ever exceeded the rake (should not
 * happen at any realistic pool size given Pyth's typical sub-cent fees,
 * but not mathematically impossible), the shortfall is NOT currently
 * covered and the locker would be out that difference. This is the same
 * honest-disclosure standard applied to every other trust boundary in
 * this file, not a silently-assumed-safe corner.
 *
 * WHAT'S IDENTICAL TO PlankCrashV2 (same struct shape, same functions,
 * same properties, not re-litigated here): placeBet, carryForwardStake,
 * cashOut (same post-crash-point gate), presetCashOut (same pre-reveal-
 * only fairness gate), settleRound (same reveal/settle split, same
 * maxElapsedBlocks cap, same keeper reward), registerResult, claim,
 * estimatedPayout (same two-regime honesty fix), the whale cap's same
 * honest non-sybil-proof disclosure, the same _multiplierAt curve.
 *
 * OWNERSHIP: unlike PlankCrashVRF, Pyth's IEntropyV2/IEntropyConsumer
 * interfaces carry NO Ownable/ConfirmedOwner base contract requirement --
 * this contract has no owner surface at all, closer to PlankCrashV2's
 * "no admin lever, anywhere, ever" than PlankCrashVRF's disclosed,
 * procedurally-mitigated owner requirement.
 */
contract PlankCrashEntropy is ReentrancyGuard, PullPayment, IEntropyConsumer {
    enum Phase {
        BETTING,
        LIVE,
        CRASHED,
        SETTLED
    }

    struct Round {
        Phase phase;
        uint256 bettingEndsAt;
        uint256 lockBlock;
        uint64 entropySequenceNumber;
        bool entropyRevealed;
        uint256 trueCrashElapsedBlocks;
        uint256 crashElapsedBlocks;
        uint256 crashMultiplierBps;
        uint256 pool;
        uint256 distributable;
        uint256 totalWinningWeight;
        uint256 provisionalWinningWeight;
        uint256 registrationDeadlineBlock;
        uint256 rolledOverFromPrevious;
        address locker;
        uint256 entropyFeePaid;
    }

    uint256 public immutable bettingDurationSeconds;
    uint256 public immutable roundIntervalSeconds;
    uint256 public immutable genesisTimestamp;
    // How long, in blocks, this contract will wait for Pyth's provider to
    // call entropyCallback() before voidStaleRequest() becomes callable.
    // A policy choice (see PlankCrashVRF.sol's maxAwaitBlocks for the same
    // reasoning) -- generous enough to absorb normal provider latency,
    // tight enough that a genuinely stuck round doesn't trap stake long.
    uint256 public immutable maxAwaitBlocks;
    uint256 public immutable maxElapsedBlocks;
    uint256 public immutable registrationWindowBlocks;
    uint256 public immutable rakeBps;
    uint256 public immutable minParticipants;
    uint256 public immutable minPoolSize;
    uint256 public immutable maxStakePerWalletBps;
    uint256 public immutable keeperRewardBps;
    // Real audit finding: without this, calling lockRound() was strictly
    // break-even at best (exact fee reimbursement, no profit margin) for
    // whoever fronts the real Pyth fee -- no rational keeper bot has any
    // reason to call it over a more profitable settleRound() elsewhere,
    // a real single-point-of-liveness-failure with no economic backstop.
    // Paid to r.locker at settleRound() time, out of the same rake
    // keeperRewardBps already draws from, on top of (not instead of) fee
    // reimbursement -- gives lockRound() a real, if small, profit margin.
    uint256 public immutable lockerRewardBps;
    address public immutable treasury;
    uint256 public accumulatedRake;

    IEntropyV2 public immutable entropy;
    address public immutable entropyProvider;
    uint32 public immutable entropyGasLimit;

    uint256 public currentRoundId;
    mapping(uint256 => Round) public rounds;
    mapping(uint64 => uint256) public sequenceToRoundId;
    mapping(uint256 => mapping(address => uint256)) public stakeOf;
    mapping(uint256 => mapping(address => uint256)) public cashOutBlockOf;
    mapping(uint256 => mapping(address => bool)) public registered;
    mapping(uint256 => mapping(address => bool)) public claimed;
    mapping(uint256 => mapping(address => uint256)) private _weightOf;
    mapping(uint256 => uint256) public participantCount;
    mapping(uint256 => bool) public voided;
    mapping(uint256 => mapping(address => bool)) public carriedForward;

    event RoundStarted(uint256 indexed roundId, uint256 bettingEndsAt);
    event BetPlaced(uint256 indexed roundId, address indexed player, uint256 amount);
    event RoundLocked(uint256 indexed roundId, uint256 lockBlock, uint64 sequenceNumber);
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
    error EntropyNotRevealed();
    error EntropyAlreadyRevealed();
    error CrashPointNotYetReached();
    error PastCrashPoint();
    error TargetUnreachable();
    error UnknownSequenceNumber();
    error InsufficientFee();

    struct Config {
        uint256 bettingDurationSeconds;
        uint256 roundIntervalSeconds;
        uint256 maxAwaitBlocks;
        uint256 maxElapsedBlocks;
        uint256 registrationWindowBlocks;
        uint256 rakeBps;
        uint256 minParticipants;
        uint256 minPoolSize;
        uint256 maxStakePerWalletBps;
        uint256 keeperRewardBps;
        uint256 lockerRewardBps;
        address treasury;
        address entropy;
        address entropyProvider;
        uint32 entropyGasLimit;
    }

    constructor(Config memory cfg) {
        bettingDurationSeconds = cfg.bettingDurationSeconds;
        roundIntervalSeconds = cfg.roundIntervalSeconds;
        genesisTimestamp = block.timestamp;
        maxAwaitBlocks = cfg.maxAwaitBlocks;
        maxElapsedBlocks = cfg.maxElapsedBlocks;
        registrationWindowBlocks = cfg.registrationWindowBlocks;
        rakeBps = cfg.rakeBps;
        minParticipants = cfg.minParticipants;
        minPoolSize = cfg.minPoolSize;
        maxStakePerWalletBps = cfg.maxStakePerWalletBps;
        keeperRewardBps = cfg.keeperRewardBps;
        lockerRewardBps = cfg.lockerRewardBps;
        treasury = cfg.treasury;
        entropy = IEntropyV2(cfg.entropy);
        entropyProvider = cfg.entropyProvider;
        entropyGasLimit = cfg.entropyGasLimit;
        _startRound(0);
    }

    // ── Round lifecycle ──────────────────────────────────────────────────

    function _nextSlot() private view returns (uint256) {
        uint256 elapsed = block.timestamp - genesisTimestamp;
        uint256 k = (elapsed / roundIntervalSeconds) + 1;
        return genesisTimestamp + k * roundIntervalSeconds;
    }

    function _startRound(uint256 rolledOver) private {
        currentRoundId += 1;
        Round storage r = rounds[currentRoundId];
        r.phase = Phase.BETTING;
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

    /// Locks the round AND immediately requests Pyth Entropy randomness --
    /// no "wait for a future block to exist" step, same shape as
    /// PlankCrashVRF's lockRound(). Payable: caller must front the real
    /// Pyth fee (see the contract header's FEE ECONOMICS section); any
    /// strictly-positive excess over the current fee is refunded here.
    function lockRound() external payable nonReentrant {
        uint256 id = currentRoundId;
        Round storage r = rounds[id];
        if (r.phase != Phase.BETTING) revert BadPhase();
        if (block.timestamp < r.bettingEndsAt) revert TooEarly();

        if (participantCount[id] < minParticipants || r.pool < minPoolSize) {
            emit RoundVoided(id, r.pool, "under-threshold");
            voided[id] = true;
            r.phase = Phase.SETTLED;
            if (msg.value > 0) _asyncTransfer(msg.sender, msg.value);
            _startRound(0);
            return;
        }

        uint128 fee = entropy.getFeeV2(entropyProvider, entropyGasLimit);
        if (msg.value < fee) revert InsufficientFee();

        r.phase = Phase.LIVE;
        r.lockBlock = block.number;
        r.locker = msg.sender;
        r.entropyFeePaid = fee;

        bytes32 userRandomNumber = keccak256(
            abi.encodePacked(blockhash(block.number - 1), block.prevrandao, address(this), id)
        );
        uint64 sequenceNumber = entropy.requestV2{value: fee}(entropyProvider, userRandomNumber, entropyGasLimit);
        r.entropySequenceNumber = sequenceNumber;
        sequenceToRoundId[sequenceNumber] = id;

        if (msg.value > fee) _asyncTransfer(msg.sender, msg.value - fee);
        emit RoundLocked(id, r.lockBlock, sequenceNumber);
    }

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

    function presetCashOut(uint256 roundId, uint256 targetMultiplierBps) external nonReentrant {
        Round storage r = rounds[roundId];
        if (r.phase != Phase.LIVE) revert BadPhase();
        if (r.entropyRevealed) revert EntropyAlreadyRevealed();
        if (stakeOf[roundId][msg.sender] == 0) revert NoBet();
        if (cashOutBlockOf[roundId][msg.sender] != 0) revert AlreadyCashedOut();

        if (_multiplierAt(maxElapsedBlocks) < targetMultiplierBps) revert TargetUnreachable();
        uint256 targetElapsed = _invertMultiplier(targetMultiplierBps);

        cashOutBlockOf[roundId][msg.sender] = r.lockBlock + targetElapsed;
        r.provisionalWinningWeight += (stakeOf[roundId][msg.sender] * _multiplierAt(targetElapsed)) / 10000;
        emit CashedOut(roundId, msg.sender, r.lockBlock + targetElapsed, true);
    }

    // ── IEntropyConsumer ──────────────────────────────────────────────────

    function getEntropy() internal view override returns (address) {
        return address(entropy);
    }

    /// Pyth's own callback -- not permissionless. _entropyCallback (the
    /// external entrypoint in IEntropyConsumer) already enforces
    /// msg.sender == getEntropy() before this internal function ever runs.
    function entropyCallback(uint64 sequence, address /* provider */, bytes32 randomNumber) internal override {
        uint256 roundId = sequenceToRoundId[sequence];
        if (roundId == 0) revert UnknownSequenceNumber();
        Round storage r = rounds[roundId];
        if (r.phase != Phase.LIVE) revert BadPhase();
        if (r.entropyRevealed) revert EntropyAlreadyRevealed();

        (uint256 trueMultiplierBps, uint256 trueElapsed) = _deriveCrash(randomNumber);
        r.trueCrashElapsedBlocks = trueElapsed;
        r.entropyRevealed = true;
        emit EntropyRevealed(roundId, trueMultiplierBps, trueElapsed);
    }

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
        // Reimburse whoever fronted the real Pyth fee at lockRound() time,
        // capped at the rake actually collected -- see the header's FEE
        // ECONOMICS section for the honest disclosure of what happens if
        // the fee ever exceeded the rake (not currently covered).
        uint256 feeReimbursement = r.entropyFeePaid < rake ? r.entropyFeePaid : rake;
        uint256 remainingRake = rake - feeReimbursement;
        // Real profit margin for the locker, on top of fee-neutrality --
        // see lockerRewardBps's own comment for why this exists.
        uint256 lockerReward = (remainingRake * lockerRewardBps) / 10000;
        uint256 keeperReward = (remainingRake * keeperRewardBps) / 10000;
        accumulatedRake += remainingRake - lockerReward - keeperReward;
        if (feeReimbursement + lockerReward > 0) _asyncTransfer(r.locker, feeReimbursement + lockerReward);
        if (keeperReward > 0) _asyncTransfer(msg.sender, keeperReward);

        emit RoundCrashed(roundId, r.crashMultiplierBps, effective, r.trueCrashElapsedBlocks > maxElapsedBlocks);
        _startRound(0);
    }

    /// Liveness fallback for Pyth's real (if rare) failure modes: a
    /// provider outage, a callback that reverts and never gets retried.
    /// Without this, a round the provider never calls back for would hang
    /// in LIVE forever with real stake trapped in it. The fee already
    /// fronted by r.locker is refunded here too -- voiding is not their
    /// fault.
    function voidStaleRequest(uint256 roundId) external nonReentrant {
        Round storage r = rounds[roundId];
        if (r.phase != Phase.LIVE) revert BadPhase();
        if (r.entropyRevealed) revert EntropyAlreadyRevealed();
        if (block.number <= r.lockBlock + maxAwaitBlocks) revert TooEarly();

        emit RoundVoided(roundId, r.pool, "entropy-fulfillment-timeout");
        voided[roundId] = true;
        r.phase = Phase.SETTLED;
        if (r.entropyFeePaid > 0) _asyncTransfer(r.locker, r.entropyFeePaid);
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

    // ── Pure math -- byte-for-byte identical to PlankCrashV2's, not ──────
    // ── re-derived, so both contracts pay out the exact same curve ──────

    function _effectiveCrashElapsed(Round storage r) private view returns (uint256) {
        return r.trueCrashElapsedBlocks < maxElapsedBlocks ? r.trueCrashElapsedBlocks : maxElapsedBlocks;
    }

    function _multiplierAt(uint256 elapsedBlocks) public pure returns (uint256) {
        return 10000 + (elapsedBlocks * 40) + (elapsedBlocks * elapsedBlocks) / 5;
    }

    function _invertMultiplier(uint256 targetBps) public pure returns (uint256 elapsedBlocks) {
        elapsedBlocks = 0;
        while (_multiplierAt(elapsedBlocks) < targetBps && elapsedBlocks <= 200000) {
            elapsedBlocks++;
        }
    }

    function _deriveCrash(bytes32 entropyValue) public pure returns (uint256 multiplierBps, uint256 elapsedBlocks) {
        uint256 r = uint256(entropyValue) % 10000;
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

    function estimatedPayout(uint256 roundId, address player) external view returns (uint256) {
        Round storage r = rounds[roundId];
        uint256 cashOutBlock = cashOutBlockOf[roundId][player];
        if (cashOutBlock == 0) return 0;

        if (r.phase == Phase.CRASHED || r.phase == Phase.SETTLED) {
            bool won = (cashOutBlock - r.lockBlock) <= r.crashElapsedBlocks;
            if (!won) return 0;
            uint256 realWeight = (stakeOf[roundId][player] * _multiplierAt(cashOutBlock - r.lockBlock)) / 10000;
            if (r.totalWinningWeight > 0) {
                return (r.distributable * realWeight) / r.totalWinningWeight;
            }
            if (r.provisionalWinningWeight == 0) return 0;
            return (r.distributable * realWeight) / r.provisionalWinningWeight;
        }

        if (r.provisionalWinningWeight == 0) return 0;
        uint256 myWeight = (stakeOf[roundId][player] * _multiplierAt(cashOutBlock - r.lockBlock)) / 10000;
        uint256 distributableNow = (r.pool * (10000 - rakeBps)) / 10000;
        return (distributableNow * myWeight) / r.provisionalWinningWeight;
    }
}

/*
 * DEPLOY CHECKLIST -- read before mainnet, not after:
 *   [ ] Confirm Pyth Entropy is actually live on Robinhood Chain (check
 *       https://docs.pyth.network/entropy/contract-addresses for the real,
 *       current list -- it was NOT independently confirmed there as part
 *       of building this). If it isn't live there yet, neither this nor
 *       PlankCrashVRF is deployable there yet -- PlankCrashV2.sol
 *       (blockhash-based, sequencer-trust-bounded, disclosed as such) is
 *       the only interim option.
 *   [ ] Confirm the real entropyProvider address for the target chain via
 *       entropy.getDefaultProvider() (or a specific provider you've
 *       vetted) -- do not hardcode a guessed address.
 *   [ ] Fund the deployer/keeper wallet(s) that will call lockRound() with
 *       enough native token to front the real Pyth fee each round --
 *       reimbursed from rake at settleRound(), but fronted first.
 *   [ ] Monitor entropy.getFeeV2() over time -- Pyth's own docs say fees
 *       "can change over time" and should be re-queried before each
 *       request (this contract already does that inside lockRound()).
 */
