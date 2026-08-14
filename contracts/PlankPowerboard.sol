// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ReentrancyGuard} from "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import {PullPayment} from "@openzeppelin/contracts/security/PullPayment.sol";
import {IDrandBeacon} from "./IDrandBeacon.sol";

/// The read surface every plank.love game already exposes for its own
/// pari-mutuel accounting -- PlankCrashV2/VRF/Entropy/Drand and
/// PlankDerby.sol all already have a public `stakeOf(roundId, player)`
/// getter matching this exact shape, so any of them can become a ticket
/// source with NO code change.
interface IWagerSource {
    function stakeOf(uint256 roundId, address player) external view returns (uint256);
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
 *     (consolationBps of the pot) and THE REST ROLLS OVER, so the jackpot
 *     is strictly bigger next epoch.
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

    /// The rolling jackpot. Grows with every rake deposit and every miss.
    uint256 public jackpot;
    uint256 public totalPaidOut;
    uint256 public jackpotsHit;

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

    error ZeroAddress();
    error BadConfig();
    error UnknownSource();
    error NoStake();
    error AlreadyClaimed();
    error EpochNotClosed();
    error EpochAlreadyDrawn();
    error DrawNotYetRequested();
    error DrawAlreadyRequested();
    error RandomnessNotYetAvailable();

    struct Config {
        address beacon;
        address[] allowedSources;
        uint256 genesisTimestamp;
        uint256 epochDuration;
        uint256 drawerRewardBps;
        uint256 ballRange;
        uint256 jackpotBall;
        uint256 consolationBps;
    }

    constructor(Config memory cfg) {
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
        for (uint256 i = 0; i < cfg.allowedSources.length; i++) {
            if (cfg.allowedSources[i] == address(0)) revert ZeroAddress();
            isAllowedSource[cfg.allowedSources[i]] = true;
        }
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
    }

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
        bool hit = (ball == jackpotBall);
        uint256 prize = hit ? jackpot : (jackpot * consolationBps) / 10000;

        jackpot -= prize;
        e.drawn = true;
        e.winner = winner;
        e.drawnBall = ball;
        e.jackpotHit = hit;
        e.prize = prize;
        if (hit) jackpotsHit += 1;
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

    function participantCount(uint256 epoch) external view returns (uint256) {
        return distinctParticipants[epoch];
    }

    function segmentCount(uint256 epoch) external view returns (uint256) {
        return _segments[epoch].length;
    }
}
