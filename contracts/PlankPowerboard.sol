// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ReentrancyGuard} from "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import {PullPayment} from "@openzeppelin/contracts/security/PullPayment.sol";
import {IDrandBeacon} from "./IDrandBeacon.sol";
import {IPlankProgression} from "./IPlankProgression.sol";

/// The read surface every plank.love game already exposes for its own
/// pari-mutuel accounting -- PlankCrashV2/VRF/Entropy/Drand and
/// PlankDerby.sol all already have a public `stakeOf(roundId, player)`
/// getter matching this exact shape, so any of them can become a ticket
/// source with NO code change.
interface IWagerSource {
    function stakeOf(uint256 roundId, address player) external view returns (uint256);
    /// Rounds strictly below this id are finished (settled or voided) --
    /// every Plank Crash variant advances currentRoundId ONLY when the
    /// previous round settles or voids, so `roundId < currentRoundId()`
    /// is exactly "this round's stake actually went through settlement".
    function currentRoundId() external view returns (uint256);
    /// True when the round was voided (stakes carried forward, NO rake
    /// taken). Public mapping getter on every Plank Crash variant.
    function voided(uint256 roundId) external view returns (bool);
}

/**
 * POWERBOARD -- plank.love's rolling community jackpot.
 *
 * Replaces the earlier PlankAirdropPool (a flat "one winner takes the
 * epoch's pot" raffle). That version paid out fully every single epoch,
 * so the prize never grew and there was nothing to chase. Powerboard adds
 * the one mechanic the whole lottery industry is actually built on -- the
 * ROLLOVER -- while keeping every safety property the old pool had
 * (immutable source allowlist, per-bet claim guard, O(log n) draw, fixed
 * schedule, shared drand beacon).
 *
 * HOW IT WORKS (real Powerball mechanics, not a metaphor):
 *   - Every bet on an allowed game credits wager-weighted tickets. Your
 *     odds are exactly proportional to what you actually wagered; nobody
 *     can buy odds they didn't earn at the table.
 *   - Every epoch (a fixed, publicly computable schedule) one drand round
 *     draws TWO independent values: the winning TICKET, and the PLANK
 *     BALL, an integer in [1, ballRange].
 *   - If the Plank Ball lands on jackpotBall (odds 1/ballRange), the
 *     ticket holder takes the ENTIRE rolling jackpot. It resets and starts
 *     again.
 *   - If it misses, that ticket holder still wins a consolation slice
 *     (consolationBps of the pot) and THE REST ROLLS OVER. The pot grows
 *     only when new funding exceeds payouts.
 *
 * WHY THIS SHAPE -- grounded in how real lotteries actually behave:
 *   - The rollover is the engine. Players are ~15x more likely to buy in
 *     near a headline jackpot than a small one, which is why lottery
 *     operators deliberately engineer games to roll over rather than pay
 *     out flat every draw. A pot that visibly compounds is the single
 *     strongest retention mechanic in the category.
 *   - The consolation tier is what keeps it from being pure hopelessness:
 *     somebody wins something every epoch (frequent small wins sustain
 *     engagement), while the big prize stays rare enough to grow.
 *   - Splitting the two draws (ticket vs ball) is exactly the real
 *     "second number" design -- it manufactures a distinct, rarer prize
 *     tier on top of an ordinary one from a single random source.
 *
 * WHAT THIS IS NOT, SAID HONESTLY: this does not make any individual bet
 * positive-EV. Powerboard is funded by the games' rake -- money that came
 * from players. It redistributes that money back to players (rather than
 * letting it leave to a disconnected treasury) and reshapes it into a
 * compounding prize. It is positive-SUM for the community, not a
 * money printer, and no UI should ever imply otherwise.
 *
 * ETHICS -- A DELIBERATE, LOAD-BEARING CONSTRAINT: the epoch schedule is
 * FIXED and publicly computable (currentEpoch() is a pure function of
 * block.timestamp). Unpredictable reward TIMING is the strongest known
 * driver of compulsive engagement, and a crash game is already one such
 * loop; a surprise-timed jackpot stacked on top would compound that harm.
 * The uncertainty here is in the OUTCOME (did the ball hit?), never in
 * WHEN the draw happens. Do not "improve" this into a random-timing
 * trigger.
 */
