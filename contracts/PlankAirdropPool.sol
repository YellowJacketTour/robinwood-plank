// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ReentrancyGuard} from "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import {PullPayment} from "@openzeppelin/contracts/security/PullPayment.sol";
import {IDrandBeacon} from "./IDrandBeacon.sol";

/// The read surface any game contract already exposes for its own
/// pari-mutuel accounting -- PlankCrashV2/VRF/Entropy/Drand and
/// PlankDerby.sol all already have a public `stakeOf(roundId, player)`
/// mapping getter matching this exact shape, so none of them need any
/// code change to become a valid wager source here.
interface IWagerSource {
    function stakeOf(uint256 roundId, address player) external view returns (uint256);
}

/**
 * PlankAirdropPool -- a wager-weighted, verifiably-random ETH airdrop
 * funded by a configurable slice of the whole plank.love game family's
 * rake (see PlankRakeDistributor.sol), drawn using the same shared
 * DrandBeacon every other randomness-consuming contract in this protocol
 * already trusts (PlankCrashDrand.sol, MarketplankVaultV3.sol).
 *
 * WHAT THIS IS, SAID HONESTLY: not positive EV for any individual bet --
 * a rake-funded raffle is still funded by money extracted from the
 * player pool as a whole, not created from nothing. What it IS: a real,
 * precedented mechanic (wager-weighted raffles are a live, mainstream
 * pattern -- e.g. Stake.com's weekly raffle, Shuffle's weekly race) that
 * redistributes rake back among the community that generated it, instead
 * of it leaving to a disconnected treasury. Ticket weight is exactly
 * proportional to real, already-placed stake (claimTickets() reads it
 * directly from the source contract's own public state) -- nobody can
 * inflate their odds beyond what they actually wagered.
 *
 * WHY A FIXED SCHEDULE, NOT A SURPRISE TRIGGER -- A DELIBERATE,
 * RESEARCH-GROUNDED CHOICE: the addiction-psychology literature is
 * consistent that UNPREDICTABLE reward timing (variable-ratio
 * reinforcement) is the single strongest known driver of compulsive
 * engagement -- and a crash game already IS one such loop on its own.
 * Stacking a second reward mechanic with unpredictable draw timing on
 * top would compound that. Epochs here close on a fixed, publicly
 * computable schedule (epochDuration, genesisTimestamp -- currentEpoch()
 * is deterministic from block.timestamp alone), specifically so the
 * airdrop is a predictable, transparent bonus, not an added source of
 * compulsive uncertainty. This is a real design constraint, not
 * decoration -- do not "improve" this into a random-timing trigger.
 *
 * WHY THE DRAW IS AN O(n) WALK OVER AN EPOCH'S PARTICIPANTS, DISCLOSED
 * HONESTLY: on-chain weighted random selection over a dynamic, unbounded
 * set of participants has no O(1) primitive without a much heavier
 * structure (e.g. a Fenwick tree over ticket weights). This uses the
 * simple, standard, auditable pattern instead: a per-epoch participant
 * array appended once per new address, walked cumulatively at draw time
 * until the drawn ticket number is covered. Gas cost is real and scales
 * with distinct participants in that epoch -- bounded by epochDuration
 * being generous (daily+), not by any cap here. If a future epoch's
 * participant count ever makes this prohibitively expensive, that is a
 * real, disclosed limitation to revisit (e.g. a resumable/chunked draw),
 * not a silent failure: drawWinner() simply costs more gas, it does not
 * misbehave.
 */
