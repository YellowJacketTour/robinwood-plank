// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ReentrancyGuard} from "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import {PullPayment} from "@openzeppelin/contracts/security/PullPayment.sol";
import {IDrandBeacon} from "./IDrandBeacon.sol";

/**
 * Plank Crash Drand -- same pari-mutuel game as PlankCrashV2.sol (its
 * header is required reading first; this file only documents the delta),
 * with the same one real architectural change PlankCrashVRF.sol and
 * PlankCrashEntropy.sol make: the crash point's entropy no longer comes
 * from blockhash(futureBlock).
 *
 * WHY THIS EXISTS, NOT VRF OR PYTH: neither Chainlink VRF nor Pyth
 * Entropy could be confirmed deployed on Robinhood Chain -- checked for
 * real via eth_getCode against both services' real Arbitrum One
 * addresses (VRF coordinator 0x3C0Ca6...B6f7a3e, Pyth Entropy
 * 0x7698e9...20adac) on Robinhood Chain's real mainnet RPC (chainId
 * 4663), which returned "0x" for both -- no contract there, full stop.
 *
 * UNIFIED WITH THE REST OF plank.love, NOT A SEPARATE SYSTEM: this
 * contract does NOT verify drand signatures itself. It reads verified
 * randomness from DrandBeacon.sol -- the SAME shared, permissionless,
 * verify-on-chain drand round cache MarketplankVaultV3.sol already
 * depends on for its own random redemption. This used to be a bespoke,
 * duplicate verifier (DrandBLSVerifier.sol, since deleted) built without
 * realizing the shared beacon already existed in this repo; consolidating
 * onto it means the whole protocol shares ONE audited BLS-verification
 * surface instead of two, and this contract, the vault, and any future
 * consumer (e.g. a wager-weighted airdrop draw) all trust the exact same
 * cache of real, independently-verified drand rounds. See DrandBeacon.sol's
 * own header for the full trust-model writeup (League of Entropy
 * threshold BLS, BN254 EVM-native precompiles, deploy-time-verified
 * public key) -- not re-litigated here.
 *
 * HOW IT WORKS: lockRound() asks the beacon for the next drand round
 * strictly after now (beacon.nextRoundAfter), adds a real safety margin
 * (TARGET_ROUND_SAFETY_PERIODS -- see its own comment for why), and
 * commits this round to it. Once that round's real-world due time has
 * passed, ANYONE can relay its signature to the shared beacon (permissionless,
 * beacon.submitRound() -- verified once there, not per-consumer) and then
 * call this contract's revealEntropy(), which simply reads
 * beacon.randomnessOrZero() -- no signature, no re-verification here.
 * settleRound() is otherwise unchanged from PlankCrashV2.
 *
 * REAL, HONEST COST/BENEFIT vs the other two variants:
 *   - No fee, ever (drand's evmnet is a public good) -- unlike
 *     PlankCrashEntropy.sol, lockRound() doesn't need to front, refund,
 *     or reimburse anything.
 *   - No owner surface at all, like PlankCrashEntropy.sol and unlike
 *     PlankCrashVRF.sol's disclosed ConfirmedOwner requirement.
 *   - The beacon's public key and timing parameters are READ from the
 *     shared DrandBeacon, not duplicated as local constants -- one fewer
 *     place for a mismatch between this contract and the rest of the
 *     protocol to ever exist.
 *   - Genuinely decentralized trust: biasing a future round requires
 *     colluding across a THRESHOLD of League of Entropy's real,
 *     independent member organizations -- not "the sequencer" (V2) and
 *     not "one Pyth/Chainlink provider" (Entropy/VRF).
 *   - Real, disclosed limitation: nobody is economically bonded to relay
 *     a round to the beacon or call revealEntropy() promptly -- same
 *     permissionless-keeper-liveness shape V2 already has, mitigated the
 *     same way (voidStaleRound() as the fallback, keeperRewardBps as the
 *     incentive once a round DOES settle).
 */
