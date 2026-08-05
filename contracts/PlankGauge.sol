// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * ============================================================================
 *  PlankGauge — burn-directed gauge weight, "market easy mode"
 *
 *  NOT FOR DEPLOYMENT. Same gate as GlobalIndexVault.sol: nothing in this repo
 *  may put either contract on any network until the external audit of
 *  SPEC-PLANK-CHECKS-AND-INDEX.md §2.6 clears. hardhat.config.ts has no default
 *  network on purpose; keep it that way.
 *
 *  WHY THIS REPLACED vePLANK
 *  -------------------------
 *  The first cut of this layer was a Curve-style vote-escrow contract: lock
 *  PLANK, get linearly-decaying voting power, re-vote every epoch. That design
 *  is real and it works, but it is genuinely complex — checkpoint bookkeeping,
 *  historical-weight lookups (`balanceOfAt`), lock-extension edge cases — and
 *  it has been a repeat source of bugs even in Curve's own mature code, where
 *  the invariants are famously hard to state, let alone test. It also buys
 *  governance complexity rather than the two things the ecosystem actually
 *  needs: durable buy pressure on PLANK and deeper liquidity where the index
 *  trades.
 *
 *  So the mechanism here is deliberately dumber and more mechanically aligned:
 *  you do not RENT gauge direction with a lock you get back, you BUY it by
 *  permanently destroying something. Three burn paths, one accumulator each,
 *  no epochs, no decay, no historical lookups, no unlock schedule, and nothing
 *  that has to be re-voted to stay alive.
 *
 *  THE THREE BURN PATHS AND THEIR MULTIPLIERS
 *  ------------------------------------------
 *  Weight credited = amount * multiplier.
 *
 *    burnPlank                1.0x  baseline. Destroys token count.
 *    burnPlankEthLp           2.5x  destroys a PAIRED position: PLANK *and*
 *                                   the ETH sitting against it. It is not a
 *                                   larger number of the same thing, it is a
 *                                   permanent removal of two-sided depth from
 *                                   circulation — the LP can never be pulled
 *                                   back out and dumped. 2.5x rather than a
 *                                   round 2x because an LP unit at parity is
 *                                   worth ~2x its PLANK leg alone, and the
 *                                   half-step on top prices the permanence:
 *                                   burnt LP keeps backing the pool forever,
 *                                   raw burnt PLANK backs nothing.
 *    burnCollectionLp         3.0x  same permanence argument, but the depth it
 *                                   locks is the EXACT market the gauge vote
 *                                   is asking to support (that collection's
 *                                   v-token pool). Directing weight at a
 *                                   collection while simultaneously deepening
 *                                   that collection's own book is strictly a
 *                                   larger contribution than deepening an
 *                                   unrelated one, so it gets the top rate.
 *
 *  Those are the DEFAULTS. All three are timelocked-admin parameters bounded
 *  by compile-time ceilings (see MAX_MULTIPLIER_BPS): governance can retune
 *  the ratio, and no governance can make any path a 100x printing press.
 *
 *  HOW A BURN IS PERFORMED, HONESTLY
 *  ---------------------------------
 *  Every path moves the token to the canonical dead address
 *  0x...dEaD via `transferFrom`, and credits the ACTUAL observed balance delta
 *  at the dead address, never the nominal amount. It does NOT call a `burn()`
 *  on the token. That is a deliberate choice, checked against what this repo
 *  actually has: MockIndexToken/MockWeth (contracts/test/) are plain
 *  OpenZeppelin ERC-20s with no public `burn`, MarketplankVaultV3's v-token
 *  likewise exposes no external burn, and a Uniswap-V2-style LP token's `burn`
 *  is not a supply burn at all — it is "redeem this LP for the underlying",
 *  which would hand the liquidity BACK rather than destroy it. Calling
 *  `burn()` on an LP token would therefore be exactly wrong. Transfer-to-dead
 *  is the one mechanism that is correct for all three token types, needs no
 *  interface the token might not have, and is verifiable by anyone with an
 *  explorer.
 *
 *  CLAIMS ARE SOULBOUND, AND WHAT THAT COSTS
 *  -----------------------------------------
 *  `claimantWeightedBurns[gauge][who]` is internal accounting, not a token.
 *  There is no transfer, no approve, no ERC-20 or ERC-721 surface over it, and
 *  no admin path to move one address's balance to another.
 *
 *  Why: a transferable burn receipt is a wash-burn engine. Burn, sell the
 *  receipt to someone who wants gauge direction, buy back cheaper, repeat —
 *  the burn stops being a cost and becomes a round trip, which is the exact
 *  property that made the burn meaningful in the first place. Soulbound means
 *  the only way to hold a claim is to have paid for it yourself.
 *
 *  The tradeoff is real and worth stating in the same breath (same discipline
 *  as GlobalIndexVault's rounding-doctrine and oracle notes): claims are
 *  illiquid and un-composable. You cannot borrow against one, you cannot sell
 *  your position if you change your mind, and a lost key is a permanently lost
 *  claim with no recovery path — there is no admin reissue, by design, because
 *  an admin reissue is an admin mint. We accept illiquidity to buy
 *  un-gameability.
 *
 *  REWARDS ARE PUSH-ONLY. THIS CONTRACT PULLS FROM NOTHING.
 *  -------------------------------------------------------
 *  `receiveRewards(gauge)` is payable and permissionless: anyone may push ETH
 *  earmarked for a gauge's claimants. In practice the caller is the same
 *  off-chain, cron-driven fee flow that already routes marketplace revenue to
 *  MARKET_FEE_RECIPIENT (lib/constants.ts) — this contract is just another
 *  destination that pattern can pay, and it deliberately mirrors that shape
 *  rather than inventing an on-chain router.
 *
 *  There is NO function here that reaches into GlobalIndexVault, any
 *  MarketplankVault, or any other pool. No vault address is stored, none is
 *  accepted as an argument, none appears in this bytecode. GlobalIndexVault's
 *  anchor guarantee #4 ("no role ever has a withdrawal path over pooled
 *  reserves") therefore remains true for exactly the reason it was true
 *  before: the lever does not exist, so there is nothing to guard.
 *  PlankGauge.audit.test.ts enumerates this contract's ABI and bytecode and
 *  proves it, in the same style as the vault's own anchor-rule test.
 *
 *  THRESHOLD-ACCUMULATE, NOT DUST-DISTRIBUTE
 *  -----------------------------------------
 *  Pushed rewards sit in `pendingRewards[gauge]` until they clear
 *  `distributionThresholdWei` (one global, timelocked parameter — per-gauge
 *  thresholds were considered and rejected: they are N more values to get
 *  wrong, and the cost they exist to clear, a claim's gas, is a property of
 *  the chain, not of the gauge). On crossing, `distribute()` — permissionless,
 *  and also called automatically at the head of `claim()` — folds the pending
 *  pot into a per-weight accumulator and claimants can draw it.
 *
 *  Below threshold nothing reverts and nothing is lost. Funds accumulate for
 *  next time and `gaugeStatus()` reports (accumulated, threshold, claimable)
 *  as an honest queryable state. This is Yearn's `harvestTrigger()` /
 *  Curve's fee-burner pattern: a public view that says "not yet", polled off
 *  chain, rather than a calendar that forces an uneconomic payout.
 *
 *  DILUTION SEMANTICS
 *  ------------------
 *  A claimant's share of a distribution is
 *  `claimantWeightedBurns[gauge][who] / totalWeightedBurns[gauge]` measured at
 *  the moment that pot is FOLDED, exactly like an LP pool share. Later burners
 *  therefore dilute earlier ones proportionally over all future revenue, which
 *  is the intended incentive (an early burn is not a perpetual tax on
 *  latecomers). What a later burn cannot do is claw back a pot that was
 *  already folded — that would be a retroactive rewrite of someone else's
 *  settled balance, and it is what the per-claimant accumulator checkpoint
 *  prevents. Anyone can force a fold at any time by calling `distribute()`
 *  once the threshold is clear, so "fold time" is not an admin-controlled
 *  moment.
 * ============================================================================
 */

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

contract PlankGauge is ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice Generation marker so the client never has to sniff bytecode.
    uint256 public constant GAUGE_VERSION = 1;

    uint256 private constant BPS = 10_000;
    uint256 private constant WAD = 1e18;

    /// @notice Where every burn actually goes. Same constant the vault uses
    /// for its locked seed, and the same one-way property.
    address public constant BURN_ADDRESS = 0x000000000000000000000000000000000000dEaD;

    // ── Hard, contract-level ceilings ──────────────────────────────────────
    // Mirrors GlobalIndexVault's doctrine exactly: a timelock bounds WHEN a bad
    // change lands, never HOW BAD it can be. Compile-time constants — no admin,
    // no timelock, and no future governance can raise them.
    uint256 private constant MIN_TIMELOCK_DELAY = 48 hours;
    uint256 private constant MAX_TIMELOCK_DELAY = 30 days;
    uint256 private constant MIN_MULTIPLIER_BPS = BPS; // never below 1.0x
    uint256 private constant MAX_MULTIPLIER_BPS = 5 * BPS; // never above 5.0x
    uint256 private constant MAX_DISTRIBUTION_THRESHOLD_WEI = 100 ether;

    /// @dev Burn paths, in the order their multipliers are stored.
    uint8 public constant PATH_RAW = 0;
    uint8 public constant PATH_PLANK_ETH_LP = 1;
    uint8 public constant PATH_COLLECTION_LP = 2;

    // ── Storage ────────────────────────────────────────────────────────────

    /// @notice The PLANK token. Immutable — a mutable burn target is a mutable
    /// definition of what the whole accounting means.
    IERC20 public immutable plank;

    /// @notice Timelock delay, fixed at deploy. Not itself changeable, for the
    /// same reason the vault's is not: a mutable delay can be set to zero.
    uint256 public immutable timelockDelay;

    /// @notice Sets FUTURE parameters only. Has no path to any burn, any
    /// claim balance, or any pushed reward.
    address public admin;

    /// @notice bps multiplier per burn path, indexed by PATH_*.
    uint256[3] public multiplierBps;

    /// @notice Global minimum pot before a gauge's rewards become claimable.
    uint256 public distributionThresholdWei;

    /// @notice Registered gauges. A gauge id is a constituent identifier — in
    /// practice the collection's v-token address, the same key
    /// lib/market/vault-registry.ts resolves vaults by.
    mapping(address => bool) public gaugeRegistered;
    address[] private gaugeList;

    /// @notice Allowlisted PLANK/ETH LP tokens (the approved DEX pair
    /// contracts). An arbitrary ERC-20 claiming to be an LP token is never
    /// trusted — the address itself is the credential.
    mapping(address => bool) public approvedPlankEthLp;

    /// @notice Allowlisted collection v-token LP token, keyed to the gauge it
    /// deepens. Registering it requires naming the real vault address it
    /// belongs to, so the pairing is explicit on-chain and auditable.
    mapping(address => address) public collectionLpOf; // gauge => LP token
    mapping(address => address) public collectionVaultOf; // gauge => vault

    // ── Burn accounting (the whole mechanism) ──────────────────────────────

    mapping(address => uint256) public totalWeightedBurns; // gauge => weight
    mapping(address => mapping(address => uint256)) public claimantWeightedBurns;

    // ── Reward accounting ──────────────────────────────────────────────────

    mapping(address => uint256) public pendingRewards; // gauge => wei, un-folded
    mapping(address => uint256) public rewardPerWeight; // gauge => wei*WAD/weight
    mapping(address => mapping(address => uint256)) private paidPerWeight;
    mapping(address => mapping(address => uint256)) public owedRewards;

    // ── Timelock queues (identical shape to GlobalIndexVault) ──────────────

    struct QueuedParam {
        uint256 value;
        uint64 eta;
        bool pending;
    }

    struct QueuedAllowlist {
        address token;
        address vault; // only meaningful for collection LP registrations
        uint64 eta;
        bool pending;
        bool isRemoval;
    }

    mapping(bytes32 => QueuedParam) public queuedParams;
    mapping(bytes32 => QueuedAllowlist) public queuedAllowlists;
    QueuedParam public queuedAdmin;

    // ── Events ─────────────────────────────────────────────────────────────

    event Burned(
        address indexed gauge,
        address indexed claimant,
        uint8 indexed path,
        address token,
        uint256 amount,
        uint256 weight
    );
    event RewardsReceived(address indexed gauge, address indexed from, uint256 amount);
    event RewardsDistributed(address indexed gauge, uint256 amount, uint256 totalWeight);
    event Claimed(address indexed gauge, address indexed claimant, uint256 amount);
    event ParamQueued(bytes32 indexed key, uint256 value, uint64 eta);
    event ParamApplied(bytes32 indexed key, uint256 value);
    event AllowlistQueued(bytes32 indexed key, address token, uint64 eta, bool removal);
    event GaugeRegistered(address indexed gauge);
    event GaugeUnregistered(address indexed gauge);
    event PlankEthLpApproved(address indexed token, bool approved);
    event CollectionLpApproved(address indexed gauge, address token, address vault);
    event AdminQueued(address indexed next, uint64 eta);
    event AdminApplied(address indexed next);

    // ── Errors ─────────────────────────────────────────────────────────────

    error NotAdmin();
    error BadParam();
    error NothingQueued();
    error TimelockNotElapsed();
    error ZeroAmount();
    error UnknownGauge();
    error GaugeAlreadyRegistered();
    error NotApprovedLp();
    error NoClaim();
    error BelowThreshold();
    error TransferFailed();
    error ShortBurn();

    // ── Construction ───────────────────────────────────────────────────────

    constructor(
        IERC20 plank_,
        address admin_,
        uint256 timelockDelay_,
        uint256[3] memory multiplierBps_,
        uint256 distributionThresholdWei_
    ) {
        if (address(plank_) == address(0) || admin_ == address(0)) revert BadParam();
        if (timelockDelay_ < MIN_TIMELOCK_DELAY || timelockDelay_ > MAX_TIMELOCK_DELAY) {
            revert BadParam();
        }
        for (uint256 i = 0; i < 3; i++) _validateMultiplier(multiplierBps_[i]);
        // Ordering is part of the design, not an accident: LP burns must never
        // be worth less than the raw burn they strictly dominate.
        if (multiplierBps_[PATH_PLANK_ETH_LP] < multiplierBps_[PATH_RAW]) revert BadParam();
        if (multiplierBps_[PATH_COLLECTION_LP] < multiplierBps_[PATH_PLANK_ETH_LP]) {
            revert BadParam();
        }
        if (distributionThresholdWei_ > MAX_DISTRIBUTION_THRESHOLD_WEI) revert BadParam();

        plank = plank_;
        admin = admin_;
        timelockDelay = timelockDelay_;
        multiplierBps = multiplierBps_;
        distributionThresholdWei = distributionThresholdWei_;
    }

    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAdmin();
        _;
    }

    // ══ Burn paths ════════════════════════════════════════════════════════

    /// @notice Burn raw PLANK toward `gauge`. Baseline weight.
    function burnPlank(address gauge, uint256 amount)
        external
        nonReentrant
        returns (uint256 weight)
    {
        return _burnFor(gauge, address(plank), amount, PATH_RAW);
    }

    /**
     * @notice Burn an APPROVED PLANK/ETH LP token toward `gauge`.
     * @dev `lpToken` is checked against the allowlist, never sniffed. A token
     * that merely claims to be a PLANK/ETH pair — same name, same symbol,
     * same `token0()`/`token1()` answers — earns nothing here. This is the
     * same lesson lib/constants.ts records for MARKET_OFFER_CURRENCY: at
     * least three impostor contracts on the target chain report the symbol
     * "WETH", so an address allowlist is the only credential worth having.
     */
    function burnPlankEthLp(address gauge, address lpToken, uint256 amount)
        external
        nonReentrant
        returns (uint256 weight)
    {
        if (!approvedPlankEthLp[lpToken]) revert NotApprovedLp();
        return _burnFor(gauge, lpToken, amount, PATH_PLANK_ETH_LP);
    }

    /**
     * @notice Burn the APPROVED v-token LP for `gauge`'s own collection.
     * @dev The allowlist is keyed to the gauge, so this path cannot be used to
     * point one collection's liquidity burn at a different collection's gauge.
     */
    function burnCollectionLp(address gauge, uint256 amount)
        external
        nonReentrant
        returns (uint256 weight)
    {
        address lp = collectionLpOf[gauge];
        if (lp == address(0)) revert NotApprovedLp();
        return _burnFor(gauge, lp, amount, PATH_COLLECTION_LP);
    }

    function _burnFor(address gauge, address token, uint256 amount, uint8 path)
        private
        returns (uint256 weight)
    {
        if (!gaugeRegistered[gauge]) revert UnknownGauge();
        if (amount == 0) revert ZeroAmount();

        // Credit the ACTUAL delta at the dead address, never the nominal
        // amount — same Balancer-STA discipline GlobalIndexVault._pullCredited
        // applies. A fee-on-transfer token would otherwise buy weight it never
        // destroyed.
        uint256 before = IERC20(token).balanceOf(BURN_ADDRESS);
        IERC20(token).safeTransferFrom(msg.sender, BURN_ADDRESS, amount);
        uint256 burned = IERC20(token).balanceOf(BURN_ADDRESS) - before;
        if (burned == 0) revert ZeroAmount();
        if (burned > amount) revert ShortBurn(); // rebasing/odd token; refuse

        weight = (burned * multiplierBps[path]) / BPS;
        if (weight == 0) revert ZeroAmount();

        // Settle what the existing weight has already earned BEFORE changing
        // it, so the new weight never retroactively claims an old pot.
        _settle(gauge, msg.sender);
        claimantWeightedBurns[gauge][msg.sender] += weight;
        totalWeightedBurns[gauge] += weight;

        emit Burned(gauge, msg.sender, path, token, burned, weight);
    }

    // ══ Rewards: push in, threshold, claim out ════════════════════════════

    /**
     * @notice Push ETH revenue earmarked for `gauge`'s claimants.
     * @dev Permissionless on purpose. In practice the caller is the treasury /
     * fee-router process that already moves marketplace fees off-chain; making
     * it a privileged role would buy nothing (a griefer's "attack" is donating
     * money) and would add a key to lose.
     */
    function receiveRewards(address gauge) external payable {
        if (!gaugeRegistered[gauge]) revert UnknownGauge();
        if (msg.value == 0) revert ZeroAmount();
        pendingRewards[gauge] += msg.value;
        emit RewardsReceived(gauge, msg.sender, msg.value);
    }

    /**
     * @notice Fold a gauge's accumulated pot into claimable balances, if it
     * has cleared the threshold. Permissionless, so the fold moment is never
     * an admin-controlled choice.
     */
    function distribute(address gauge) public {
        if (!gaugeRegistered[gauge]) revert UnknownGauge();
        uint256 pot = pendingRewards[gauge];
        if (pot == 0 || pot < distributionThresholdWei) revert BelowThreshold();
        uint256 total = totalWeightedBurns[gauge];
        if (total == 0) revert NoClaim(); // nobody has burned; leave it pending
        pendingRewards[gauge] = 0;
        rewardPerWeight[gauge] += Math.mulDiv(pot, WAD, total);
        emit RewardsDistributed(gauge, pot, total);
    }

    /**
     * @notice Claim everything owed on `gauge`. Folds first if the pot is
     * ready, then pays. Below threshold this is NOT an error — it simply pays
     * whatever was already folded, and the pending pot keeps accumulating.
     */
    function claim(address gauge) external nonReentrant returns (uint256 amount) {
        if (!gaugeRegistered[gauge]) revert UnknownGauge();
        if (
            pendingRewards[gauge] >= distributionThresholdWei &&
            pendingRewards[gauge] > 0 &&
            totalWeightedBurns[gauge] > 0
        ) {
            distribute(gauge);
        }
        _settle(gauge, msg.sender);
        amount = owedRewards[gauge][msg.sender];
        // Deliberately NOT a revert. §5's honest-state rule: below threshold a
        // claim is "not yet, still accumulating", which is a zero payout and a
        // successful transaction, not a failure the caller has to interpret.
        // `gaugeStatus()` is where the caller learns why.
        if (amount == 0) return 0;
        owedRewards[gauge][msg.sender] = 0;
        // Effects fully applied before the interaction, plus nonReentrant.
        (bool ok, ) = payable(msg.sender).call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit Claimed(gauge, msg.sender, amount);
    }

    function _settle(address gauge, address who) private {
        uint256 acc = rewardPerWeight[gauge];
        uint256 w = claimantWeightedBurns[gauge][who];
        if (w > 0) {
            uint256 delta = acc - paidPerWeight[gauge][who];
            if (delta > 0) owedRewards[gauge][who] += Math.mulDiv(w, delta, WAD);
        }
        paidPerWeight[gauge][who] = acc;
    }

    // ══ Views ═════════════════════════════════════════════════════════════

    /**
     * @notice The honest, queryable accumulation state §5 asks for.
     * @return accumulated wei sitting un-folded for this gauge
     * @return threshold the current global minimum
     * @return claimable whether a fold would succeed right now
     */
    function gaugeStatus(address gauge)
        external
        view
        returns (uint256 accumulated, uint256 threshold, bool claimable)
    {
        accumulated = pendingRewards[gauge];
        threshold = distributionThresholdWei;
        claimable =
            accumulated > 0 &&
            accumulated >= threshold &&
            totalWeightedBurns[gauge] > 0;
    }

    /// @notice A claimant's CURRENT proportional share of `gauge`, in bps,
    /// measured against the current total — the same fraction a fold would use.
    function claimShareBps(address gauge, address who) external view returns (uint256) {
        uint256 total = totalWeightedBurns[gauge];
        if (total == 0) return 0;
        return (claimantWeightedBurns[gauge][who] * BPS) / total;
    }

    /// @notice Already-folded, not-yet-paid ETH for `who` on `gauge`.
    function claimableNow(address gauge, address who) external view returns (uint256) {
        uint256 w = claimantWeightedBurns[gauge][who];
        uint256 owed = owedRewards[gauge][who];
        if (w > 0) {
            owed += Math.mulDiv(w, rewardPerWeight[gauge] - paidPerWeight[gauge][who], WAD);
        }
        return owed;
    }

    function gaugeCount() external view returns (uint256) {
        return gaugeList.length;
    }

    function gaugeAt(uint256 i) external view returns (address) {
        return gaugeList[i];
    }

    function listGauges() external view returns (address[] memory) {
        return gaugeList;
    }

    function capabilities()
        external
        pure
        returns (bool burnDirected, bool soulbound, bool pushOnlyRewards, uint256 version)
    {
        return (true, true, true, GAUGE_VERSION);
    }

    // ══ Timelocked administration ═════════════════════════════════════════
    //
    // EVERY function below affects FUTURE parameter values only. None of them
    // can move a burn balance, a claim balance, or a wei of pushed reward.
    // Structurally identical to GlobalIndexVault's admin surface, on purpose —
    // one timelock idiom in this repo, not two.

    function queueParam(bytes32 key, uint256 value) external onlyAdmin {
        uint64 eta = uint64(block.timestamp + timelockDelay);
        queuedParams[key] = QueuedParam({value: value, eta: eta, pending: true});
        emit ParamQueued(key, value, eta);
    }

    function executeParam(bytes32 key) external {
        QueuedParam memory q = queuedParams[key];
        if (!q.pending) revert NothingQueued();
        if (block.timestamp < q.eta) revert TimelockNotElapsed();
        delete queuedParams[key];

        if (key == "multiplierRawBps") {
            _validateMultiplier(q.value);
            if (q.value > multiplierBps[PATH_PLANK_ETH_LP]) revert BadParam();
            multiplierBps[PATH_RAW] = q.value;
        } else if (key == "multiplierPlankEthLpBps") {
            _validateMultiplier(q.value);
            if (q.value < multiplierBps[PATH_RAW]) revert BadParam();
            if (q.value > multiplierBps[PATH_COLLECTION_LP]) revert BadParam();
            multiplierBps[PATH_PLANK_ETH_LP] = q.value;
        } else if (key == "multiplierCollectionLpBps") {
            _validateMultiplier(q.value);
            if (q.value < multiplierBps[PATH_PLANK_ETH_LP]) revert BadParam();
            multiplierBps[PATH_COLLECTION_LP] = q.value;
        } else if (key == "distributionThresholdWei") {
            if (q.value > MAX_DISTRIBUTION_THRESHOLD_WEI) revert BadParam();
            distributionThresholdWei = q.value;
        } else {
            revert BadParam();
        }
        emit ParamApplied(key, q.value);
    }

    /// @notice Queue a gauge registration (or removal).
    function queueGauge(address gauge, bool isRemoval) external onlyAdmin {
        if (gauge == address(0)) revert BadParam();
        bytes32 key = keccak256(abi.encodePacked("gauge", gauge));
        uint64 eta = uint64(block.timestamp + timelockDelay);
        queuedAllowlists[key] = QueuedAllowlist({
            token: gauge,
            vault: address(0),
            eta: eta,
            pending: true,
            isRemoval: isRemoval
        });
        emit AllowlistQueued(key, gauge, eta, isRemoval);
    }

    /**
     * @notice Apply a queued gauge change after the delay.
     * @dev Un-registering STOPS new burns and new pushes. It never deletes
     * anyone's accumulated weight or their already-folded claim — those stay
     * exactly where they are, because deleting them is a confiscation, and a
     * confiscation is precisely the class of admin power this whole design is
     * built to not have. Re-registering restores the same book.
     */
    function executeGauge(address gauge) external {
        bytes32 key = keccak256(abi.encodePacked("gauge", gauge));
        QueuedAllowlist memory q = queuedAllowlists[key];
        if (!q.pending) revert NothingQueued();
        if (block.timestamp < q.eta) revert TimelockNotElapsed();
        delete queuedAllowlists[key];

        if (q.isRemoval) {
            if (!gaugeRegistered[gauge]) revert UnknownGauge();
            gaugeRegistered[gauge] = false;
            uint256 n = gaugeList.length;
            for (uint256 i = 0; i < n; i++) {
                if (gaugeList[i] == gauge) {
                    gaugeList[i] = gaugeList[n - 1];
                    gaugeList.pop();
                    break;
                }
            }
            emit GaugeUnregistered(gauge);
        } else {
            if (gaugeRegistered[gauge]) revert GaugeAlreadyRegistered();
            gaugeRegistered[gauge] = true;
            gaugeList.push(gauge);
            emit GaugeRegistered(gauge);
        }
    }

    /// @notice Queue an approved PLANK/ETH LP pair address.
    function queuePlankEthLp(address lpToken, bool isRemoval) external onlyAdmin {
        if (lpToken == address(0)) revert BadParam();
        bytes32 key = keccak256(abi.encodePacked("plankEthLp", lpToken));
        uint64 eta = uint64(block.timestamp + timelockDelay);
        queuedAllowlists[key] = QueuedAllowlist({
            token: lpToken,
            vault: address(0),
            eta: eta,
            pending: true,
            isRemoval: isRemoval
        });
        emit AllowlistQueued(key, lpToken, eta, isRemoval);
    }

    function executePlankEthLp(address lpToken) external {
        bytes32 key = keccak256(abi.encodePacked("plankEthLp", lpToken));
        QueuedAllowlist memory q = queuedAllowlists[key];
        if (!q.pending) revert NothingQueued();
        if (block.timestamp < q.eta) revert TimelockNotElapsed();
        delete queuedAllowlists[key];
        approvedPlankEthLp[lpToken] = !q.isRemoval;
        emit PlankEthLpApproved(lpToken, !q.isRemoval);
    }

    /**
     * @notice Queue the approved v-token LP for one gauge's collection.
     * @param vault the real vault (v-token) address the LP belongs to. Stored
     * so the pairing is on-chain and auditable rather than an off-chain claim.
     */
    function queueCollectionLp(address gauge, address lpToken, address vault, bool isRemoval)
        external
        onlyAdmin
    {
        if (gauge == address(0)) revert BadParam();
        if (!isRemoval && (lpToken == address(0) || vault == address(0))) revert BadParam();
        bytes32 key = keccak256(abi.encodePacked("collectionLp", gauge));
        uint64 eta = uint64(block.timestamp + timelockDelay);
        queuedAllowlists[key] = QueuedAllowlist({
            token: lpToken,
            vault: vault,
            eta: eta,
            pending: true,
            isRemoval: isRemoval
        });
        emit AllowlistQueued(key, lpToken, eta, isRemoval);
    }

    function executeCollectionLp(address gauge) external {
        bytes32 key = keccak256(abi.encodePacked("collectionLp", gauge));
        QueuedAllowlist memory q = queuedAllowlists[key];
        if (!q.pending) revert NothingQueued();
        if (block.timestamp < q.eta) revert TimelockNotElapsed();
        delete queuedAllowlists[key];
        if (q.isRemoval) {
            collectionLpOf[gauge] = address(0);
            collectionVaultOf[gauge] = address(0);
            emit CollectionLpApproved(gauge, address(0), address(0));
        } else {
            collectionLpOf[gauge] = q.token;
            collectionVaultOf[gauge] = q.vault;
            emit CollectionLpApproved(gauge, q.token, q.vault);
        }
    }

    function queueAdmin(address next) external onlyAdmin {
        if (next == address(0)) revert BadParam();
        uint64 eta = uint64(block.timestamp + timelockDelay);
        queuedAdmin = QueuedParam({value: uint256(uint160(next)), eta: eta, pending: true});
        emit AdminQueued(next, eta);
    }

    function executeAdmin() external {
        QueuedParam memory q = queuedAdmin;
        if (!q.pending) revert NothingQueued();
        if (block.timestamp < q.eta) revert TimelockNotElapsed();
        delete queuedAdmin;
        admin = address(uint160(q.value));
        emit AdminApplied(admin);
    }

    // ── Internals ──────────────────────────────────────────────────────────

    function _validateMultiplier(uint256 bps) private pure {
        if (bps < MIN_MULTIPLIER_BPS || bps > MAX_MULTIPLIER_BPS) revert BadParam();
    }
}
