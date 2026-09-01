// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;


import {ReentrancyGuard} from "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import {PullPayment} from "@openzeppelin/contracts/security/PullPayment.sol";
import {IDrandBeacon} from "./IDrandBeacon.sol";
import {IPlankProgression} from "./IPlankProgression.sol";

/// The Powerboard's funding surface -- the Vault cascades its overflow here,
/// unifying the crash's compounding growth with the daily rolling jackpot.
interface IPlankJackpotSink {
    function fund() external payable;
}

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

    // GAS OPTIMIZATION: the four small fields (phase 1B, entropyRevealed 1B,
    // swept 1B, targetDrandRound 8B = 11 bytes total) are grouped FIRST so
    // Solidity packs all four into ONE 32-byte storage slot, instead of
    // each being isolated in its own slot by the uint256 fields around it
    // (the previous declaration order interleaved them, wasting 2 whole
    // slots per round -- phase alone in slot 0, swept alone in the last
    // slot, each burning ~31 bytes of a slot nothing else could share).
    // This is a PURE storage-layout change: the field VALUES, types, and
    // every accessor (rounds(id).phase, .swept, etc.) are unchanged -- only
    // which slot each lives in. The auto-generated rounds() getter's
    // TUPLE ORDER changes to match this new declaration order, which is
    // why every hardcoded ABI string across the frontend/tests/scripts
    // that decodes rounds() was updated in the same change (see the git
    // log for the full list) -- ethers decodes tuple fields by the ABI's
    // declared order+names, so those call sites needed the new order, but
    // no code that reads decoded fields BY NAME (round.phase, round.pool,
    // etc.) needed to change at all.
    struct Round {
        Phase phase;
        bool entropyRevealed;
        bool swept;
        uint64 targetDrandRound;
        uint256 bettingEndsAt;
        uint256 lockBlock;
        uint256 trueCrashElapsedBlocks;
        uint256 crashElapsedBlocks;
        uint256 crashMultiplierBps;
        uint256 pool;
        uint256 distributable;
        uint256 totalWinningWeight;
        uint256 provisionalWinningWeight;
        uint256 registrationDeadlineBlock;
        uint256 rolledOverFromPrevious;
        // ── Phase 3 hardening (a)/(b)/(c) fields, appended so every
        //    pre-existing positional decoder of rounds() still lines up ──
        // (a) First unix second at which targetDrandRound's signature can
        //     exist ANYWHERE (= the beacon's own emission time for that
        //     round, genesis + (round-1)*period). Manual cash-out is valid
        //     strictly before it, regardless of on-chain reveal state.
        uint256 revealNotBefore;
        // (b) The Vault balance at lock -- the base of the single-payout cap.
        uint256 reserveAtLock;
        // (c) Who locked / revealed, so settleRound can pay their bounty.
        address lockedBy;
        address revealedBy;
        // Review HIGH-1 (seed farm): the Vault seed is distributed by PROFIT
        // weight stake*(mult-10000)/10000, not stake*mult, so an exit at ~1x
        // earns ~0 house money. These mirror provisionalWinningWeight /
        // totalWinningWeight for that second weight. Appended, same reason
        // as the fields above.
        uint256 provisionalProfitWeight;
        uint256 totalWinningProfitWeight;
    }

    uint256 public immutable bettingDurationSeconds;
    uint256 public immutable roundIntervalSeconds;
    uint256 public immutable genesisTimestamp;
    // Legacy deployment/config compatibility only. A production drand result
    // never expires, so this value MUST NOT authorize an outcome-dependent
    // void. See voidStaleRound(), which fails closed permanently.
    uint256 public immutable maxAwaitBlocks;
    uint256 public immutable maxElapsedBlocks;
    uint256 public immutable registrationWindowBlocks;
    uint256 public immutable rakeBps;
    uint256 public immutable minParticipants;
    uint256 public immutable minPoolSize;
    uint256 public immutable maxStakePerWalletBps;
    uint256 public immutable keeperRewardBps;
    // ── Hardening (c): funded keeper bounties. All three are bps OF THE
    //    RAKE (not of the pool), paid from the round's rake at settleRound
    //    via _asyncTransfer pull-payments -- never pushed. keeperRewardBps
    //    (settle) is REQUIRED > 0; reveal/lock bounties may be 0.
    uint256 public immutable keeperRevealBps;
    uint256 public immutable keeperLockBps;
    // ── Keeper liveness (anti-farm). The bps bounties above are the
    //    PERMISSIONLESS FALLBACK: rake-funded, so a manufactured round pays
    //    more rake than it collects (farm-proof by construction — no floor).
    //    An OPTIONAL designated-keeper gas floor closes the small-round
    //    liveness gap WITHOUT a farm: the floor is paid ONLY when the
    //    settling keeper == designatedKeeper (an address a coalition cannot
    //    control), from a bounded, owner-funded keeperSubsidyReserve, capped
    //    per epoch. designatedKeeper == address(0) => the floor is OFF and
    //    the contract is pure bps (the private-alpha / off-chain-reimburse
    //    posture). No registry, no governance — one immutable address.
    address public immutable designatedKeeper;
    uint256 public immutable keeperFloorWei;       // per-settle gas floor, top-up only
    uint256 public immutable keeperEpochBudgetWei; // max floor top-up per DRAWDOWN_WINDOW epoch
    uint256 public keeperSubsidyReserve;           // dedicated, owner-funded; NEVER reserve/pendingOverflow
    uint256 public keeperFloorPaidThisEpoch;       // resets each epoch window
    uint256 public keeperFloorEpochStart;
    event KeeperFloorPaid(uint256 indexed roundId, address indexed keeper, uint256 topUp, uint256 subsidyRemaining);
    event KeeperSubsidyFunded(uint256 amount, uint256 total);
    event KeeperSubsidyDepleted(uint256 indexed roundId, uint256 shortfall);
    // ── Hardening (b): deterministic bankroll caps, all in bytecode ──────
    // Hard ceiling on the per-round seed as a fraction of the Vault, in
    // ADDITION to seedNumerator/seedDenominator: seed <= reserve*seedMaxBps
    // /10000. Bounded above by SEED_MAX_BPS_CEILING (a constant), so no
    // deploy config can put more than a tenth of the bankroll into one
    // round -- 2x the spec's PROPOSED 500 bps, not 10x (review MED-3).
    uint256 public constant SEED_MAX_BPS_CEILING = 1000;
    uint256 public immutable seedMaxBps;
    // Single-payout cap: the HOUSE-SIDE portion (the Vault seed's share) of
    // any one player's payout in a round is capped at
    // reserveAtLock*singlePayoutCapBps/10000. The excess is credited back
    // to the Vault (pool conserved -- see claim()), not lost. The player-
    // funded portion of a payout is never capped: parimutuel player money
    // is not house exposure. This is a PER-WALLET UX bound ("no single
    // ticket wins more than X% of the bankroll"), NOT a sybil bound -- N
    // wallets get N caps. Neither is the fair-odds cap in _splitPayout
    // (review HIGH-1): it bounds each WINNER's house money, but a colluding
    // group recycles its losers' stakes through the player pot (re-review
    // NEW-1). The only sybil/collusion bound is the seed INCOME budget
    // below: house money paid out can never exceed house money earned.
    uint256 public immutable singlePayoutCapBps;
    // ── Re-review NEW-1: the seed is bounded by HOUSE INCOME ─────────────
    // In a parimutuel game the Vault seed is pure subsidy: whatever is paid
    // out of it is a transfer from the house to the field, and a colluding
    // field (an absorber that always wins the player pot plus N wallets
    // targeting a multiplier m, sized so their fair-odds profit covers the
    // seed) has EV/round = seed/m - rake*stakes > 0 for m above ~1.06 --
    // the fair-odds cap only bounds house money PER WINNER, and the losing
    // stakes go to the group's own absorber, not to the house. No per-
    // round cap fixes that; only a bound on the cumulative subsidy does.
    // seedBudget is that bound, in wei: it is credited with every round's
    // reserveCut -- the share of the net rake (rake minus keeper bounties)
    // that actually ENTERS the Vault; the treasury's share never does and
    // so can never be recycled (re-review NEW-5: crediting the whole net
    // rake let seeds be paid out of reserve capital the treasury had
    // already taken, and the Vault bled ~12-16% per 22 rounds down to the
    // HWM circuit floor) -- and debited by every seed drawn, so at all
    // times
    //   sum(seeds drawn) - sum(seeds returned) <= bootstrap + sum(reserveCut)
    // and a round's seed is <= seedBudget * SEED_INCOME_MULTIPLE_BPS/10000
    // on top of every other cap. At 10000 bps the house recycles at most
    // 100% of the rake the Vault retained: after the bootstrap the seed is
    // a rebate of rake the Vault took in, never a draw on its capital, so
    // under honest play the Vault can lose at most the bootstrap
    // (vaultNeverBleedsUnderHonestPlay), and a colluding group can at best
    // recover its own retained rake and can never net-extract house
    // capital beyond that bootstrap.
    // SEED_BOOTSTRAP: the constructor's seedBootstrapBudgetWei (<= reserveCap
    // /10 when capped) is the only allowance that exists before any rake
    // has been earned, so the first rounds can seed. PROPOSED values: spec
    // §6. Both are exercised by colludingAbsorberIsNotProfitable.
    uint256 public constant SEED_INCOME_MULTIPLE_BPS = 10000;
    uint256 public immutable seedBootstrapBudgetWei;
    uint256 public seedBudget;
    // Review MED-1: manual cash-outs close this many drand periods BEFORE
    // the target round's emission time, relative to the CHAIN clock. The
    // chain's block.timestamp can lag wall-clock (sequencer lag delta); the
    // margin absorbs delta < 2 periods, and _cashOut's isRoundAvailable belt
    // catches anything beyond it that has already been relayed on-chain.
    uint256 public constant CASHOUT_CLOSE_MARGIN_PERIODS = 2;
    // Daily-loss circuit: if, inside the current DRAWDOWN_WINDOW, the Vault
    // has fallen more than dailyDrawdownBps below that window's peak, the
    // next round seeds 0 (players-only parimutuel continues). The window
    // is a stepped 24h window keyed from the last roll, not a per-second
    // rolling buffer -- documented approximation, cheaper in gas.
    uint256 public constant DRAWDOWN_WINDOW = 24 hours;
    uint256 public immutable dailyDrawdownBps;
    // High-water-mark circuit: if the Vault is more than hwmDrawdownBps
    // below its all-time high (clamped to reserveCap when capped), seed 0
    // until refilled.
    uint256 public immutable hwmDrawdownBps;
    // Explicit maximum multiplier the game can ever pay, in bps. Realised
    // in whole blocks: maxMultiplierElapsedBlocks is the LARGEST elapsed
    // block count whose _multiplierAt does not exceed maxMultiplierBps, and
    // the effective crash elapsed is clamped to it (it is <= maxElapsedBlocks
    // by the constructor bound check). OWNER-SUPPLIED -- see spec §6.
    uint256 public immutable maxMultiplierBps;
    uint256 public immutable maxMultiplierElapsedBlocks;
    address public immutable treasury;
    uint256 public accumulatedRake;

    // ── Optional progression/leveling layer (see setProgression() and
    // PlankProgression.sol's own header for the full reasoning) ─────────
    address private immutable _deployer;
    IPlankProgression public progression; // address(0) == feature disabled, exact pre-existing behavior

    // ── The Vault: a perpetual, always-positive prize reserve ────────────
    uint256 public immutable seedNumerator;
    uint256 public immutable seedDenominator;
    uint256 public immutable reserveShareBps;
    uint256 public immutable reserveFloorWei;
    uint256 public immutable reserveCap;
    address public immutable jackpotSink;

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
    // cashOut's revealNotBefore gate is derived from the same beacon
    // schedule the target was picked against). Arbitrum-
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
    bytes32 public constant RESULT_DOMAIN = keccak256("PLANKCRASH_RESULT_V1");

    uint256 public currentRoundId;
    // THE VAULT -- a perpetual, always-positive prize reserve that seeds
    // every game and can never be emptied. It is fed by three streams:
    //   (1) a share (reserveShareBps) of every round's rake -- the steady
    //       compounding engine, so it grows on winning rounds too;
    //   (2) the ENTIRE pot of every fully-busted round (nobody cashed out,
    //       so nobody can ever claim it) -- windfall jumps;
    //   (3) any direct donation via fundVault() -- sponsors/dev priming.
    // Each new round is seeded with only a STRICT FRACTION of it
    // (seed = floor(reserve * seedNumerator/seedDenominator), num < den),
    // so a draw multiplies the balance by (den-num)/den > 0 and the Vault
    // is mathematically incapable of reaching zero or negative: no amount
    // of player winning can ever make the forward carry <= 0, because
    // winners are paid from the round pool, never from the Vault, and the
    // Vault's ONLY outflow is that fractional seed. See _seedFromReserve().
    uint256 public reserve;
        // reserve. Skimmed synchronously in _creditReserve the instant reserve
    // would exceed reserveCap; inert to seeding / drawdown / hwm /
    // reserveAtLock; moved ONLY by deliverOverflow(). ──────────────────────
    uint256 public pendingOverflow;
    // §8.5: bounded gas forwarded to the sink's fund() — PROPOSED ~100k.
    uint256 public constant SINK_GAS_STIPEND = 100_000;
    // Hardening (b) circuit state. reserveHighWaterMark is the all-time
    // high of `reserve`; drawdownWindowPeak is the high inside the current
    // DRAWDOWN_WINDOW that started at drawdownWindowStart.
    uint256 public reserveHighWaterMark;
    uint256 public drawdownWindowStart;
    uint256 public drawdownWindowPeak;
    mapping(uint256 => Round) public rounds;
    mapping(uint64 => uint256) public drandRoundToRoundId;
    mapping(uint256 => mapping(address => uint256)) public stakeOf;
    // MANUAL cash-out block only (0 = no manual cash-out). The EFFECTIVE
    // cash-out block used for settlement is effectiveCashOutBlock(), the
    // earlier of this and the auto target committed at bet time.
    mapping(uint256 => mapping(address => uint256)) public cashOutBlockOf;
    // Hardening (a): the auto-cash-out target committed WITH the bet, in
    // multiplier bps (0 = manual play only). Immutable per (round, player):
    // there is no setter, a second placeBet in the same round reverts
    // AlreadyBet, and carryForwardStake copies it verbatim into the new
    // round (a carried stake keeps its commitment -- it cannot be re-chosen
    // with any more information than it was originally chosen with).
    mapping(uint256 => mapping(address => uint256)) public autoCashOutBps;
    mapping(uint256 => mapping(address => bool)) public registered;
    mapping(uint256 => mapping(address => bool)) public claimed;
    mapping(uint256 => mapping(address => uint256)) private _weightOf;
    // HIGH-1: the winner's PROFIT weight stake*(mult-1), the seed's key.
    mapping(uint256 => mapping(address => uint256)) private _profitWeightOf;
    mapping(uint256 => uint256) public participantCount;
    mapping(uint256 => bool) public voided;
    // The largest single stake placed in a round so far -- tracked so
    // lockRound() can enforce the whale cap against the FINAL pool at lock
    // time, order-independent. Real bug this closes: the per-bet cap check
    // (`r.pool != 0 && ...`) is a no-op for whoever bets FIRST in a round
    // with no seed, since poolAfter == their own stake makes the ratio
    // check vacuous -- anyone willing to be first (trivial; no MEV needed)
    // could stake an unbounded amount, defeating the cap's entire purpose
    // of preventing single-wallet domination. This retroactive check
    // catches it regardless of bet order: if the final pool's largest
    // single stake still exceeds maxStakePerWalletBps of the final pool,
    // the round voids exactly like under-threshold (stakes carry forward
    // via carryForwardStake, nothing lost, no rake taken).
    mapping(uint256 => uint256) public largestStakeInRound;

    // ── Bank / on-behalf integration (additive; the self-serve paths above
    //    are untouched) ──────────────────────────────────────────────────
    //
    // `placeBetFor` lets an escrow contract (PlankBank) fund a bet for a
    // player so the player never signs per-bet -- the stake is still
    // attributed to the PLAYER for pari-mutuel weight, exactly as a
    // self-placed bet. betFundedBy records who funded it so ONLY that
    // funder can drive an on-behalf cash-out (nobody else can cash a
    // player out early against their will).
    mapping(uint256 => mapping(address => address)) public betFundedBy;
    // A player may opt in to have their winnings pushed to a sink (their
    // bank) instead of the pull-escrow, so wins recycle into the play
    // buffer with no extra signature. Opt-in and self-set only, so a bad
    // sink can only ever harm the player who chose it -- and even then the
    // push falls back to normal escrow on failure, so funds are never
    // stuck. See claim().
    mapping(address => address) public payoutRedirect;
    mapping(uint256 => mapping(address => bool)) public carriedForward;

    event RoundStarted(uint256 indexed roundId, uint256 bettingEndsAt);
    event RoundEnvelopeCommitted(
        uint256 indexed roundId,
        uint256 bettingEndsAt,
        uint64 targetDrandRound,
        uint256 revealNotBefore
    );
    event BetPlaced(uint256 indexed roundId, address indexed player, uint256 amount);
    event RoundLocked(uint256 indexed roundId, uint256 lockBlock, uint64 targetDrandRound);
    event RoundVoided(uint256 indexed roundId, uint256 rolledOverPool, string reason);
    event CashedOut(uint256 indexed roundId, address indexed player, uint256 atBlock, bool preset);
    event AutoCashOutCommitted(uint256 indexed roundId, address indexed player, uint256 targetBps, uint256 targetElapsedBlocks);
    event PayoutCapped(uint256 indexed roundId, address indexed player, uint256 uncappedShare, uint256 paid, uint256 excessToVault);
    event SeedHalted(uint256 indexed roundId, uint8 reason, uint256 reserveNow);
    event KeeperRewarded(uint256 indexed roundId, address indexed keeper, uint8 kind, uint256 amount);
    event EntropyRevealed(uint256 indexed roundId, uint256 trueCrashMultiplierBps, uint256 trueCrashElapsedBlocks);
    event RoundCrashed(uint256 indexed roundId, uint256 crashMultiplierBps, uint256 crashElapsedBlocks, bool cappedByMax);
    event ResultRegistered(uint256 indexed roundId, address indexed player, bool won, uint256 weight);
    event Claimed(uint256 indexed roundId, address indexed player, uint256 payout);
    event PoolRolledOver(uint256 indexed fromRoundId, uint256 amount);
    event VaultSeeded(uint256 indexed roundId, uint256 seed, uint256 reserveAfter);
    event VaultFunded(address indexed from, uint256 amount, uint256 reserveAfter);
    event VaultGrew(uint256 indexed roundId, uint256 fromRake, uint256 reserveAfter);
    event VaultOverflow(uint256 spilledToJackpot, uint256 reserveAfter);
        // remaining, so an indexer can reconstruct the overflow lifecycle. ─────
    event OverflowQueued(uint256 attempted, uint256 queued, uint256 pendingTotal);
    event OverflowDelivered(uint256 attempted, uint256 delivered, uint256 restored, uint256 remaining);
    event OverflowDeliveryFailed(uint256 attempted, uint256 delivered, uint256 restored, uint256 remaining);

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
    error TargetUnreachable();
    /// @dev Hardening (a): block.timestamp >= revealNotBefore -- the target drand round's signature can exist somewhere, so no cash-out may be chosen any more, revealed or not.
    error CashOutWindowClosed();
    error BadAutoTarget();
    error KeeperRewardRequired();
    error BadHardeningConfig();
    error BadMaxMultiplier();
    error RandomnessNotYetAvailable();
    error ZeroBeacon();
    error RoundIntervalTooShort();
    error RoundHasWinners();
    error AlreadySwept();
    error ZeroPlayer();
    error NotFunder();
    error BadVaultConfig();
    error NothingToFund();
    error ProgressionAlreadySet();
    error NotDeployer();
    error ProductionRoundCannotVoid();

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
        // ── The Vault (perpetual, never-zero prize reserve) ──────────────
        // Each new round is seeded with a STRICT FRACTION of the Vault:
        //   seed = floor(reserve * seedNumerator / seedDenominator)
        // With seedNumerator < seedDenominator the Vault is multiplied by
        // (den-num)/den > 0 on every draw, so it is arithmetically
        // impossible for it to reach zero or go negative -- no sequence of
        // player wins can ever empty the forward carry. See _seedFromReserve.
        uint256 seedNumerator;
        uint256 seedDenominator;
        // Share (bps) of each round's NET rake that compounds back into the
        // Vault instead of going to the treasury -- the growth engine.
        uint256 reserveShareBps;
        // Optional hard floor: the Vault is never drawn below this many wei
        // (0 = pure geometric floor, which is already strictly positive).
        uint256 reserveFloorWei;
        // ── Cascade: unify the Vault with the Powerboard jackpot ─────────
        // Once the Vault exceeds reserveCap, the overflow spills into the
        // jackpotSink (the Powerboard), so the crash's compounding growth
        // feeds the daily lottery once the intra-round pot is "full".
        //   reserveCap == 0  -> uncapped, never spills (Vault only).
        //   jackpotSink == 0 -> cascade disabled (standalone crash).
        uint256 reserveCap;
        address jackpotSink;
        // ── Phase 3 hardening (spec docs/marketplank/SPEC-CRASH-GO-LIVE-
        //    HARDENING.md). Values are PROPOSED there, NOT ratified. ─────
        uint256 keeperRevealBps; // (c) bps of rake to whoever revealEntropy()'d
        uint256 keeperLockBps; // (c) bps of rake to whoever lockRound()'d
        // Keeper liveness floor (all OPTIONAL; designatedKeeper==0 => OFF, pure bps):
        address designatedKeeper;       // the only address the gas floor pays; 0 = off
        uint256 keeperFloorWei;         // per-settle gas-floor top-up
        uint256 keeperEpochBudgetWei;   // per-epoch cap on floor top-ups
        uint256 seedMaxBps; // (b) 0 < x <= SEED_MAX_BPS_CEILING
        uint256 singlePayoutCapBps; // (b) 0 < x <= 10000, of reserveAtLock
        uint256 dailyDrawdownBps; // (b) 0 < x <= 10000 (10000 = never trips)
        uint256 hwmDrawdownBps; // (b) 0 < x <= 10000 (10000 = never trips)
        uint256 maxMultiplierBps; // (b) 10000 < x <= _multiplierAt(maxElapsedBlocks)
        // Re-review NEW-1: initial seed-income budget, wei. <= reserveCap/10
        // when the Vault is capped (an uncapped Vault leaves it to the
        // owner; deploy-casino.ts pins it to reserveCap/10 -- PROPOSED).
        uint256 seedBootstrapBudgetWei;
    }

    constructor(Config memory cfg) {
        // Captured automatically as the constructor's own caller -- NOT a
        // constructor parameter, so this required zero changes to any
        // existing test or deploy script's call site. Used exactly once,
        // by setProgression() below, to wire up an entirely optional
        // feature; never checked again after that single call succeeds.
        // Not an ongoing owner/admin role -- there is no function anywhere
        // in this contract this address can call more than once, and none
        // of them touch funds, odds, or outcomes.
        _deployer = msg.sender;
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
        if (cfg.rakeBps > 10000 || cfg.keeperRewardBps > 10000 || cfg.maxStakePerWalletBps > 10000) {
            revert BadVaultConfig();
        }
        rakeBps = cfg.rakeBps;
        minParticipants = cfg.minParticipants;
        minPoolSize = cfg.minPoolSize;
        maxStakePerWalletBps = cfg.maxStakePerWalletBps;
        // Hardening (c): liveness is paid for. A zero settle bounty is the
        // documented root cause of "nobody settles" (spec §0/§3). A zero
        // rake makes every bounty (bps OF THE RAKE) zero too, so it is
        // rejected by the same rule (review LOW-2).
        if (cfg.keeperRewardBps == 0 || cfg.rakeBps == 0) revert KeeperRewardRequired();
        if (cfg.keeperRewardBps + cfg.keeperRevealBps + cfg.keeperLockBps > 10000) revert BadHardeningConfig();
        keeperRewardBps = cfg.keeperRewardBps;
        keeperRevealBps = cfg.keeperRevealBps;
        keeperLockBps = cfg.keeperLockBps;
        // Keeper liveness floor wiring. When OFF (designatedKeeper==0), the floor
        // params must be 0 too (no dormant surface). When ON, the floor is bounded
        // by the epoch budget and paid only to the designated keeper from the
        // separately-funded keeperSubsidyReserve.
        designatedKeeper = cfg.designatedKeeper;
        if (cfg.designatedKeeper == address(0)) {
            if (cfg.keeperFloorWei != 0 || cfg.keeperEpochBudgetWei != 0) revert BadHardeningConfig();
        }
        keeperFloorWei = cfg.keeperFloorWei;
        keeperEpochBudgetWei = cfg.keeperEpochBudgetWei;
        treasury = cfg.treasury;

        // Hardening (b): every cap is a bounded immutable.
        if (cfg.seedMaxBps == 0 || cfg.seedMaxBps > SEED_MAX_BPS_CEILING) revert BadHardeningConfig();
        if (cfg.singlePayoutCapBps == 0 || cfg.singlePayoutCapBps > 10000) revert BadHardeningConfig();
        if (cfg.dailyDrawdownBps == 0 || cfg.dailyDrawdownBps > 10000) revert BadHardeningConfig();
        if (cfg.hwmDrawdownBps == 0 || cfg.hwmDrawdownBps > 10000) revert BadHardeningConfig();
        seedMaxBps = cfg.seedMaxBps;
        singlePayoutCapBps = cfg.singlePayoutCapBps;
        dailyDrawdownBps = cfg.dailyDrawdownBps;
        hwmDrawdownBps = cfg.hwmDrawdownBps;
        // The max multiplier must be a real, reachable ceiling: strictly
        // above 1.00x and no higher than the block cap already allows.
        if (cfg.maxMultiplierBps <= 10000 || cfg.maxMultiplierBps > _multiplierAt(cfg.maxElapsedBlocks)) {
            revert BadMaxMultiplier();
        }
        maxMultiplierBps = cfg.maxMultiplierBps;
        uint256 capElapsed = _invertMultiplier(cfg.maxMultiplierBps); // smallest e with mult(e) >= cap
        if (_multiplierAt(capElapsed) > cfg.maxMultiplierBps) capElapsed -= 1; // largest e with mult(e) <= cap
        maxMultiplierElapsedBlocks = capElapsed;
        drawdownWindowStart = block.timestamp;

        // Vault: the seed fraction MUST be a proper fraction (0 < num < den)
        // -- this is exactly what guarantees the reserve can never be drawn
        // to zero. A share of 100% is allowed (den==num would zero it, so is
        // rejected); reserveShareBps is a normal 0..10000 rake share.
        if (cfg.seedDenominator == 0 || cfg.seedNumerator == 0 || cfg.seedNumerator >= cfg.seedDenominator) {
            revert BadVaultConfig();
        }
        if (cfg.reserveShareBps > 10000) revert BadVaultConfig();
        if (cfg.reserveCap != 0 && cfg.reserveCap < cfg.reserveFloorWei) revert BadVaultConfig();
        if (cfg.jackpotSink != address(0) && cfg.jackpotSink.code.length == 0) revert BadVaultConfig();
        seedNumerator = cfg.seedNumerator;
        seedDenominator = cfg.seedDenominator;
        reserveShareBps = cfg.reserveShareBps;
        reserveFloorWei = cfg.reserveFloorWei;
        reserveCap = cfg.reserveCap;
        jackpotSink = cfg.jackpotSink;
        // NEW-1: the bootstrap seed budget is bounded by the (now validated)
        // bankroll cap; an uncapped Vault leaves it to the owner (spec §6).
        if (cfg.reserveCap != 0 && cfg.seedBootstrapBudgetWei > cfg.reserveCap / 10) revert BadHardeningConfig();
        seedBootstrapBudgetWei = cfg.seedBootstrapBudgetWei;
        seedBudget = cfg.seedBootstrapBudgetWei;

        _startRound();
    }

    /// Wires this contract to a deployed PlankProgression, EXACTLY once.
    /// Deliberately not a constructor parameter: PlankProgression's own
    /// constructor needs THIS contract's address up front (it gates
    /// recordBet to only its wired crash address), so either this contract
    /// or that one has to exist first -- this is the "deploy the dependent
    /// contract, then wire it up" side of that cycle, the same two-step
    /// shape any circular on-chain dependency needs somewhere. Restricted
    /// to the address that deployed THIS contract (see _deployer's own
    /// comment: captured automatically, not a stored owner/admin role) so
    /// a front-runner can't grief a legitimate deploy by wiring in a
    /// garbage address first and permanently bricking placeBet() against
    /// calls that would revert on it.
    function setProgression(address progression_) external {
        if (msg.sender != _deployer) revert NotDeployer();
        if (address(progression) != address(0)) revert ProgressionAlreadySet();
        progression = IPlankProgression(progression_);
    }

    // ── Round lifecycle ──────────────────────────────────────────────────

    function _nextSlot() private view returns (uint256) {
        uint256 elapsed = block.timestamp - genesisTimestamp;
        uint256 k = (elapsed / roundIntervalSeconds) + 1;
        return genesisTimestamp + k * roundIntervalSeconds;
    }

    function _startRound() private {
        currentRoundId += 1;
        Round storage r = rounds[currentRoundId];
        r.phase = Phase.BETTING;
        r.bettingEndsAt = (currentRoundId == 1 || roundIntervalSeconds == 0)
            ? block.timestamp + bettingDurationSeconds
            : _nextSlot();
        // Bind the randomness envelope before any stake is visible. A keeper
        // cannot select a target after observing the field.
        r.targetDrandRound =
            beacon.nextRoundAfter(r.bettingEndsAt) +
            uint64(TARGET_ROUND_SAFETY_PERIODS);
        uint256 period = beacon.period();
        r.revealNotBefore =
            beacon.genesisTimestamp() +
            (uint256(r.targetDrandRound) - 1) * period -
            CASHOUT_CLOSE_MARGIN_PERIODS * period;
        if (drandRoundToRoundId[r.targetDrandRound] != 0) revert BadHardeningConfig();
        drandRoundToRoundId[r.targetDrandRound] = currentRoundId;
        // Seed the new pot with a STRICT FRACTION of the Vault. Tracked in
        // rolledOverFromPrevious so a void returns exactly this seed to the
        // Vault (see _rescueSeed) -- the seed has no owning player.
        uint256 seeded = _seedFromReserve();
        r.pool = seeded;
        r.rolledOverFromPrevious = seeded;
        emit RoundStarted(currentRoundId, r.bettingEndsAt);
        emit RoundEnvelopeCommitted(
            currentRoundId,
            r.bettingEndsAt,
            r.targetDrandRound,
            r.revealNotBefore
        );
        if (seeded > 0) emit VaultSeeded(currentRoundId, seeded, reserve);
    }

    /// Draws the seed for the next round out of the Vault and returns it,
    /// updating `reserve`. THE non-negativity guarantee lives here:
    ///   seed = floor(reserve * seedNumerator / seedDenominator)
    /// With seedNumerator < seedDenominator, integer division gives
    /// seed <= reserve*num/den < reserve for any reserve >= 1, so
    /// `reserve - seed` is strictly positive. The optional floor only makes
    /// the guarantee stronger (reserve >= reserveFloorWei). This is the ONLY
    /// place the Vault is ever debited.
    /// Hardening (b) circuits are applied here too: seedMaxBps is a hard
    /// ceiling on the fraction, and either drawdown circuit forces seed=0
    /// (the game continues players-only; the house just stops subsidising).
    function _seedFromReserve() private returns (uint256 seed) {
        _rollDrawdownWindow();
        uint8 halt = _seedHaltReason();
        if (halt != 0) {
            emit SeedHalted(currentRoundId, halt, reserve);
            return 0;
        }
        seed = _computeSeed();
        // reserve - seed > 0 always (seed < reserve), so the Vault survives.
        if (seed > 0) {
            reserve -= seed;
            // NEW-1: seed <= budget*multiple/10000 by _computeSeed; the debit
            // saturates so a multiple > 10000 could never underflow here.
            uint256 b = seedBudget;
            seedBudget = seed >= b ? 0 : b - seed;
        }
    }

    /// Pure seed formula (no circuits): min(num/den, seedMaxBps) of the
    /// Vault, then the NEW-1 income budget, clamped to the optional floor.
    function _computeSeed() private view returns (uint256 seed) {
        uint256 avail = reserve;
        if (avail == 0) return 0;
        if (reserveFloorWei > 0 && avail <= reserveFloorWei) return 0; // preserve the floor
        seed = (avail * seedNumerator) / seedDenominator; // floor, strictly < avail
        uint256 bpsCap = (avail * seedMaxBps) / 10000; // hardening (b).1: bytecode ceiling
        if (seed > bpsCap) seed = bpsCap;
        uint256 incomeCap = (seedBudget * SEED_INCOME_MULTIPLE_BPS) / 10000; // NEW-1: house-income bound
        if (seed > incomeCap) seed = incomeCap;
        if (reserveFloorWei > 0) {
            uint256 maxDraw = avail - reserveFloorWei;
            if (seed > maxDraw) seed = maxDraw;
        }
    }

    /// Steps the daily-loss window forward once it has expired. Review
    /// MED-2: the new window's peak is NOT simply the (possibly depleted)
    /// current balance -- that let a losing streak straddling a window
    /// boundary spend ~2x dailyDrawdownBps in 24h. Instead the previous
    /// peak DECAYS by exactly the allowed drawdown per elapsed window,
    /// floored at the current balance:
    ///   newPeak = max(reserve, prevPeak * (10000 - dailyDrawdownBps)/10000)
    /// applied once per elapsed window, so the subsidy budget released per
    /// 24h is dailyDrawdownBps of the running peak, never more, however the
    /// losses line up against the boundary. Windows stay aligned to the
    /// original start (start += n*WINDOW), not re-based on the call time.
    function _rollDrawdownWindow() private {
        (uint256 start, uint256 peak, bool rolled) = _rolledWindow();
        if (rolled) {
            drawdownWindowStart = start;
            drawdownWindowPeak = peak;
        }
    }

    /// Pure mirror of the roll _rollDrawdownWindow would make right now:
    /// (windowStart, windowPeak, rolled). The decay loop is bounded by the
    /// number of elapsed windows AND stops once the peak has decayed to the
    /// balance (further decay is a no-op under the max), so a very long
    /// idle gap costs at most a few dozen cheap iterations.
    function _rolledWindow() private view returns (uint256 start, uint256 peak, bool rolled) {
        start = drawdownWindowStart;
        peak = drawdownWindowPeak;
        if (block.timestamp < start + DRAWDOWN_WINDOW) return (start, peak, false);
        uint256 n = (block.timestamp - start) / DRAWDOWN_WINDOW;
        start += n * DRAWDOWN_WINDOW;
        uint256 bal = reserve;
        uint256 keepBps = 10000 - dailyDrawdownBps;
        while (n > 0 && peak > bal) {
            peak = (peak * keepBps) / 10000;
            unchecked {
                --n;
            }
        }
        if (peak < bal) peak = bal;
        rolled = true;
    }

    /// 0 = seeding allowed; 1 = daily-loss circuit tripped; 2 = high-water-
    /// mark circuit tripped. Evaluated against the window as it WILL be
    /// after the roll _seedFromReserve makes first (see _rolledWindow), so
    /// the view mirror and the real draw always agree.
    function _seedHaltReason() private view returns (uint8) {
        uint256 bal = reserve;
        (, uint256 peak, ) = _rolledWindow();
        if (peak > bal && (peak - bal) * 10000 > peak * dailyDrawdownBps) return 1;
        uint256 hwm = reserveHighWaterMark;
        if (reserveCap != 0 && hwm > reserveCap) hwm = reserveCap; // a capped Vault can never sit above its cap
        if (hwm > 0 && bal * 10000 < hwm * (10000 - hwmDrawdownBps)) return 2;
        return 0;
    }

    /// View mirror of the circuit check the NEXT seed draw will make.
    function seedHaltReason() public view returns (uint8) {
        return _seedHaltReason();
    }

    /// The ONLY place the Vault is ever credited. Keeps both circuit peaks
    /// current so a refill lifts the HWM/window peak exactly like the spec's
    /// "until refilled".
    function _creditReserve(uint256 amount) private {
        _creditReserve(amount, true);
    }

    /// `raisesWindowPeak == false` for credits that merely RETURN house
    /// money the Vault already counted (a voided round's rescued seed, a
    /// capped payout's excess): review MED-2 -- such a return is not new
    /// capital and must not lift the daily-loss window's peak, or every
    /// seed-then-rescue cycle would re-arm the daily budget. The all-time
    /// HWM is unaffected either way (a return can never exceed the level
    /// the money was drawn from).
    function _creditReserve(uint256 amount, bool raisesWindowPeak) private {
        uint256 bal = reserve + amount;
                // pendingOverflow BEFORE it can touch the window peak / hwm. The
        // reserve is capped synchronously; the excess is earmarked lottery
        // money, not house risk capital. Pure state change, no external call.
        uint256 cap = reserveCap;
        if (cap != 0 && bal > cap) {
            uint256 excess = bal - cap;
            pendingOverflow += excess;
            bal = cap;
            emit OverflowQueued(excess, excess, pendingOverflow);
        }
        reserve = bal;
        if (bal > reserveHighWaterMark) reserveHighWaterMark = bal; // bal <= cap ⇒ hwm <= cap
        if (raisesWindowPeak && bal > drawdownWindowPeak) drawdownWindowPeak = bal; // peak <= cap
    }

    /// What the NEXT round will be seeded with, given the Vault right now --
    /// a pure mirror of _seedFromReserve (circuits included) for the UI
    /// ("next game starts with X already in the pot; the Vault holds Y").
    function nextSeed() external view returns (uint256 seed) {
        if (_seedHaltReason() != 0) return 0;
        return _computeSeed();
    }

    /// Anyone can grow the Vault directly -- dev priming, a sponsor boosting
    /// the progressive pot, or a well-wisher. It only ever seeds future
    /// player pots (never dev revenue), and only a fraction is released per
    /// round, so a donation compounds across many games.
    ///
    /// nonReentrant matters here specifically because of _spillOverflow's
    /// own external call: it computes `excess = reserve - cap` BEFORE
    /// calling out, then unconditionally sets `reserve = cap` on success --
    /// correct against a single top-level call, but a nested reentrant call
    /// (e.g. via placeBet/settleRound/sweepBustedRound, which also touch
    /// `reserve` and are themselves nonReentrant, sharing this same guard)
    /// could otherwise add to `reserve` mid-call only to have it clobbered
    /// by the outer call's unconditional `reserve = cap` once its own
    /// external call returns -- an accounting bug (ETH still physically in
    /// the contract, but silently dropped out of the Vault's bookkeeping),
    /// not a theft, but a real integrity gap this guard closes outright.
    function fundVault() external payable nonReentrant {
        if (msg.value == 0) revert NothingToFund();
        _creditReserve(msg.value);
        emit VaultFunded(msg.sender, msg.value, reserve);
    }

    /// Fund the dedicated keeper-subsidy reserve (the designated-keeper gas floor).
    /// Permissionless to fund (anyone may top it up); it is spent ONLY on the floor
    /// top-up to the designated keeper. NEVER mixed with `reserve` or `pendingOverflow`,
    /// so a subsidy payout can never touch house risk capital, seeding, or drawdown.
    function fundKeeperSubsidy() external payable {
        if (msg.value == 0) revert NothingToFund();
        keeperSubsidyReserve += msg.value;
        emit KeeperSubsidyFunded(msg.value, keeperSubsidyReserve);
    }

        /// delivery of the earmarked overflow to the Powerboard sink. The ONLY
    /// external call in the whole overflow path. CEI: debit before the call,
    /// restore EXACTLY on failure. Bounded gas (SINK_GAS_STIPEND). Success or
    /// failure moves ONLY pendingOverflow — never reserve / peak / hwm.
    function deliverOverflow() external nonReentrant returns (bool ok) {
        uint256 amount = pendingOverflow;
        address sink = jackpotSink;
        if (amount == 0 || sink == address(0)) return false;
        pendingOverflow = 0; // EFFECT: debit BEFORE the interaction
        (ok, ) = sink.call{value: amount, gas: SINK_GAS_STIPEND}(abi.encodeWithSignature("fund()"));
        if (ok) {
            emit OverflowDelivered(amount, amount, 0, pendingOverflow);
        } else {
            pendingOverflow = amount; // restore EXACTLY for retry
            emit OverflowDeliveryFailed(amount, 0, amount, pendingOverflow);
        }
    }

    /// Real bug this fixes: the wallet cap used to be checked against the
    /// RAW pool (r.pool), which includes the Vault's free seed
    /// (rolledOverFromPrevious) -- a house-funded bonus, not another
    /// player's money. Once the Vault ran thin (a small/depleted reserve,
    /// e.g. after many rounds' worth of 1/8 draws with little fresh
    /// funding), a round could be seeded with only a few thousandths of an
    /// ETH, and the RATIO check would then reject even the smallest
    /// ordinary bet as "dominating" that tiny seed -- making it impossible
    /// to place ANY bet at all on a thin-Vault round. The cap's real
    /// purpose is preventing one wallet from dominating OTHER PLAYERS'
    /// stakes, so it's now measured against player-contributed pool only
    /// (pool minus the seed), which also correctly keeps exempting
    /// whoever bets first (playerPoolBefore is 0 for them regardless of
    /// how big the seed is, same as before).
    function _checkStakeCap(Round storage r, uint256 poolBefore, uint256 stakeAmount) private view {
        uint256 seed = r.rolledOverFromPrevious;
        uint256 playerPoolBefore = poolBefore > seed ? poolBefore - seed : 0;
        uint256 playerPoolAfter = playerPoolBefore + stakeAmount;
        if (playerPoolBefore != 0 && stakeAmount * 10000 > playerPoolAfter * maxStakePerWalletBps) {
            revert StakeExceedsCap();
        }
    }

    /// Applies the optional progression layer to a fresh bet of `grossStake`
    /// wei from `player`: enforces the rank-based absolute cap (in ADDITION
    /// to _checkStakeCap's own pool-relative 60% rule -- the caller checks
    /// that separately, against the NET amount this returns), skims any
    /// rank-based entry premium straight into the Vault (never counted
    /// toward the payer's own pari-mutuel weight -- see
    /// PlankProgression.sol's header for why this exists and what it's
    /// actually defending against), and records the bet for progression
    /// purposes. A pure no-op returning grossStake unchanged when
    /// progression is unset (address(0)): every existing round of behavior
    /// is preserved exactly when this optional feature was never wired up.
    function _applyProgression(address player, uint256 grossStake) private returns (uint256 netStake) {
        IPlankProgression p = progression;
        if (address(p) == address(0)) return grossStake;

        if (grossStake > p.capFor(player)) revert StakeExceedsCap();

        uint256 premiumBps = p.premiumBpsFor(player, grossStake);
        uint256 premium = (grossStake * premiumBps) / 10000;
        netStake = grossStake - premium;

        if (premium > 0) {
            _creditReserve(premium);
            emit VaultFunded(player, premium, reserve);
        }
        p.recordBet(player, grossStake);
    }

    /// Hardening (a): the auto-cash-out target is a REQUIRED part of the
    /// bet (0 = manual play only). It is committed here, before lock, before
    /// the target drand round is even chosen, and can never be changed for
    /// this (round, player): presetCashOut is gone. Settlement uses the
    /// EARLIER of this target and any manual cashOut() -- the committed
    /// target is a ceiling the player cannot raise after the fact.
    function placeBet(uint256 autoCashOutBps_) external payable nonReentrant {
        Round storage r = rounds[currentRoundId];
        if (r.phase != Phase.BETTING) revert BadPhase();
        if (block.timestamp >= r.bettingEndsAt) revert TooLate();
        if (stakeOf[currentRoundId][msg.sender] != 0) revert AlreadyBet();

        uint256 stakeAmount = _applyProgression(msg.sender, msg.value);
        _enterRound(r, currentRoundId, msg.sender, stakeAmount, autoCashOutBps_);
    }

    /// Shared bet-recording tail for placeBet / placeBetFor / carryForward.
    function _enterRound(Round storage r, uint256 id, address player, uint256 stakeAmount, uint256 auto_) private {
        _checkStakeCap(r, r.pool, stakeAmount);
        uint256 poolAfter = r.pool + stakeAmount;

        stakeOf[id][player] = stakeAmount;
        r.pool = poolAfter;
        participantCount[id] += 1;
        if (stakeAmount > largestStakeInRound[id]) largestStakeInRound[id] = stakeAmount;
        emit BetPlaced(id, player, stakeAmount);
        _commitAutoCashOut(r, id, player, stakeAmount, auto_);
    }

    /// Records the auto target and its provisional winning weight. Bounded
    /// to (1.00x, maxMultiplierBps] -- strictly above 1.00x (NEW-1) -- and
    /// to a block offset the capped crash can actually reach, so a
    /// committed target is always settleable.
    function _commitAutoCashOut(Round storage r, uint256 id, address player, uint256 stakeAmount, uint256 auto_) private {
        if (auto_ == 0) return;
        // NEW-1 (b): exactly 1.00x inverts to elapsed 0 -- a bet that wins
        // with P = 1 and takes the whole player pot whenever anyone else
        // loses: the colluding group's riskless absorber. Every committed
        // target must take >= 1 block of crash risk.
        if (auto_ <= 10000 || auto_ > maxMultiplierBps) revert BadAutoTarget();
        uint256 targetElapsed = _invertMultiplier(auto_);
        if (targetElapsed == 0) revert BadAutoTarget();
        if (targetElapsed > maxMultiplierElapsedBlocks) revert TargetUnreachable();
        autoCashOutBps[id][player] = auto_;
        (uint256 w, uint256 pw) = _weightsAt(stakeAmount, targetElapsed);
        r.provisionalWinningWeight += w;
        r.provisionalProfitWeight += pw;
        emit AutoCashOutCommitted(id, player, auto_, targetElapsed);
    }

    /// Places a bet FOR `player`, funded by msg.value (the caller supplies
    /// the ETH). The stake is attributed to `player` for pari-mutuel weight
    /// exactly as if they had called placeBet themselves; the only
    /// difference is who signed and who paid. Used by PlankBank to let a
    /// depositor play from their pre-funded balance without signing each
    /// bet. Records the funder so cashOutFor is restricted to them.
    function placeBetFor(address player, uint256 autoCashOutBps_) external payable nonReentrant {
        if (player == address(0)) revert ZeroPlayer();
        Round storage r = rounds[currentRoundId];
        if (r.phase != Phase.BETTING) revert BadPhase();
        if (block.timestamp >= r.bettingEndsAt) revert TooLate();
        if (stakeOf[currentRoundId][player] != 0) revert AlreadyBet();

        // Progression tracks PLAYER, not msg.sender -- the Bank is a
        // regular caller here funding on the player's behalf, same as any
        // other funder; rank belongs to whoever the stake (and the risk)
        // actually belongs to.
        uint256 stakeAmount = _applyProgression(player, msg.value);
        betFundedBy[currentRoundId][player] = msg.sender;
        _enterRound(r, currentRoundId, player, stakeAmount, autoCashOutBps_);
    }

    /// Cash out on `player`'s behalf. Restricted to the address that funded
    /// the bet via placeBetFor -- i.e. the bank the player deposited into,
    /// which enforces the player's own session-key authorization before
    /// calling this. No one else can force a player's early cash-out.
    /// @dev Carries the same CashOutWindowClosed gate as cashOut() below -- see that function's own comment for the full rationale. A funder is exactly as capable of exploiting the pre-reveal information asymmetry as the player themself would be.
    function cashOutFor(uint256 roundId, address player) external nonReentrant {
        if (betFundedBy[roundId][player] != msg.sender) revert NotFunder();
        _cashOut(roundId, player);
    }

    /// Opt in (or out, with address(0)) to have future winnings pushed to
    /// `sink` instead of held in the pull-escrow. Self-set only.
    function setPayoutRedirect(address sink) external {
        payoutRedirect[msg.sender] = sink;
    }

    function carryForwardStake(uint256 fromRoundId) external nonReentrant {
        if (!voided[fromRoundId]) revert BadPhase();
        if (carriedForward[fromRoundId][msg.sender]) revert AlreadyClaimed();
        uint256 amount = stakeOf[fromRoundId][msg.sender];
        if (amount == 0) revert NoBet();

        Round storage cur = rounds[currentRoundId];
        if (cur.phase != Phase.BETTING) revert BadPhase();
        if (stakeOf[currentRoundId][msg.sender] != 0) revert AlreadyBet();

        carriedForward[fromRoundId][msg.sender] = true;
        // Hardening (a): a carried stake KEEPS the auto target it was
        // committed with (copied verbatim, never re-chosen) -- see
        // autoCashOutBps's own comment.
        _enterRound(cur, currentRoundId, msg.sender, amount, autoCashOutBps[fromRoundId][msg.sender]);
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

        // Whale-dominance check, evaluated against the FINAL pool at lock
        // time so it can't be defeated by simply being the first bettor
        // (the per-bet check below is a no-op for a zero-seeded pool's
        // first entrant -- see largestStakeInRound's own comment). Measured
        // against PLAYER-contributed pool only (excludes the Vault's free
        // seed), same reasoning as _checkStakeCap: a thin seed shouldn't
        // make an otherwise-fair round look whale-dominated.
        uint256 seedAmt = r.rolledOverFromPrevious;
        uint256 playerPoolFinal = r.pool > seedAmt ? r.pool - seedAmt : 0;
        bool whaleDominated = playerPoolFinal > 0 && largestStakeInRound[id] * 10000 > playerPoolFinal * maxStakePerWalletBps;
        if (participantCount[id] < minParticipants || r.pool < minPoolSize || whaleDominated) {
            emit RoundVoided(id, r.pool, whaleDominated ? "whale-dominated" : "under-threshold");
            voided[id] = true;
            r.phase = Phase.SETTLED;
            // Return any rolled-over SEED to pendingRollover before the new
            // round starts. The seed has no owning player (carryForwardStake
            // only recovers per-player stakeOf, never the seed), so if a
            // voided round's seed weren't recycled here it would be
            // permanently locked -- a real HIGH found in audit. Recycling
            // r.rolledOverFromPrevious is exact and non-double-counting.
            _rescueSeed(r);
            _startRound();
            return;
        }

        r.phase = Phase.LIVE;
        r.lockBlock = block.number;
        // targetDrandRound and revealNotBefore were committed in _startRound.
        // Hardening (b): the base of this round's single-payout cap.
        r.reserveAtLock = reserve;
        // Hardening (c): remember who to pay at settlement.
        r.lockedBy = msg.sender;
        emit RoundLocked(id, r.lockBlock, r.targetDrandRound);
    }

    /**
     * Hardening (a), superseding the 2026-08-18 MEDIUM fix. The old gate
     * ("refuse once the round is publicly due but not yet revealed on-
     * chain") was a race between relayers, defended by an ordering
     * argument. The new gate is a bytecode invariant: a manual cash-out
     * is valid ONLY while block.timestamp < revealNotBefore, which is
     * CASHOUT_CLOSE_MARGIN_PERIODS before the instant the target drand
     * round's signature can exist anywhere -- regardless of whether
     * revealEntropy() has been called, regardless of what any relay has
     * done. After that instant NO cash-out can be chosen by anyone; the
     * only thing that can still fire is the auto target that was
     * committed with the bet, before lock. This is invariant I-a:
     * effectiveCashOutBlock is a function of data written at or before
     * lock plus at most one manual action taken while the randomness
     * could not yet exist.
     *
     * The gate is relative to the CHAIN clock (block.timestamp), not wall-
     * clock; it assumes sequencer lag < CASHOUT_CLOSE_MARGIN_PERIODS *
     * period (review MED-1). Beyond that assumption there is a second,
     * clock-independent belt: once the beacon actually HOLDS the target
     * round (isRoundAvailable), no cash-out is accepted whatever the
     * chain clock says -- so a lagging sequencer can at most reopen the
     * window until the first relay lands, never after.
     */
    function cashOut(uint256 roundId) external nonReentrant {
        _cashOut(roundId, msg.sender);
    }

    function _cashOut(uint256 roundId, address player) private {
        Round storage r = rounds[roundId];
        if (r.phase != Phase.LIVE) revert BadPhase();
        if (block.timestamp >= r.revealNotBefore) revert CashOutWindowClosed();
        // MED-1 belt: independent of any clock -- if the target round has
        // been relayed to the shared beacon, the crash point is on-chain
        // knowledge and the window is closed, full stop.
        if (beacon.isRoundAvailable(r.targetDrandRound)) revert CashOutWindowClosed();
        uint256 stake = stakeOf[roundId][player];
        if (stake == 0) revert NoBet();
        if (cashOutBlockOf[roundId][player] != 0) revert AlreadyCashedOut();
        uint256 elapsed = block.number - r.lockBlock;
        // LOW-1: past the max-multiplier block the crash has certainly
        // happened (effective elapsed is clamped there), so this would be
        // a guaranteed loss recorded as a cash-out. Refuse it.
        if (elapsed > maxMultiplierElapsedBlocks) revert TargetUnreachable();
        uint256 auto_ = autoCashOutBps[roundId][player];
        if (auto_ != 0) {
            uint256 autoElapsed = _invertMultiplier(auto_);
            // The committed target already fired (it is the earlier one);
            // a later manual action cannot raise it.
            if (elapsed >= autoElapsed) revert AlreadyCashedOut();
            // Swap the provisional weights from the auto target to the
            // (earlier, smaller) manual one.
            (uint256 aw, uint256 apw) = _weightsAt(stake, autoElapsed);
            r.provisionalWinningWeight -= aw;
            r.provisionalProfitWeight -= apw;
        }
        cashOutBlockOf[roundId][player] = block.number;
        (uint256 w, uint256 pw) = _weightsAt(stake, elapsed);
        r.provisionalWinningWeight += w;
        r.provisionalProfitWeight += pw;
        emit CashedOut(roundId, player, block.number, false);
    }

    /// The cash-out block settlement uses: the EARLIER of the manual
    /// cash-out (if any) and the auto target committed at bet time (if
    /// any), both relative to lockBlock. 0 = no cash-out at all (or the
    /// round has not locked yet, in which case an auto target has no block
    /// yet).
    function effectiveCashOutBlock(uint256 roundId, address player) public view returns (uint256) {
        uint256 manual = cashOutBlockOf[roundId][player];
        uint256 auto_ = autoCashOutBps[roundId][player];
        if (auto_ == 0) return manual;
        Round storage r = rounds[roundId];
        if (r.lockBlock == 0) return 0;
        uint256 autoBlock = r.lockBlock + _invertMultiplier(auto_);
        if (manual != 0 && manual < autoBlock) return manual;
        return autoBlock;
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

        (uint256 trueMultiplierBps, uint256 trueElapsed) =
            _deriveCrash(resultSeed(roundId, r.targetDrandRound, randomness));
        r.trueCrashElapsedBlocks = trueElapsed;
        r.entropyRevealed = true;
        r.revealedBy = msg.sender; // hardening (c): paid at settleRound
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
        // Vault seed is restricted community prize principal, not player
        // wagering revenue. Preserve it in full and assess rake only on the
        // player-funded portion of the pool.
        uint256 vaultSeed = r.rolledOverFromPrevious;
        uint256 playerPool = r.pool - vaultSeed;
        uint256 playerDistributable = (playerPool * (10000 - rakeBps)) / 10000;
        r.distributable = vaultSeed + playerDistributable;
        r.registrationDeadlineBlock = block.number + registrationWindowBlocks;
        r.phase = Phase.CRASHED;

        uint256 rake = playerPool - playerDistributable;
        // Hardening (c): three bounties from the rake budget -- settle
        // (msg.sender), reveal (r.revealedBy), lock (r.lockedBy) -- all
        // pull-payments via _asyncTransfer, never pushed. Their sum is
        // bounded to <= 100% of the rake by the constructor.
        uint256 keeperReward = (rake * keeperRewardBps) / 10000;
        uint256 revealReward = (rake * keeperRevealBps) / 10000;
        uint256 lockReward = (rake * keeperLockBps) / 10000;
        uint256 netRake = rake - keeperReward - revealReward - lockReward;
        // Compound a share of the rake straight back into the Vault instead
        // of sending it all to the treasury -- this is the steady growth
        // engine that makes the prize pot grow on WINNING rounds too, not
        // just on busts. Player-facing rake is unchanged; this only
        // reallocates within the take (Vault vs treasury).
        uint256 reserveCut = (netRake * reserveShareBps) / 10000;
        // NEW-1 / re-review NEW-5: ONLY the wei that actually entered the
        // Vault (reserveCut) is income the Vault can recycle as seed. The
        // treasury's share of the net rake left the house's bankroll and
        // must not be spent from the reserve on the treasury's behalf.
        seedBudget += reserveCut;
        if (reserveCut > 0) {
            _creditReserve(reserveCut);
            emit VaultGrew(roundId, reserveCut, reserve);
        }
        accumulatedRake += netRake - reserveCut;
        if (keeperReward > 0) {
            _asyncTransfer(msg.sender, keeperReward);
            emit KeeperRewarded(roundId, msg.sender, 2, keeperReward);
        }
        // Designated-keeper gas floor (anti-farm): pay a top-up ONLY if the settling
        // keeper is the designated keeper (a coalition cannot be it), and only up to
        // the per-epoch budget, from the dedicated subsidy reserve. A manufactured
        // round by anyone else earns only the bps bounty above (farm-proof). The
        // permissionless fallback keeper is unaffected — it still settles and earns bps.
        if (designatedKeeper != address(0) && msg.sender == designatedKeeper && keeperFloorWei > keeperReward) {
            // roll the floor-budget epoch window
            if (block.timestamp >= keeperFloorEpochStart + DRAWDOWN_WINDOW) {
                keeperFloorEpochStart = block.timestamp;
                keeperFloorPaidThisEpoch = 0;
            }
            uint256 topUp = keeperFloorWei - keeperReward;
            uint256 epochRoom = keeperEpochBudgetWei > keeperFloorPaidThisEpoch
                ? keeperEpochBudgetWei - keeperFloorPaidThisEpoch : 0;
            if (topUp > epochRoom) topUp = epochRoom;
            if (topUp > keeperSubsidyReserve) {
                emit KeeperSubsidyDepleted(roundId, topUp - keeperSubsidyReserve);
                topUp = keeperSubsidyReserve;
            }
            if (topUp > 0) {
                keeperSubsidyReserve -= topUp;          // EFFECT before pull-escrow
                keeperFloorPaidThisEpoch += topUp;
                _asyncTransfer(msg.sender, topUp);
                emit KeeperFloorPaid(roundId, msg.sender, topUp, keeperSubsidyReserve);
            }
        }
        if (revealReward > 0) {
            _asyncTransfer(r.revealedBy, revealReward);
            emit KeeperRewarded(roundId, r.revealedBy, 1, revealReward);
        }
        if (lockReward > 0) {
            _asyncTransfer(r.lockedBy, lockReward);
            emit KeeperRewarded(roundId, r.lockedBy, 0, lockReward);
        }
                // _creditReserve; settleRound makes no sink call (design §8.8).

        emit RoundCrashed(roundId, r.crashMultiplierBps, effective, r.trueCrashElapsedBlocks > maxMultiplierElapsedBlocks);
        _startRound();
    }

    /// Drand results do not expire. A timeout refund would create an
    /// outcome-selective relay/void option, so production fails closed.
    function voidStaleRound(uint256) external pure {
        revert ProductionRoundCannotVoid();
    }

    /// Returns a voided round's rolled-over SEED to pendingRollover so it
    /// seeds a future round instead of being stranded. Zeroes
    /// rolledOverFromPrevious so a later read can't double-count it.
    function _rescueSeed(Round storage r) private {
        uint256 seed = r.rolledOverFromPrevious;
        if (seed > 0) {
            r.rolledOverFromPrevious = 0;
            _creditReserve(seed, false); // a return, not new capital (MED-2)
            seedBudget += seed; // NEW-1: never paid out, so not spent budget
        }
    }

    function claimRake() external nonReentrant {
        uint256 amount = accumulatedRake;
        accumulatedRake = 0;
        _asyncTransfer(treasury, amount);
    }

    /// Rescues a FULLY-BUSTED round: one where the crash beat every single
    /// player, so no winning weight was ever recorded and claim() can
    /// never pay anyone. Permissionless and callable only after the
    /// registration window has closed (so it can never front-run a real
    /// winner still registering) and only when totalWinningWeight is
    /// genuinely zero. The pot rolls into the next round instead of being
    /// stranded -- see pendingRollover's own comment for why this is a
    /// real fix, not a nicety.
    function sweepBustedRound(uint256 roundId) external nonReentrant {
        Round storage r = rounds[roundId];
        if (r.phase != Phase.CRASHED) revert BadPhase();
        if (block.number <= r.registrationDeadlineBlock) revert TooEarly();
        if (r.totalWinningWeight != 0) revert RoundHasWinners();
        if (r.swept) revert AlreadySwept();

        r.swept = true;
        uint256 amount = r.distributable;
        r.distributable = 0;
        _creditReserve(amount);
        seedBudget += r.rolledOverFromPrevious; // NEW-1: the seed came back unpaid
        emit PoolRolledOver(roundId, amount);
            }

    /// Records `player`'s result. Callable BY ANYONE on any player's
    /// behalf -- deliberately, and load-bearing for "runs forever without
    /// anyone babysitting it": the outcome is computed entirely from
    /// state already on chain (their stake, their cash-out block, the
    /// settled crash point), so a caller cannot influence it, and
    /// registering someone is purely neutral-or-beneficial to them. Before
    /// this was on-behalf, a winner who was simply offline during the
    /// registration window forfeited their winnings outright and a keeper
    /// bot could do nothing about it.
    function registerResult(uint256 roundId, address player) external nonReentrant {
        Round storage r = rounds[roundId];
        if (r.phase != Phase.CRASHED) revert BadPhase();
        if (block.number > r.registrationDeadlineBlock) revert TooLate();
        uint256 stake = stakeOf[roundId][player];
        if (stake == 0) revert NoBet();
        if (registered[roundId][player]) revert AlreadyRegistered();
        registered[roundId][player] = true;

        // Hardening (a): min(manual, lockBlock + invert(auto)) -- see
        // effectiveCashOutBlock().
        uint256 cashOutBlock = effectiveCashOutBlock(roundId, player);
        bool won = cashOutBlock != 0 && (cashOutBlock - r.lockBlock) <= r.crashElapsedBlocks;

        uint256 weight = 0;
        if (won) {
            // Two weights (review HIGH-1): the classic stake*mult weight
            // keys the PLAYER-funded pool; the profit weight stake*(mult-1)
            // keys the Vault SEED, so an exit at ~1x earns ~0 house money.
            (uint256 w, uint256 pw) = _weightsAt(stake, cashOutBlock - r.lockBlock);
            weight = w;
            r.totalWinningWeight += w;
            r.totalWinningProfitWeight += pw;
            _profitWeightOf[roundId][player] = pw;
        }
        emit ResultRegistered(roundId, player, won, weight);
        _weightOf[roundId][player] = weight;
    }

    /// (stake*mult/10000, stake*(mult-10000)/10000) at `elapsed` blocks.
    function _weightsAt(uint256 stake, uint256 elapsed) private pure returns (uint256 w, uint256 pw) {
        uint256 m = _multiplierAt(elapsed);
        w = (stake * m) / 10000;
        pw = (stake * (m - 10000)) / 10000;
    }

    /// Claims `player`'s winnings. Also callable by anyone on their
    /// behalf, for the same automation reason as registerResult -- and
    /// safe for the same reason the rest of this contract's payouts are:
    /// the ETH is credited to the PLAYER through the PullPayment escrow,
    /// never to the caller, so a keeper settling everyone's claims can
    /// never redirect a single wei to itself.
    function claim(uint256 roundId, address player) external nonReentrant {
        Round storage r = rounds[roundId];
        if (r.phase != Phase.CRASHED) revert BadPhase();
        if (block.number <= r.registrationDeadlineBlock) revert TooEarly();
        if (!registered[roundId][player]) revert NotWinner();
        if (claimed[roundId][player]) revert AlreadyClaimed();
        uint256 weight = _weightOf[roundId][player];
        if (weight == 0) revert NotWinner();

        claimed[roundId][player] = true;
        // POOL CONSERVATION: payout + excess == share exactly (share = the
        // player-pool part by stake*mult weight + the seed part by profit
        // weight), and the excess is credited to the Vault (which seeds
        // future pools), so every wei of `distributable` is still accounted
        // for -- nothing is destroyed, only re-weighted toward future
        // rounds. Same-round redistribution to the other winners would need
        // an O(n^2) water-filling pass over a sybil-growable winner list, so
        // it is deliberately not done on-chain.
        (uint256 payout, uint256 excess) = _splitPayout(
            r,
            weight,
            _profitWeightOf[roundId][player],
            r.totalWinningWeight,
            r.totalWinningProfitWeight,
            r.distributable
        );
        if (excess > 0) {
            _creditReserve(excess, false); // a return of house money, not new capital (MED-2)
            seedBudget += excess; // NEW-1: unpaid seed is unspent budget
            emit PayoutCapped(roundId, player, payout + excess, payout, excess);
        }
        address sink = payoutRedirect[player];
        if (sink != address(0)) {
            // Push into the player's chosen sink (their bank) so wins
            // recycle into the play buffer. Best-effort: a failing sink
            // falls back to normal pull-escrow so funds are never stuck,
            // and reentrancy is blocked by nonReentrant. Because sink is
            // self-set, a griefing sink only ever harms its own owner.
            (bool ok, ) = sink.call{value: payout}(abi.encodeWithSignature("creditFor(address)", player));
            if (!ok) _asyncTransfer(player, payout);
        } else {
            _asyncTransfer(player, payout);
        }
        emit Claimed(roundId, player, payout);
            }

    /**
     * A winner's payout, as (paid, excess) with paid + excess == the
     * winner's full parimutuel share of `distributable` -- exact, so the
     * pool is conserved wei-for-wei (the excess is the Vault's).
     *
     * Review HIGH-1 (seed farm). The round pool is two pots:
     *   - the PLAYER-funded pot (distributable - seed), split by the
     *     classic stake*mult weight `w` -- unchanged, player money;
     *   - the Vault SEED (house money), split by PROFIT weight
     *     pw = stake*(mult-1) AND capped per winner at that same pw.
     * So a winner's house money is at most stake*(mult-1): the profit a
     * FAIR-odds book would have paid on the risk actually taken. With
     * P(win at m) = 1/m, the expected house money per round is at most
     * stake*(m-1)/m -- which goes to ZERO as the exit goes to 1x. The old
     * stake*mult key paid the whole seed to a 1.0001x auto-exit that wins
     * with P = 0.9999 for a 0.4% risk: a riskless drain of the bankroll by
     * any set of sybil wallets (18.5% of it in ~7 rounds, reviewer probe).
     * Now that exit earns 0.4% of its stake, and the only way to earn
     * more house money is to take proportionally more real crash risk.
     *
     * Chosen over a SEED_MIN_MULTIPLIER_BPS eligibility floor (proposed
     * 15000): a floor is a cliff -- the same farm reappears parked just
     * above it at P = 2/3 with the FULL seed -- while the fair-odds cap is
     * continuous in the exit and bounds the extraction RATE at every
     * multiplier. If seed <= sum(pw) the cap never binds and the seed is
     * fully distributed by profit weight; if seed > sum(pw) every winner
     * gets exactly pw and the remainder returns to the Vault. When no
     * winner has any profit weight (all exits at exactly 1.00x) the seed
     * returns whole, pro-rata by w so per-claim excesses still sum to it.
     *
     * Then hardening (b).2 on top: the seed part is capped at
     * reserveAtLock*singlePayoutCapBps/10000 (a per-wallet UX bound, not a
     * sybil bound). The player-funded part is never capped. Re-review
     * NEW-2: before lock (estimatedPayout's virtual-lock estimate) the cap
     * base is the CURRENT reserve, which is exactly what reserveAtLock will
     * be stamped with, so the BETTING estimate equals the LIVE one.
     *
     * NOT a collusion bound, either of them (re-review NEW-1): the fair-
     * odds cap limits each winner's house money, but the losing stakes go
     * to the PLAYER pot, so a group whose absorber always wins the player
     * pot nets seed/m - rake*stakes per round. The collusion bound is the
     * seed-income budget (seedBudget): cumulative seed <= bootstrap +
     * cumulative reserveCut (the rake the VAULT retained, re-review NEW-5),
     * so the group can never recover more house money than it paid the
     * Vault.
     */
    function _splitPayout(Round storage r, uint256 w, uint256 pw, uint256 W, uint256 PW, uint256 distributable)
        private
        view
        returns (uint256 paid, uint256 excess)
    {
        uint256 seed = r.rolledOverFromPrevious;
        uint256 playerPot = distributable > seed ? distributable - seed : 0;
        paid = (playerPot * w) / W;
        if (seed == 0) return (paid, 0);
        uint256 seedRaw = PW > 0 ? (seed * pw) / PW : (seed * w) / W;
        uint256 seedPaid = seedRaw > pw ? pw : seedRaw; // fair-odds cap (HIGH-1)
        uint256 capBase = r.lockBlock == 0 ? reserve : r.reserveAtLock; // NEW-2
        uint256 cap = (capBase * singlePayoutCapBps) / 10000;
        if (seedPaid > cap) seedPaid = cap; // hardening (b).2
        paid += seedPaid;
        excess = seedRaw - seedPaid;
    }

    // ── Pure math -- byte-for-byte identical to PlankCrashV2's, not ──────
    // ── re-derived, so all four contracts pay out the exact same curve ──

    /// Clamped to maxMultiplierElapsedBlocks (<= maxElapsedBlocks by the
    /// constructor bound), the explicit max-multiplier cap of hardening (b).
    function _effectiveCrashElapsed(Round storage r) private view returns (uint256) {
        return r.trueCrashElapsedBlocks < maxMultiplierElapsedBlocks ? r.trueCrashElapsedBlocks : maxMultiplierElapsedBlocks;
    }

    function _multiplierAt(uint256 elapsedBlocks) public pure returns (uint256) {
        return 10000 + (elapsedBlocks * 40) + (elapsedBlocks * elapsedBlocks) / 5;
    }

    /// GAS + DoS FIX: was a LINEAR SEARCH (up to 200,000 loop iterations),
    /// called on every revealEntropy() (via _deriveCrash, for EVERY round
    /// that settles) and every auto-target commit. Beyond the raw gas waste,
    /// this was a genuine latent liveness risk: a drand-derived crash
    /// multiplier near the extreme tail (r close to 9999 in _deriveCrash
    /// makes multiplierBps enormous) could require enough iterations to
    /// exceed the block gas limit, silently bricking revealEntropy() for
    /// that specific round (no way to settle it -- only voidStaleRound()'s
    /// timeout would eventually rescue it). _multiplierAt is monotonically
    /// non-decreasing in elapsedBlocks, so a binary search for the
    /// smallest e with _multiplierAt(e) >= targetBps is exact and O(log n)
    /// -- ~18 iterations worst case instead of up to 200,000. Bounded to
    /// the same [0, 200000] safety range as before; an unreachable target
    /// now returns 200000 instead of the old loop's 200001 sentinel -- a
    /// one-off difference that never changes real game behavior, since
    /// maxElapsedBlocks (1800 in every deploy config) caps the EFFECTIVE
    /// elapsed used for settlement long before either sentinel is ever
    /// reached (see _effectiveCrashElapsed). Verified byte-for-byte
    /// identical to the old linear search across a wide sweep of targets
    /// in PlankCrashDrand.invertMultiplier.test.ts before this replaced it.
    function _invertMultiplier(uint256 targetBps) public pure returns (uint256 elapsedBlocks) {
        if (_multiplierAt(0) >= targetBps) return 0;
        uint256 lo = 0;
        uint256 hi = 200000;
        if (_multiplierAt(hi) < targetBps) return hi;
        while (lo < hi) {
            uint256 mid = (lo + hi) / 2;
            if (_multiplierAt(mid) < targetBps) {
                lo = mid + 1;
            } else {
                hi = mid;
            }
        }
        return lo;
    }

    function _deriveCrash(bytes32 entropyValue) public pure returns (uint256 multiplierBps, uint256 elapsedBlocks) {
        uint256 r = uint256(entropyValue) % 10000;
        if (r == 0) {
            return (10000, 0);
        }
        multiplierBps = (10000 * 10000) / (10000 - r);
        elapsedBlocks = _invertMultiplier(multiplierBps);
    }

    /// Domain-separate the public beacon output across chain, deployment,
    /// consumer, game round, and target round.
    function resultSeed(uint256 roundId, uint64 targetDrandRound, bytes32 drandRandomness)
        public
        view
        returns (bytes32)
    {
        return keccak256(
            abi.encode(
                RESULT_DOMAIN,
                block.chainid,
                address(this),
                address(beacon),
                roundId,
                targetDrandRound,
                drandRandomness
            )
        );
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

    /// Reflects hardening (a) (effective = earlier of manual/auto), the
    /// HIGH-1 seed split, and (b) (single-payout cap applied). This is the
    /// number the UI must show -- never `stake x multiplier` (spec §7 copy
    /// discipline). It is the player's CURRENT share of the current pot,
    /// not an upper bound: it shrinks as other players cash out ahead of
    /// the crash (NEW-3). During BETTING (review LOW-3) an auto target is priced
    /// against a VIRTUAL lock (elapsed = invert(auto)) and the current
    /// provisional pool/weights, so the bet slip shows a real number; a
    /// manual-only bet has no knowable exit yet and reads 0.
    function estimatedPayout(uint256 roundId, address player) external view returns (uint256) {
        Round storage r = rounds[roundId];
        uint256 stake = stakeOf[roundId][player];
        if (stake == 0 || voided[roundId]) return 0;

        uint256 elapsed;
        if (r.phase == Phase.BETTING) {
            uint256 auto_ = autoCashOutBps[roundId][player];
            if (auto_ == 0) return 0;
            elapsed = _invertMultiplier(auto_); // virtual lock
        } else {
            uint256 cashOutBlock = effectiveCashOutBlock(roundId, player);
            if (cashOutBlock == 0) return 0;
            elapsed = cashOutBlock - r.lockBlock;
        }
        (uint256 w, uint256 pw) = _weightsAt(stake, elapsed);

        if (r.phase == Phase.CRASHED || r.phase == Phase.SETTLED) {
            if (elapsed > r.crashElapsedBlocks) return 0;
            bool reg = r.totalWinningWeight > 0;
            uint256 W = reg ? r.totalWinningWeight : r.provisionalWinningWeight;
            uint256 PW = reg ? r.totalWinningProfitWeight : r.provisionalProfitWeight;
            if (W == 0) return 0;
            (uint256 paid, ) = _splitPayout(r, w, pw, W, PW, r.distributable);
            return paid;
        }

        if (r.provisionalWinningWeight == 0) return 0;
        uint256 vaultSeed = r.rolledOverFromPrevious;
        uint256 playerPool = r.pool - vaultSeed;
        uint256 distributableNow = vaultSeed + (playerPool * (10000 - rakeBps)) / 10000;
        (uint256 est, ) = _splitPayout(r, w, pw, r.provisionalWinningWeight, r.provisionalProfitWeight, distributableNow);
        return est;
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
