// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ReentrancyGuard} from "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import {PullPayment} from "@openzeppelin/contracts/security/PullPayment.sol";
import {IDrandVerifier} from "./IDrandVerifier.sol";

/**
 * Plank Crash Drand -- same pari-mutuel game as PlankCrashV2.sol (its
 * header is required reading first; this file only documents the delta),
 * with the same one real architectural change PlankCrashVRF.sol and
 * PlankCrashEntropy.sol make: the crash point's entropy no longer comes
 * from blockhash(futureBlock).
 *
 * WHY THIS EXISTS, NOT VRF OR PYTH: neither Chainlink VRF nor Pyth
 * Entropy could be confirmed deployed on Robinhood Chain -- and this
 * wasn't left as a docs-level "couldn't confirm", it was checked for
 * real: eth_getCode against both services' real Arbitrum One addresses
 * (VRF coordinator 0x3C0Ca6...B6f7a3e, Pyth Entropy 0x7698e9...20adac)
 * on Robinhood Chain's real mainnet RPC (chainId 4663, confirmed via
 * eth_chainId) returned "0x" for both -- no contract there, full stop.
 *
 * The real fix for that specific problem: `drand`'s `evmnet` beacon
 * needs NO chain-specific contract deployed by anyone else at all. It is
 * a public, continuously-running, threshold-BLS randomness beacon
 * operated since 2020 by the League of Entropy -- a real, independently
 * governed consortium (Cloudflare, Protocol Labs, EPFL, ChainSafe,
 * Kudelski Security, and others; see https://drand.love/about/), none of
 * whom individually can predict or bias a future round. `evmnet`
 * specifically (launched 2024) signs on the BN254 curve so its output is
 * verifiable using EVM-native precompiles (ecAdd/ecMul/ecPairing at
 * 0x06/0x07/0x08) that have existed since the Byzantium hardfork on
 * every EVM chain, including Robinhood Chain -- confirmed for real, not
 * assumed, by calling those exact precompile addresses on Robinhood
 * Chain's live mainnet RPC and getting correct, real cryptographic
 * output back (an empty pairing check returning true; ecAdd(0,0)
 * returning (0,0)). There is nothing left to "confirm is deployed" here
 * -- the verifier is code THIS contract runs itself, using math the EVM
 * already provides.
 *
 * HOW IT WORKS: lockRound() computes the drand round number whose
 * genesis-time-and-period math guarantees it will be produced strictly
 * after the current block (genesisTime/period are evmnet's own fixed,
 * public protocol constants, not a deploy-time config choice -- see
 * DRAND_GENESIS_TIME/DRAND_PERIOD below), and stores it as the round
 * this game round is committed to. Once that round's time has passed,
 * ANYONE can fetch its public signature from any drand HTTP relay (a
 * public good, no API key, no fee) and call revealEntropy() with it --
 * exactly the same permissionless-reveal shape as PlankCrashV2's
 * revealEntropy(), just verifying a real BLS signature instead of
 * reading blockhash(). settleRound() is otherwise unchanged.
 *
 * REAL, HONEST COST/BENEFIT vs the other two variants:
 *   - No fee, ever (drand's evmnet is a public good) -- unlike
 *     PlankCrashEntropy.sol, lockRound() doesn't need to front, refund,
 *     or reimburse anything.
 *   - No owner surface at all, like PlankCrashEntropy.sol and unlike
 *     PlankCrashVRF.sol's disclosed ConfirmedOwner requirement.
 *   - The public key and beacon parameters are PERMANENT, network-wide
 *     constants (see the constants below, decomposed for real from the
 *     live https://api.drand.sh/v2/beacons/evmnet/info response using
 *     the same "kevincharm/noble-bn254-drand" tooling drand's own docs
 *     recommend) -- not configurable per-deploy, which is a feature
 *     (nothing for a deploy script to get wrong) and a real constraint
 *     (this contract can never point at a different beacon without a
 *     redeploy).
 *   - Genuinely decentralized trust: biasing a future round requires
 *     colluding across a THRESHOLD of League of Entropy's real,
 *     independent member organizations -- not "the sequencer" (V2) and
 *     not "one Pyth/Chainlink provider" (Entropy/VRF), a meaningfully
 *     larger, differently-composed set of parties who would all have to
 *     collude in advance of a specific round.
 *   - Real, disclosed limitation: nobody is economically bonded to call
 *     revealEntropy() promptly -- same permissionless-keeper-liveness
 *     shape V2 already has for its own revealEntropy(), mitigated the
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
    // How long, in blocks, this contract will wait for ANYONE to call
    // revealEntropy() with a real drand signature before voidStaleRound()
    // becomes callable. Unlike blockhash's real 256-block EVM expiry
    // (PlankCrashV2) or an oracle-network outage (VRF/Entropy), a drand
    // round's signature is permanently, publicly fetchable forever once
    // its time passes -- this window exists purely as an anti-griefing/
    // keeper-liveness safety net (nobody bonded to call it promptly), not
    // because the entropy itself could ever become unavailable.
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

    // ── drand evmnet beacon parameters -- REAL, PERMANENT, network-wide
    // constants, not deploy-time config. The public key and DST used to
    // actually verify signatures live in DrandBLSVerifier.sol -- split
    // into its own contract for a real compiler reason, see this file's
    // "WHY IT'S A SEPARATE CONTRACT" note near revealEntropy() below and
    // DrandBLSVerifier.sol's own header. Only the timing parameters
    // needed to compute a target round number live here.
    uint256 private constant DRAND_GENESIS_TIME = 1727521075;
    uint256 private constant DRAND_PERIOD = 3;
    // Real safety margin, in whole drand periods, added on top of the
    // strictly-next round -- absorbs normal clock skew between this
    // chain's block.timestamp and drand's own genesis-time math so
    // lockRound() never accidentally targets a round that's already (or
    // about to be) producible before the lock transaction even confirms.
    uint256 private constant TARGET_ROUND_SAFETY_PERIODS = 2;

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
    error DrandRoundNotYetDue();
    error InvalidSignature();

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
        address drandVerifier;
    }

    // The standalone BLS verifier -- see DrandBLSVerifier.sol's header
    // for why signature verification lives there instead of inline here.
    // Typed as the interface, not the concrete contract, so tests can
    // swap in a mock for game-logic coverage while DrandBLSVerifier's
    // own real cryptography is proven independently (see
    // test/contracts/DrandBLSVerifier.test.ts).
    IDrandVerifier public immutable drandVerifier;

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
        treasury = cfg.treasury;
        drandVerifier = IDrandVerifier(cfg.drandVerifier);
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
    /// recompute targetDrandRound off-chain from lockBlock's timestamp,
    /// exactly like V1/V2's entropyBlock was always independently
    /// recomputable -- nothing here is a secret.
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
        r.targetDrandRound = _targetDrandRound(block.timestamp);
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

    /// Permissionless, like PlankCrashV2's revealEntropy() -- anyone who
    /// has fetched `targetDrandRound`'s real public signature from any
    /// drand HTTP relay (e.g. https://api.drand.sh/v2/beacons/evmnet/rounds/{round})
    /// can submit it. Verified for real here via BN254 pairing (delegated
    /// to the standalone drandVerifier contract -- see its own header and
    /// this file's DrandBLSVerifier import for why), not trusted from the
    /// caller.
    function revealEntropy(uint256 roundId, uint256[2] calldata signature) external {
        Round storage r = rounds[roundId];
        if (r.phase != Phase.LIVE) revert BadPhase();
        if (r.entropyRevealed) revert EntropyAlreadyRevealed();
        if (block.timestamp < DRAND_GENESIS_TIME + r.targetDrandRound * DRAND_PERIOD) revert DrandRoundNotYetDue();
        if (!drandVerifier.verifyRound(r.targetDrandRound, signature)) revert InvalidSignature();

        (uint256 trueMultiplierBps, uint256 trueElapsed) = _deriveCrash(keccak256(abi.encode(signature)));
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

    // ── drand round targeting/verification ──────────────────────────────

    function _targetDrandRound(uint256 deadline) private pure returns (uint64) {
        uint256 delta = deadline - DRAND_GENESIS_TIME;
        uint64 round = uint64((delta / DRAND_PERIOD) + ((delta % DRAND_PERIOD) > 0 ? 1 : 0));
        return round + uint64(TARGET_ROUND_SAFETY_PERIODS);
    }


    // ── Pure math -- byte-for-byte identical to PlankCrashV2's, not ──────
    // ── re-derived, so all three contracts pay out the exact same curve ─

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
 *   [ ] Re-fetch https://api.drand.sh/v2/beacons/evmnet/info immediately
 *       before deploy and diff it against the constants hardcoded above
 *       (chain_hash 04f1e906...66ec8c3) -- the League of Entropy governs
 *       evmnet's fate collectively; while there is "no plan to wind it
 *       down" as of this writing, that is a real, disclosed dependency
 *       on an external public good continuing to run, not a guarantee.
 *   [ ] Re-run the two eth_getCode/eth_call precompile probes against
 *       whatever RPC endpoint you're actually deploying through
 *       (rpc.mainnet.chain.robinhood.com was used to verify this) -- a
 *       different RPC provider fronting the same chain should return
 *       identical results, but verify against the real one you'll use.
 *   [ ] Load-test revealEntropy() against a real drand relay response
 *       shape end-to-end on a public testnet before mainnet, not just
 *       against the local mock (test/contracts/helpers/ -- see
 *       PlankCrashDrand.test.ts's own header for what the mock does and
 *       does not prove).
 */