contract PlankAirdropPool is ReentrancyGuard, PullPayment {
    IDrandBeacon public immutable beacon;
    uint256 public immutable genesisTimestamp;
    uint256 public immutable epochDuration;
    // Small, fixed share of an epoch's pool paid to whoever calls
    // drawWinner() once it's ready -- same keeper-incentive shape used
    // throughout this protocol (see PlankCrashV2.sol's keeperRewardBps).
    uint256 public immutable drawerRewardBps;
    // Real safety margin, in whole drand rounds, matching
    // PlankCrashDrand.sol's own TARGET_ROUND_SAFETY_PERIODS reasoning --
    // see that file's comment for the full writeup (Orbit sequencer
    // timestamp-jump risk).
    uint256 private constant DRAW_ROUND_SAFETY_PERIODS = 20;

    mapping(address => bool) public isAllowedSource;

    struct Epoch {
        uint256 pool;
        uint256 totalTickets;
        uint64 targetDrandRound;
        bool drawRequested;
        bool drawn;
        address winner;
    }

    mapping(uint256 => Epoch) public epochs;
    mapping(uint256 => address[]) private _participants;
    mapping(uint256 => mapping(address => uint256)) public ticketsOf;
    mapping(uint256 => mapping(address => bool)) private _hasParticipated;
    // (source, sourceRoundId, player) -> claimed. Prevents the same real
    // bet from ever being credited as tickets more than once.
    mapping(bytes32 => bool) public ticketsClaimed;

    event Funded(uint256 indexed epoch, uint256 amount);
    event TicketsClaimed(
        uint256 indexed epoch,
        address indexed source,
        uint256 sourceRoundId,
        address indexed player,
        uint256 amount
    );
    event DrawRequested(uint256 indexed epoch, uint64 targetDrandRound);
    event WinnerDrawn(uint256 indexed epoch, address indexed winner, uint256 payout, uint256 drawerReward);
    event EpochVoided(uint256 indexed epoch, uint256 rolledOverPool, string reason);

    error ZeroAddress();
    error UnknownSource();
    error NoStake();
    error AlreadyClaimed();
    error EpochNotClosed();
    error EpochAlreadyDrawn();
    error DrawNotYetRequested();
    error DrawAlreadyRequested();
    error RandomnessNotYetAvailable();
    error NoTickets();
    error EpochNotYetDrawable();

    constructor(
        address beacon_,
        address[] memory allowedSources_,
        uint256 genesisTimestamp_,
        uint256 epochDuration_,
        uint256 drawerRewardBps_
    ) {
        if (beacon_ == address(0)) revert ZeroAddress();
        beacon = IDrandBeacon(beacon_);
        genesisTimestamp = genesisTimestamp_;
        epochDuration = epochDuration_;
        drawerRewardBps = drawerRewardBps_;
        for (uint256 i = 0; i < allowedSources_.length; i++) {
            if (allowedSources_[i] == address(0)) revert ZeroAddress();
            isAllowedSource[allowedSources_[i]] = true;
        }
    }

    function currentEpoch() public view returns (uint256) {
        if (block.timestamp < genesisTimestamp) return 0;
        return (block.timestamp - genesisTimestamp) / epochDuration;
    }

    function _epochEndsAt(uint256 epoch) private view returns (uint256) {
        return genesisTimestamp + (epoch + 1) * epochDuration;
    }

    /// Called by PlankRakeDistributor.sol (or anyone -- there is no
    /// reason to gate funding a community pot). Funds always land in the
    /// CURRENT epoch, so rake generated during an epoch pays out to that
    /// same epoch's bettors.
    function fund() external payable {
        uint256 epoch = currentEpoch();
        epochs[epoch].pool += msg.value;
        emit Funded(epoch, msg.value);
    }

    /// Permissionless: credits `player` real, wager-weighted tickets for
    /// a bet they ALREADY placed on `source`, by reading `source`'s own
    /// public, already-on-chain stakeOf(sourceRoundId, player) -- not
    /// trusted input from the caller. `source` MUST be on the immutable
    /// allowlist set at construction: without that gate, anyone could
    /// deploy a trivial contract whose stakeOf() always returns a huge
    /// number and claim unlimited tickets for themselves. The
    /// (source, sourceRoundId, player) claim guard means the same real
    /// bet can only ever be credited once, so nobody can re-claim it
    /// repeatedly to inflate their odds.
    function claimTickets(address source, uint256 sourceRoundId, address player) external {
        if (!isAllowedSource[source]) revert UnknownSource();
        uint256 amount = IWagerSource(source).stakeOf(sourceRoundId, player);
        if (amount == 0) revert NoStake();

        bytes32 claimId = keccak256(abi.encodePacked(source, sourceRoundId, player));
        if (ticketsClaimed[claimId]) revert AlreadyClaimed();
        ticketsClaimed[claimId] = true;

        uint256 epoch = currentEpoch();
        if (!_hasParticipated[epoch][player]) {
            _hasParticipated[epoch][player] = true;
            _participants[epoch].push(player);
        }
        ticketsOf[epoch][player] += amount;
        epochs[epoch].totalTickets += amount;
        emit TicketsClaimed(epoch, source, sourceRoundId, player, amount);
    }

    /// Permissionless, callable once an epoch has genuinely closed.
    /// Commits the draw to a specific future drand round, exactly
    /// mirroring PlankCrashDrand.sol's lockRound() -- see its own
    /// comments for why the safety margin exists.
    function requestDraw(uint256 epoch) external {
        if (block.timestamp < _epochEndsAt(epoch)) revert EpochNotClosed();
        Epoch storage e = epochs[epoch];
        if (e.drawRequested) revert DrawAlreadyRequested();
        e.drawRequested = true;
        e.targetDrandRound = beacon.nextRoundAfter(block.timestamp) + uint64(DRAW_ROUND_SAFETY_PERIODS);
        emit DrawRequested(epoch, e.targetDrandRound);
    }

    /// Permissionless. Reads the shared beacon's already-verified
    /// randomness for the committed round and performs the weighted
    /// draw -- see this file's header for the real, disclosed O(n) cost
    /// of the walk. An epoch with zero tickets is voided (its pool rolls
    /// forward into the NEXT epoch's pool rather than being stranded),
    /// exactly mirroring the crash games' own under-threshold void +
    /// carry-forward pattern.
    function drawWinner(uint256 epoch) external nonReentrant {
        Epoch storage e = epochs[epoch];
        if (!e.drawRequested) revert DrawNotYetRequested();
        if (e.drawn) revert EpochAlreadyDrawn();

        if (e.totalTickets == 0) {
            e.drawn = true;
            uint256 rolled = e.pool;
            e.pool = 0;
            epochs[epoch + 1].pool += rolled;
            emit EpochVoided(epoch, rolled, "no-participants");
            return;
        }

        bytes32 randomness = beacon.randomnessOrZero(e.targetDrandRound);
        if (randomness == bytes32(0)) revert RandomnessNotYetAvailable();

        uint256 draw = uint256(randomness) % e.totalTickets;
        address[] storage participants = _participants[epoch];
        address winner = participants[participants.length - 1];
        uint256 cumulative = 0;
        for (uint256 i = 0; i < participants.length; i++) {
            cumulative += ticketsOf[epoch][participants[i]];
            if (draw < cumulative) {
                winner = participants[i];
                break;
            }
        }

        e.drawn = true;
        e.winner = winner;

        uint256 drawerReward = (e.pool * drawerRewardBps) / 10000;
        uint256 payout = e.pool - drawerReward;
        if (drawerReward > 0) _asyncTransfer(msg.sender, drawerReward);
        if (payout > 0) _asyncTransfer(winner, payout);

        emit WinnerDrawn(epoch, winner, payout, drawerReward);
    }

    function participantCount(uint256 epoch) external view returns (uint256) {
        return _participants[epoch].length;
    }
}
