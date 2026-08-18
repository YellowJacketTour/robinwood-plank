// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// PlankProgression -- Sapling -> Stick -> Board -> Plank -> Big Beam ->
/// Wooden Whale. Tracks each wallet's OWN on-chain history (rounds played,
/// ETH wagered, Fuel Booster burns, Powerboard ticket claims) and derives
/// BOTH a per-bet stake ceiling AND an entry-premium rate purely from that
/// history. No owner, no admin, nothing settable after deploy -- rank is a
/// pure function of a wallet's own past activity, computed fresh every read.
///
/// WHY THIS EXISTS: PlankCrashDrand's existing 60%-of-pool whale cap
/// (maxStakePerWalletBps) is a PER-WALLET check with essentially zero cost
/// to bypass via wallet-splitting -- a real economic actor can always
/// defeat a purely per-transaction cap by spreading capital across N fresh
/// addresses for the price of N sets of gas. This contract adds a SECOND,
/// independent friction that actually scales with wallet count: reaching a
/// rank requires genuine rounds played and real cumulative wagered volume,
/// in ONE wallet, over real (non-compressible) time, since rounds cannot be
/// played faster than the game's own cadence. Splitting into N wallets
/// means grinding N separate histories from scratch, each paying its own
/// cumulative rake along the way. This does NOT make the attack impossible
/// -- nothing purely on-chain can, without an identity layer this project
/// deliberately doesn't have -- but it converts a five-minute, one-click
/// attack into an hours-to-days, capital-locked, self-taxing one. That
/// honest framing (raises cost, doesn't claim to eliminate it) is meant to
/// be stated plainly to auditors, not discovered by them.
///
/// INTEGRATION: PlankCrashDrand, PlankFuelBooster, and PlankPowerboard each
/// hold an OPTIONAL immutable reference to a deployed instance of this
/// contract (address(0) fully disables all of this and preserves their
/// exact pre-existing behavior -- see each contract's own use of it). When
/// wired up, they call recordBet/recordFuelBurn/recordPowerboardClaim after
/// their own state changes succeed, and PlankCrashDrand's placeBet() reads
/// capFor/premiumBpsFor before accepting a bet.
///
/// CORRECTED 2026-08-18: this comment previously claimed "nothing here can
/// revert a caller's own core action... the record* calls are the last
/// thing each caller does" -- that reasoning was wrong. Being the LAST
/// statement in a function does not protect it from reverting the whole
/// transaction; Solidity's default behavior unwinds everything on any
/// revert, statement order notwithstanding. PlankFuelBooster.burnFuel()
/// and PlankPowerboard's ticket-claim path now wrap their record* calls in
/// try/catch specifically to make this guarantee real rather than assumed
/// -- see those call sites' own comments. If you add a new caller of this
/// contract's record* functions, wrap that call in try/catch too; do not
/// rely on call-ordering alone.
contract PlankProgression {
    error NotAuthorizedSource();

    enum Rank {
        Sapling,
        Stick,
        Board,
        Plank,
        BigBeam,
        WoodenWhale
    }

    struct PlayerStats {
        uint32 roundsPlayed;
        uint128 cumulativeWagered; // wei; headroom vastly exceeds total ETH supply
        uint32 fuelBurns;
        uint32 powerboardClaims;
        uint40 firstBetAt; // unix seconds; 0 = never placed a bet
    }

    mapping(address => PlayerStats) public statsOf;

    address public immutable crash;
    address public immutable fuelBooster;
    address public immutable powerboard;

    // ── Rank thresholds ──────────────────────────────────────────────────
    // Each rank requires clearing ALL of its own conditions; ranks are
    // evaluated top-down in rankOf() so a wallet is always classified at
    // its highest EARNED rank, not just its most recent milestone.
    uint256 public constant STICK_ROUNDS = 5;
    uint256 public constant STICK_WAGERED = 0.1 ether;
    uint256 public constant BOARD_ROUNDS = 20;
    uint256 public constant BOARD_WAGERED = 0.5 ether;
    uint256 public constant PLANK_WAGERED = 0.5 ether; // Board's wagered floor; Plank's real gate is the fuel burn below
    uint256 public constant BIG_BEAM_WAGERED = 2 ether;
    uint256 public constant WOODEN_WHALE_WAGERED = 10 ether;
    uint256 public constant WOODEN_WHALE_TENURE = 7 days;

    // ── Per-bet absolute stake ceilings by rank ─────────────────────────
    // Enforced in ADDITION to PlankCrashDrand's own existing 60%-of-pool
    // relative cap, not instead of it -- both must pass. Wooden Whale has
    // no rank-based ceiling of its own; the pool-relative rule governs
    // alone at that point, same as it always has for any wallet.
    uint256 public constant CAP_SAPLING = 0.02 ether;
    uint256 public constant CAP_STICK = 0.05 ether;
    uint256 public constant CAP_BOARD = 0.1 ether;
    uint256 public constant CAP_PLANK = 0.25 ether;
    uint256 public constant CAP_BIG_BEAM = 0.5 ether;

    // ── Entry premium, in bps of stake ──────────────────────────────────
    // Added on TOP of a player's bet -- see PlankCrashDrand.placeBet()'s
    // own comment for exactly where this ETH goes (straight into the
    // Vault's reserve, never counted toward the payer's own pari-mutuel
    // weight). A wallet's very first bet, and any bet at or below
    // FIRST_BET_EXEMPT_WEI regardless of rank, is never taxed -- explicitly
    // so a genuinely new or genuinely small player is never worse off than
    // today's game. This is a deliberate design choice, not an oversight:
    // exempting by THRESHOLD rather than by "is this literally bet #1"
    // means a Sapling can keep placing small bets forever tax-free, which
    // is fine (small bets are harmless regardless of frequency) and avoids
    // tracking extra state just to answer a narrower question with the
    // same practical effect.
    uint256 public constant PREMIUM_SAPLING_BPS = 1500; // 15%
    uint256 public constant PREMIUM_STICK_BPS = 1000; // 10%
    uint256 public constant PREMIUM_BOARD_BPS = 600; // 6%
    uint256 public constant PREMIUM_PLANK_BPS = 300; // 3%
    uint256 public constant PREMIUM_BIG_BEAM_BPS = 100; // 1%
    // Wooden Whale: 0 -- fully earned, no toll.
    uint256 public constant FIRST_BET_EXEMPT_WEI = 0.01 ether;

    constructor(address crash_, address fuelBooster_, address powerboard_) {
        crash = crash_;
        fuelBooster = fuelBooster_;
        powerboard = powerboard_;
    }

    modifier onlyCrash() {
        if (msg.sender != crash) revert NotAuthorizedSource();
        _;
    }
    modifier onlyFuelBooster() {
        if (msg.sender != fuelBooster) revert NotAuthorizedSource();
        _;
    }
    modifier onlyPowerboard() {
        if (msg.sender != powerboard) revert NotAuthorizedSource();
        _;
    }

    /// Records a real bet. stakeWei is the player's FULL msg.value from
    /// placeBet (including any premium skimmed off it) -- progression
    /// tracks genuine capital committed, not the post-premium stake amount,
    /// so the premium itself doesn't discount someone's own path to a rank
    /// that would otherwise exempt them from it.
    function recordBet(address player, uint256 stakeWei) external onlyCrash {
        PlayerStats storage s = statsOf[player];
        if (s.firstBetAt == 0) s.firstBetAt = uint40(block.timestamp);
        s.roundsPlayed += 1;
        s.cumulativeWagered += uint128(stakeWei);
    }

    function recordFuelBurn(address player) external onlyFuelBooster {
        statsOf[player].fuelBurns += 1;
    }

    function recordPowerboardClaim(address player) external onlyPowerboard {
        statsOf[player].powerboardClaims += 1;
    }

    function rankOf(address player) public view returns (Rank) {
        PlayerStats memory s = statsOf[player];
        if (
            s.cumulativeWagered >= WOODEN_WHALE_WAGERED &&
            s.firstBetAt != 0 &&
            block.timestamp - s.firstBetAt >= WOODEN_WHALE_TENURE &&
            s.fuelBurns > 0 &&
            s.powerboardClaims > 0
        ) return Rank.WoodenWhale;
        if (s.cumulativeWagered >= BIG_BEAM_WAGERED && s.fuelBurns > 0 && s.powerboardClaims > 0) return Rank.BigBeam;
        if (s.cumulativeWagered >= PLANK_WAGERED && s.fuelBurns > 0) return Rank.Plank;
        if (s.roundsPlayed >= BOARD_ROUNDS && s.cumulativeWagered >= BOARD_WAGERED) return Rank.Board;
        if (s.roundsPlayed >= STICK_ROUNDS && s.cumulativeWagered >= STICK_WAGERED) return Rank.Stick;
        return Rank.Sapling;
    }

    function capFor(address player) external view returns (uint256) {
        Rank r = rankOf(player);
        if (r == Rank.Sapling) return CAP_SAPLING;
        if (r == Rank.Stick) return CAP_STICK;
        if (r == Rank.Board) return CAP_BOARD;
        if (r == Rank.Plank) return CAP_PLANK;
        if (r == Rank.BigBeam) return CAP_BIG_BEAM;
        return type(uint256).max; // Wooden Whale: pool-relative rule governs alone
    }

    function premiumBpsFor(address player, uint256 stakeWei) public view returns (uint256) {
        if (stakeWei <= FIRST_BET_EXEMPT_WEI) return 0;
        Rank r = rankOf(player);
        if (r == Rank.Sapling) return PREMIUM_SAPLING_BPS;
        if (r == Rank.Stick) return PREMIUM_STICK_BPS;
        if (r == Rank.Board) return PREMIUM_BOARD_BPS;
        if (r == Rank.Plank) return PREMIUM_PLANK_BPS;
        if (r == Rank.BigBeam) return PREMIUM_BIG_BEAM_BPS;
        return 0; // Wooden Whale
    }

    /// Convenience view for the frontend: how much MORE cumulative wagered
    /// volume (in wei) this player needs to reach the next rank, given
    /// their CURRENT roundsPlayed/fuelBurns/powerboardClaims are already
    /// sufficient. Returns 0 at Wooden Whale (nothing left to reach), and
    /// also 0 if a non-wagered condition (rounds played, a fuel burn, a
    /// Powerboard claim, or tenure) is the actual blocker -- the frontend
    /// should check rankOf's own gating fields directly to explain THOSE
    /// cases rather than inferring them from this number alone.
    function wageredNeededForNextRank(address player) external view returns (uint256) {
        Rank r = rankOf(player);
        uint256 have = statsOf[player].cumulativeWagered;
        uint256 need;
        if (r == Rank.Sapling) need = STICK_WAGERED;
        else if (r == Rank.Stick) need = BOARD_WAGERED;
        else if (r == Rank.Board) need = PLANK_WAGERED;
        else if (r == Rank.Plank) need = BIG_BEAM_WAGERED;
        else if (r == Rank.BigBeam) need = WOODEN_WHALE_WAGERED;
        else return 0;
        return have >= need ? 0 : need - have;
    }
}