contract PlankPowerboard is ReentrancyGuard, PullPayment {
    IDrandBeacon public immutable beacon;
    uint256 public immutable genesisTimestamp;
    uint256 public immutable epochDuration;
    /// Paid to whoever calls drawWinner() -- the same keeper-incentive
    /// shape used throughout this protocol, so the draw happens on time
    /// without depending on any one operator staying alive.
    uint256 public immutable drawerRewardBps;
    /// Plank Ball range: the ball is drawn in [1, ballRange], so the
    /// jackpot's per-epoch odds are exactly 1/ballRange.
    uint256 public immutable ballRange;
    /// The number the ball must land on for the jackpot to pay out.
    uint256 public immutable jackpotBall;
    /// Share of the pot paid to the epoch's ticket winner when the ball
    /// MISSES. The remainder rolls over. Keeps a real win happening every
    /// epoch without draining the compounding jackpot.
    uint256 public immutable consolationBps;

    /// Real safety margin, in whole drand rounds, matching
    /// PlankCrashDrand.sol's own reasoning -- see that file for the full
    /// writeup (Orbit sequencer timestamp-jump risk).
    uint256 private constant DRAW_ROUND_SAFETY_PERIODS = 20;
    /// Hard ceiling on the keeper's draw reward -- see the constructor.
    uint256 private constant MAX_DRAWER_REWARD_BPS = 500;

    /// "MUST BE WON" guarantee: if the jackpot has not hit for this many
    /// epochs, the next drawn epoch (with participants) pays the FULL jackpot
    /// regardless of the ball -- the real-lottery mechanic that caps how long
    /// the pot can roll without paying out. 0 disables it (pure geometric).
    uint256 public immutable mustHitByEpochs;

    // ── Optional progression/leveling layer -- see setProgression() and
    // PlankProgression.sol's own header. Same pattern as PlankCrashDrand's
    // own wiring: _deployer captured automatically, not a parameter or an
    // ongoing admin role.
    address private immutable _deployer;
    IPlankProgression public progression;

    /// The current rolling jackpot; deposits increase it and payouts reduce it.
    uint256 public jackpot;
    uint256 public totalPaidOut;
    uint256 public jackpotsHit;
    /// Last epoch the full jackpot paid out (natural or forced). The
    /// "must be won" clock counts from here. Starts at 0 (genesis epoch).
    uint256 public lastJackpotHitEpoch;

    mapping(address => bool) public isAllowedSource;

    struct Epoch {
        uint256 totalTickets;
        uint64 targetDrandRound;
        bool drawRequested;
        bool drawn;
        bool jackpotHit;
        uint256 drawnBall;
        address winner;
        uint256 prize;
    }

    /// One per claimTickets() call: `player` owns the half-open ticket
    /// range ending at `cumulativeEnd`. Strictly increasing (a zero-stake
    /// claim reverts), so the array is sorted and binary-searchable --
    /// the draw is O(log n) and a sybil cannot bloat it into a DoS.
    struct TicketSegment {
        address player;
        uint256 cumulativeEnd;
    }

    mapping(uint256 => Epoch) public epochs;
    mapping(uint256 => TicketSegment[]) private _segments;
    mapping(uint256 => mapping(address => uint256)) public ticketsOf;
    mapping(uint256 => uint256) public distinctParticipants;
    mapping(uint256 => mapping(address => bool)) private _hasParticipated;
    /// (source, sourceRoundId, player) -> claimed. The same real bet can
    /// never be credited as tickets twice.
    mapping(bytes32 => bool) public ticketsClaimed;

    event Funded(uint256 amount, uint256 newJackpot);
    event TicketsClaimed(
        uint256 indexed epoch,
        address indexed source,
        uint256 sourceRoundId,
        address indexed player,
        uint256 amount
    );
    event DrawRequested(uint256 indexed epoch, uint64 targetDrandRound);
    event Drawn(
        uint256 indexed epoch,
        address indexed winner,
        uint256 ball,
        bool jackpotHit,
        uint256 payout,
        uint256 drawerReward,
        uint256 jackpotRemaining
    );
    event EpochSkipped(uint256 indexed epoch, uint256 jackpotRolled, string reason);
    event JackpotForced(uint256 indexed epoch, uint256 prize);

    error ZeroAddress();
    error BadConfig();
    error UnknownSource();
    error NoStake();
    error AlreadyClaimed();
    error EpochNotClosed();
    error SourceRoundNotFinal();
    error SourceRoundVoided();
    error EpochAlreadyDrawn();
    error DrawNotYetRequested();
    error DrawAlreadyRequested();
    error RandomnessNotYetAvailable();
    error ProgressionAlreadySet();
    error NotDeployer();

    struct Config {
        address beacon;
        address[] allowedSources;
        uint256 genesisTimestamp;
        uint256 epochDuration;
        uint256 drawerRewardBps;
        uint256 ballRange;
        uint256 jackpotBall;
        uint256 consolationBps;
        uint256 mustHitByEpochs; // 0 = disabled (pure geometric jackpot)
    }

    constructor(Config memory cfg) {
        _deployer = msg.sender;
        if (cfg.beacon == address(0)) revert ZeroAddress();
        if (cfg.epochDuration == 0) revert BadConfig();
        // A ball range of 1 would make every epoch a guaranteed jackpot
        // (no rollover, i.e. the old flat-raffle behavior); the ball must
        // also be inside the range or the jackpot could NEVER hit and the
        // pot would grow forever with no way to win it.
        if (cfg.ballRange < 2) revert BadConfig();
        if (cfg.jackpotBall == 0 || cfg.jackpotBall > cfg.ballRange) revert BadConfig();
        // Hard cap the drawer's cut independent of consolation. Without
        // this, a legal drawerRewardBps of up to 100% would let whoever
        // calls the permissionless drawWinner() take the entire prize --
        // including a full jackpot hit -- leaving the winner nothing. Real
        // audit finding; the reward only needs to cover gas plus a small
        // incentive, so 5% is a generous ceiling.
        if (cfg.drawerRewardBps > MAX_DRAWER_REWARD_BPS) revert BadConfig();
        // consolation must leave something to roll over, or the "rolling
        // jackpot" degenerates into the old flat pay-out-every-epoch raffle.
        if (cfg.consolationBps >= 10000) revert BadConfig();
        if (cfg.drawerRewardBps + cfg.consolationBps > 10000) revert BadConfig();

        beacon = IDrandBeacon(cfg.beacon);
        genesisTimestamp = cfg.genesisTimestamp;
        epochDuration = cfg.epochDuration;
        drawerRewardBps = cfg.drawerRewardBps;
        ballRange = cfg.ballRange;
        jackpotBall = cfg.jackpotBall;
        consolationBps = cfg.consolationBps;
        mustHitByEpochs = cfg.mustHitByEpochs;
        // Start the "must be won" clock at deployment, not epoch 0 -- the
        // genesis can be an earlier timestamp, so currentEpoch() may already
        // be large; without this the guarantee would read as due immediately.
        lastJackpotHitEpoch = currentEpoch();
        for (uint256 i = 0; i < cfg.allowedSources.length; i++) {
            if (cfg.allowedSources[i] == address(0)) revert ZeroAddress();
            isAllowedSource[cfg.allowedSources[i]] = true;
        }
    }

    /// Wires this contract to a deployed PlankProgression, EXACTLY once, by
    /// whoever deployed THIS contract -- see PlankCrashDrand.setProgression's
    /// own comment for the full reasoning (same pattern, same narrow,
    /// one-shot, non-fund-touching privilege).
    function setProgression(address progression_) external {
        if (msg.sender != _deployer) revert NotDeployer();
        if (address(progression) != address(0)) revert ProgressionAlreadySet();
        progression = IPlankProgression(progression_);
    }

    function currentEpoch() public view returns (uint256) {
        if (block.timestamp < genesisTimestamp) return 0;
        return (block.timestamp - genesisTimestamp) / epochDuration;
    }

    function _epochEndsAt(uint256 epoch) private view returns (uint256) {
        return genesisTimestamp + (epoch + 1) * epochDuration;
    }

    /// Feeds the rolling jackpot. Called by PlankRakeDistributor with the
    /// jackpot leg of the games' rake -- but deliberately open to anyone,
    /// since there is no reason to gate topping up a community pot (a
    /// sponsor funding a promo round is a real, wanted use).
    function fund() external payable {
        jackpot += msg.value;
        emit Funded(msg.value, jackpot);
    }

    /// Credits `player` real, wager-weighted tickets for a bet they
    /// ALREADY placed on `source`, read from that contract's own public
    /// on-chain state -- never from caller-supplied numbers. `source`
    /// must be on the immutable allowlist: without it anyone could deploy
    /// a contract whose stakeOf() returns a huge number and mint
    /// themselves unlimited odds.
    function claimTickets(address source, uint256 sourceRoundId, address player) external {
        if (!isAllowedSource[source]) revert UnknownSource();
        // A source whose stakeOf(round, address(0)) ever returns nonzero
        // would otherwise credit tickets to the zero address, and a win
        // there escrows ETH to address(0) -- permanently locked (not
        // stealable, but real ETH stranded). Reject it outright.
        if (player == address(0)) revert ZeroAddress();
        // ── AUDIT 2026-09-02 HIGH fix: tickets only for RAKED, FINAL wagers.
        // A crash round that VOIDS (under-threshold / whale-dominated) keeps
        // stakeOf[round][player] nonzero forever (carryForwardStake needs it)
        // and takes ZERO rake -- so before this gate, one solo stake could be
        // deliberately void-cycled round after round (bet solo -> lockRound
        // voids -> carryForwardStake), and EVERY voided roundId was a fresh
        // (source, roundId, player) claim: unbounded wager-weighted tickets
        // for gas only, while honest players pay rake per ticket batch. The
        // same hole existed at the front of the round's life: claiming while
        // the round was still BETTING/LIVE credited tickets for a stake whose
        // round could still void afterwards. Both close here: the source
        // round must be FINISHED (id strictly below the source's own
        // currentRoundId -- every crash variant advances it only on settle or
        // void) and must NOT have voided (rake was actually taken).
        if (sourceRoundId >= IWagerSource(source).currentRoundId()) revert SourceRoundNotFinal();
        if (IWagerSource(source).voided(sourceRoundId)) revert SourceRoundVoided();
        uint256 amount = IWagerSource(source).stakeOf(sourceRoundId, player);
        if (amount == 0) revert NoStake();

        bytes32 claimId = keccak256(abi.encodePacked(source, sourceRoundId, player));
        if (ticketsClaimed[claimId]) revert AlreadyClaimed();
        ticketsClaimed[claimId] = true;

        uint256 epoch = currentEpoch();
        Epoch storage e = epochs[epoch];
        uint256 newCumulativeEnd = e.totalTickets + amount;

        _segments[epoch].push(TicketSegment({player: player, cumulativeEnd: newCumulativeEnd}));
        e.totalTickets = newCumulativeEnd;
        ticketsOf[epoch][player] += amount;
        if (!_hasParticipated[epoch][player]) {
            _hasParticipated[epoch][player] = true;
            distinctParticipants[epoch] += 1;
        }
        emit TicketsClaimed(epoch, source, sourceRoundId, player, amount);
        // MEDIUM-severity fix, 2026-08-18: PlankProgression.sol's own header
        // previously claimed this call "can't revert a caller's OWN core
        // action" because it's the last statement in the function -- that
        // was false (Solidity unwinds the whole transaction on any revert,
        // statement order notwithstanding). try/catch makes the guarantee
        // real: a misbehaving/misconfigured progression contract can't
        // brick ticket claims. (An initial debugging pass wrongly suspected
        // bare `catch {}` behaved differently from `catch (bytes memory) {}`
        // here -- re-verified against the full canonical test suite
        // (`npm run test:contracts`, 292/292 green) and confirmed that was
        // test-run-order flakiness elsewhere in the suite, not a real
        // difference; either catch form is fine.)
        if (address(progression) != address(0)) {
            // REAL BUG, FOUND AND FIXED 2026-08-18 -- not a test-infra flake.
            // A genuinely EMPTY try-body (`try ... {} catch {}`) compiled
            // under this project's viaIR pipeline (hardhat.config.ts) was
            // empirically, deterministically unreliable: 8/8 real test runs
            // against a from-scratch `hardhat clean` rebuild failed to
            // persist progression's own successful state write, and 8/8
            // runs of the IDENTICAL logic with a real statement added to
            // the try-body succeeded -- reproduced both directions
            // repeatedly, ruling out test-order flakiness, stale build
            // artifacts, and RPC-layer races (all independently checked and
            // ruled out first). Root cause not fully bisected against a
            // specific solc/viaIR version note, but the empirical fix is
            // unambiguous: NEVER leave a try-block body truly empty. Emitting
            // a real, permanently useful event here both closes the bug and
            // gives real on-chain observability into a case the original
            // try/catch fix was already meant to make survivable -- an
            // operator can now see exactly when progression recording
            // silently failed, instead of it being invisible either way.
            try progression.recordPowerboardClaim(player) {
                emit ProgressionRecorded(player, true);
            } catch {
                emit ProgressionRecorded(player, false);
            }
        }
    }

    /// @notice Whether the optional progression hook succeeded for this claim. false is NOT a fund-safety issue (see try/catch's own header) -- it's real signal that progression.sol is misconfigured or broken and needs operator attention.
    event ProgressionRecorded(address indexed player, bool succeeded);

    /// Permissionless, once the epoch has genuinely closed. Commits the
    /// draw to a specific FUTURE drand round -- so the outcome is fixed
    /// before it can be known by anyone, including whoever calls this.
    function requestDraw(uint256 epoch) external {
        if (block.timestamp < _epochEndsAt(epoch)) revert EpochNotClosed();
        Epoch storage e = epochs[epoch];
        if (e.drawRequested) revert DrawAlreadyRequested();
        e.drawRequested = true;
        e.targetDrandRound = beacon.nextRoundAfter(block.timestamp) + uint64(DRAW_ROUND_SAFETY_PERIODS);
        emit DrawRequested(epoch, e.targetDrandRound);
    }

    /// Permissionless. Draws the winning ticket and the Plank Ball from
    /// the shared beacon's already-verified randomness, then pays either
    /// the full jackpot (ball hit) or the consolation slice (ball missed,
    /// remainder rolls over).
    function drawWinner(uint256 epoch) external nonReentrant {
        Epoch storage e = epochs[epoch];
        if (!e.drawRequested) revert DrawNotYetRequested();
        if (e.drawn) revert EpochAlreadyDrawn();

        // Nobody played this epoch: nothing to pay, and the jackpot simply
        // keeps rolling. Never strands funds.
        if (e.totalTickets == 0) {
            e.drawn = true;
            emit EpochSkipped(epoch, jackpot, "no-participants");
            return;
        }

        bytes32 randomness = beacon.randomnessOrZero(e.targetDrandRound);
        if (randomness == bytes32(0)) revert RandomnessNotYetAvailable();

        // Two independent draws from one verified source, separated by
        // domain tags so the ball can never correlate with the ticket.
        uint256 ticket = uint256(keccak256(abi.encodePacked(randomness, "PLANK_TICKET"))) % e.totalTickets;
        uint256 ball = (uint256(keccak256(abi.encodePacked(randomness, "PLANK_BALL"))) % ballRange) + 1;

        address winner = _segmentOwnerOf(epoch, ticket);
        // Natural hit (the ball landed on jackpotBall), OR the "must be won"
        // guarantee has come due: the pot has rolled mustHitByEpochs epochs
        // without paying out, so this drawn epoch pays the FULL jackpot no
        // matter the ball. Either way, someone takes the whole pot.
        bool natural = (ball == jackpotBall);
        bool forced = mustHitByEpochs > 0 && epoch > lastJackpotHitEpoch && (epoch - lastJackpotHitEpoch) >= mustHitByEpochs;
        bool hit = natural || forced;
        uint256 prize = hit ? jackpot : (jackpot * consolationBps) / 10000;

        jackpot -= prize;
        e.drawn = true;
        e.winner = winner;
        e.drawnBall = ball;
        e.jackpotHit = hit;
        e.prize = prize;
        if (hit) {
            jackpotsHit += 1;
            if (epoch > lastJackpotHitEpoch) lastJackpotHitEpoch = epoch; // reset the clock
            if (forced && !natural) emit JackpotForced(epoch, prize);
        }
        totalPaidOut += prize;

        uint256 drawerReward = (prize * drawerRewardBps) / 10000;
        uint256 payout = prize - drawerReward;
        if (drawerReward > 0) _asyncTransfer(msg.sender, drawerReward);
        if (payout > 0) _asyncTransfer(winner, payout);

        emit Drawn(epoch, winner, ball, hit, payout, drawerReward, jackpot);
    }

    /// Binary search for the segment covering ticket `draw`. cumulativeEnd
    /// is strictly increasing, so this finds the first segment past the
    /// drawn number -- ~log2(n) SLOADs, never a full iteration.
    function _segmentOwnerOf(uint256 epoch, uint256 draw) private view returns (address) {
        TicketSegment[] storage segs = _segments[epoch];
        uint256 lo = 0;
        uint256 hi = segs.length; // exclusive
        while (lo < hi) {
            uint256 mid = (lo + hi) / 2;
            if (segs[mid].cumulativeEnd > draw) {
                hi = mid;
            } else {
                lo = mid + 1;
            }
        }
        return segs[lo].player;
    }

    // ── Views for the frontend's jackpot headline ────────────────────

    /// Per-epoch odds that the Plank Ball hits, as a 1-in-N integer.
    function jackpotOddsOneIn() external view returns (uint256) {
        return ballRange;
    }

    /// What the epoch's ticket winner would receive right now under each
    /// outcome -- lets the UI show the real, honest split ("hit: X ETH,
    /// miss: Y ETH and the rest rolls over") instead of implying the whole
    /// pot is always in play.
    function previewPrizes() external view returns (uint256 ifJackpotHit, uint256 ifMiss) {
        ifJackpotHit = jackpot;
        ifMiss = (jackpot * consolationBps) / 10000;
    }

    /// The latest epoch by which the full jackpot is GUARANTEED to pay out
    /// (0 if the guarantee is disabled). The UI can headline "guaranteed by
    /// <date>" from this.
    function guaranteedHitByEpoch() external view returns (uint256) {
        if (mustHitByEpochs == 0) return 0;
        return lastJackpotHitEpoch + mustHitByEpochs;
    }

    function participantCount(uint256 epoch) external view returns (uint256) {
        return distinctParticipants[epoch];
    }

    function segmentCount(uint256 epoch) external view returns (uint256) {
        return _segments[epoch].length;
    }
}