contract PlankCrashDrand is ReentrancyGuard, PullPayment {
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
        uint64 targetDrandRound;
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
    }

    uint256 public immutable bettingDurationSeconds;
    uint256 public immutable roundIntervalSeconds;
    uint256 public immutable genesisTimestamp;
    // How long, in blocks, this contract will wait for ANYONE to relay
    // the target round to the beacon and call revealEntropy() before
    // voidStaleRound() becomes callable. Unlike blockhash's real
    // 256-block EVM expiry (PlankCrashV2) or an oracle-network outage
    // (VRF/Entropy), a drand round's signature is permanently, publicly
    // fetchable forever once its time passes -- this window exists
    // purely as an anti-griefing/keeper-liveness safety net (nobody
    // bonded to relay/reveal promptly), not because the entropy itself
    // could ever become unavailable.
    uint256 public immutable maxAwaitBlocks;
    uint256 public immutable maxElapsedBlocks;
    uint256 public immutable registrationWindowBlocks;
    uint256 public immutable rakeBps;
    uint256 public immutable minParticipants;
    uint256 public immutable minPoolSize;
    uint256 public immutable maxStakePerWalletBps;
    uint256 public immutable keeperRewardBps;
    address public immutable treasury;
    uint256 public accumulatedRake;

    // The shared, protocol-wide drand round cache -- see this file's own
    // header ("UNIFIED WITH THE REST OF plank.love") for why this reads
    // from the same beacon MarketplankVaultV3 uses, instead of verifying
    // signatures itself.
    IDrandBeacon public immutable beacon;

    // Real safety margin, in whole drand rounds, added on top of the
    // strictly-next round the beacon reports -- absorbs normal clock
    // skew between this chain's block.timestamp and drand's own
    // genesis-time math so lockRound() never accidentally targets a
    // round that's already (or about to be) producible before the lock
    // transaction even confirms.
    //
    // Sized at 20 rounds (60s at evmnet's real 3s period), not a
    // thinner margin: a real, disclosed L2-specific risk, found during
    // audit, not steady clock drift (which is self-cancelling --
    // presetCashOut's/revealEntropy's due-time checks read the same
    // beacon.currentRoundAt() the target was picked against). Arbitrum-
    // style Orbit sequencers can snap block.timestamp forward in a
    // single step to catch up to wall-clock time after an idle gap with
    // no transactions -- a documented sequencer behavior, not
    // hypothetical. On a low-traffic contract, an idle gap after
    // lockRound() could jump block.timestamp straight past a too-close
    // target round's real due time, collapsing the intended live-play
    // window for whoever is watching the relay versus whoever isn't. 20
    // rounds is generous headroom against ordinary idle-gap jumps; this
    // remains a real, disclosed assumption about sequencer timestamp
    // jump size, not a mathematical guarantee.
    uint256 private constant TARGET_ROUND_SAFETY_PERIODS = 20;

    uint256 public currentRoundId;
    mapping(uint256 => Round) public rounds;
    mapping(uint64 => uint256) public drandRoundToRoundId;
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
    event RoundLocked(uint256 indexed roundId, uint256 lockBlock, uint64 targetDrandRound);
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
    error RandomnessNotYetAvailable();
    error ZeroBeacon();
    error RoundIntervalTooShort();

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
        address treasury;
        address beacon;
    }

    constructor(Config memory cfg) {
        if (cfg.beacon == address(0)) revert ZeroBeacon();
        if (cfg.beacon.code.length == 0) revert ZeroBeacon();
        beacon = IDrandBeacon(cfg.beacon);
        // If roundIntervalSeconds were smaller than the drand safety
        // window, two consecutive game rounds could compute the IDENTICAL
        // targetDrandRound -- nothing else would stop round N+1 from
        // settling off the same signature round N already revealed,
        // making round N+1's outcome knowable before it even locks. Real
        // audit finding; guarded here instead of only in a deploy-script
        // comment so a future/alternate config can't silently reintroduce
        // it. roundIntervalSeconds == 0 (this repo's local-dev "reopen
        // immediately" mode) is exempt: real round cadence there is
        // whatever bettingDurationSeconds naturally imposes, already far
        // longer than the drand safety window at any realistic setting.
        if (cfg.roundIntervalSeconds != 0) {
            if (cfg.roundIntervalSeconds <= (TARGET_ROUND_SAFETY_PERIODS + 1) * beacon.period()) {
                revert RoundIntervalTooShort();
            }
        }
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
        treasury = cfg.treasury;
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

    /// Locks the round and commits it to a specific future drand round --
    /// no request/response step, no fee. Anyone can independently
    /// recompute targetDrandRound off-chain from lockBlock's timestamp
    /// via the same beacon.nextRoundAfter() this calls -- nothing here
    /// is a secret.
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
        r.targetDrandRound = beacon.nextRoundAfter(block.timestamp) + uint64(TARGET_ROUND_SAFETY_PERIODS);
        drandRoundToRoundId[r.targetDrandRound] = id;
        emit RoundLocked(id, r.lockBlock, r.targetDrandRound);
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

    /// ONLY valid while the target drand round is genuinely NOT YET DUE --
    /// gated on real availability (beacon.currentRoundAt(now) < the
    /// target round), NOT on whether revealEntropy() has been called on
    /// THIS contract yet. Real bug, found and fixed here (the same class
    /// of bug found and fixed in PlankCrashV2.sol's presetCashOut -- see
    /// that file's own comment for the full writeup): a drand evmnet
    /// round's real signature is publicly fetchable via any drand HTTP
    /// relay the instant its due time passes, regardless of whether
    /// anyone has relayed it to the shared beacon or called
    /// revealEntropy() here yet. Gating on the on-chain flag alone would
    /// let anyone who fetches the signature off-chain, verifies it
    /// themselves (or just trusts the public relay), and computes the
    /// true crash point locally, call presetCashOut with a guaranteed,
    /// risk-free maximum-multiplier target before anyone bothers to
    /// reveal on-chain.
    function presetCashOut(uint256 roundId, uint256 targetMultiplierBps) external nonReentrant {
        Round storage r = rounds[roundId];
        if (r.phase != Phase.LIVE) revert BadPhase();
        if (r.entropyRevealed || beacon.currentRoundAt(block.timestamp) >= r.targetDrandRound) {
            revert EntropyAlreadyRevealed();
        }
        if (stakeOf[roundId][msg.sender] == 0) revert NoBet();
        if (cashOutBlockOf[roundId][msg.sender] != 0) revert AlreadyCashedOut();

        if (_multiplierAt(maxElapsedBlocks) < targetMultiplierBps) revert TargetUnreachable();
        uint256 targetElapsed = _invertMultiplier(targetMultiplierBps);

        cashOutBlockOf[roundId][msg.sender] = r.lockBlock + targetElapsed;
        r.provisionalWinningWeight += (stakeOf[roundId][msg.sender] * _multiplierAt(targetElapsed)) / 10000;
        emit CashedOut(roundId, msg.sender, r.lockBlock + targetElapsed, true);
    }

    /// Permissionless, like PlankCrashV2's revealEntropy() -- anyone who
    /// has relayed targetDrandRound's real signature to the shared
    /// beacon (beacon.submitRound(), verified there once for every
    /// consumer) can call this. No signature is passed here and nothing
    /// is re-verified -- this contract only reads the beacon's already-
    /// verified cache.
    function revealEntropy(uint256 roundId) external {
        Round storage r = rounds[roundId];
        if (r.phase != Phase.LIVE) revert BadPhase();
        if (r.entropyRevealed) revert EntropyAlreadyRevealed();
        bytes32 randomness = beacon.randomnessOrZero(r.targetDrandRound);
        if (randomness == bytes32(0)) revert RandomnessNotYetAvailable();

        (uint256 trueMultiplierBps, uint256 trueElapsed) = _deriveCrash(randomness);
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
        uint256 keeperReward = (rake * keeperRewardBps) / 10000;
        accumulatedRake += rake - keeperReward;
        if (keeperReward > 0) _asyncTransfer(msg.sender, keeperReward);

        emit RoundCrashed(roundId, r.crashMultiplierBps, effective, r.trueCrashElapsedBlocks > maxElapsedBlocks);
        _startRound(0);
    }

    /// Anti-griefing liveness fallback -- see maxAwaitBlocks's own
    /// comment for why this exists despite drand signatures never
    /// actually expiring (unlike blockhash's real 256-block window).
    function voidStaleRound(uint256 roundId) external nonReentrant {
        Round storage r = rounds[roundId];
        if (r.phase != Phase.LIVE) revert BadPhase();
        if (r.entropyRevealed) revert EntropyAlreadyRevealed();
        if (block.number <= r.lockBlock + maxAwaitBlocks) revert TooEarly();

        emit RoundVoided(roundId, r.pool, "reveal-timeout");
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

    // ── Pure math -- byte-for-byte identical to PlankCrashV2's, not ──────
    // ── re-derived, so all four contracts pay out the exact same curve ──

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
 *   [ ] Deploy (or reuse the already-deployed) DrandBeacon.sol first --
 *       see ITS OWN deploy-time-parameters section for the real chain
 *       hash / public key verification steps required before IT is
 *       deployable. This contract has no drand parameters of its own to
 *       verify -- it only needs the beacon's real address.
 *   [ ] If MarketplankVaultV3 already has a live DrandBeacon deployed on
 *       the target chain, REUSE that exact address here -- that is the
 *       entire point of the shared-cache design (one verified round
 *       serves every consumer, and only one beacon needs auditing).
 *   [ ] Confirm a real keeper (or the community) actually relays rounds
 *       to the beacon promptly -- voidStaleRound()'s maxAwaitBlocks is
 *       the fallback if nobody does, not a substitute for a reliable
 *       relay process.
 */
