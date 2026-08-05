// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * ============================================================================
 *  VePlank — vote-escrowed PLANK, and the exact limit of what it may do
 *
 *  NOT FOR DEPLOYMENT. Spec-only build, pending the same external audit
 *  MarketplankVaultV3.sol cleared. See docs/marketplank/SPEC-GLOBAL-INDEX-
 *  ULTIMATE-FORM.md §3 and §5.1.
 *
 *  WHAT IT DOES
 *  ------------
 *  Lock PLANK for up to four years; voting power decays linearly to zero at
 *  unlock (Curve's veCRV mechanic, the most durable tokenomics primitive in
 *  DeFi). vePLANK holders vote gauge weights, which direct what share of the
 *  Global Index's own captured fee revenue goes to incentivising which
 *  constituent's liquidity (Balancer veBAL / Core Pools).
 *
 *  WHAT IT MUST NEVER DO — the single most important closed gap
 *  -----------------------------------------------------------
 *  PLANK is 56.78% held by one wallet. That concentration is STATIC and
 *  PRE-EXISTING: it needs no flash loan and no wallet-splitting, just an
 *  existing wallet signing. Beanstalk (Apr 2022, $182M) is the precedent for
 *  what happens when governance power over a basket can redirect the basket's
 *  own pooled assets.
 *
 *  So: this contract has NO reference to GlobalIndexVault, and
 *  GlobalIndexVault has NO reference to this contract. Not "a check that
 *  rejects it" — no reference at all, in either direction. Gauge weights are
 *  a READ-ONLY signal published by this contract for an external fee
 *  distributor to consume. Basket-admin parameters (weight-curve constants,
 *  concentration cap, constituent add/remove, fee splits, emergency params)
 *  live behind GlobalIndexVault's own timelocked admin path and are not
 *  reachable from here by any code path, present or future-addable without a
 *  re-audit. GlobalIndexVault.audit.test.ts enumerates the vault's entire ABI
 *  and proves a maximally-vePLANK'd caller has no privilege on any of it.
 *
 *  Gauge weights are bounded, contestable power: anyone can lock PLANK and
 *  out-vote an unlocked whale position over time, and the worst outcome of
 *  losing every gauge vote is that incentives go somewhere you disliked —
 *  never that pooled reserves move.
 *
 *  ALSO PERMANENT (§2.5): PLANK only ever moves ONE WAY into this system.
 *  Locked PLANK is returned to its own locker at expiry and to nobody else;
 *  this contract never sells, converts, routes, or spends PLANK, and holds no
 *  other asset. There is no admin withdrawal path over locked PLANK — the
 *  §2.8 anchor rule applies here identically.
 * ============================================================================
 */

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/security/ReentrancyGuard.sol";

contract VePlank is ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant WEEK = 7 days;
    uint256 public constant MAX_LOCK = 4 * 365 days;
    uint256 private constant BPS = 10_000;
    /// @dev Bounds the gauge-decay walk so a long-untouched gauge can never
    /// exceed block gas. 128 weeks * 7d > MAX_LOCK, so the walk always
    /// terminates at a point where the gauge is fully decayed anyway.
    uint256 private constant MAX_WEEK_WALK = 128;
    uint256 private constant MAX_GAUGES = 64;

    struct Lock {
        uint256 amount;
        uint256 end; // week-aligned
    }

    struct Point {
        uint256 bias;
        uint256 slope;
        uint256 ts;
    }

    /// @notice The PLANK token. Immutable — no admin may repoint it.
    IERC20 public immutable plank;

    /// @notice May register gauges. That is its ONLY power, it moves no value,
    /// and it has no reach into GlobalIndexVault.
    address public gaugeAdmin;

    mapping(address => Lock) public locks;
    uint256 public totalLocked;

    address[] private gaugeList;
    mapping(address => bool) public isGauge;
    mapping(address => Point) private gaugePoint;
    mapping(address => mapping(uint256 => uint256)) public gaugeSlopeChange;

    /// @notice user => gauge => bps of their lock allocated there.
    mapping(address => mapping(address => uint256)) public userGaugeBps;
    /// @notice user => total bps allocated across all gauges (<= 10000).
    mapping(address => uint256) public userUsedBps;

    mapping(address => mapping(address => uint256)) private userGaugeSlope;
    mapping(address => mapping(address => uint256)) private userGaugeEnd;

    event LockCreated(address indexed user, uint256 amount, uint256 end);
    event LockAmountIncreased(address indexed user, uint256 added, uint256 total);
    event LockExtended(address indexed user, uint256 newEnd);
    event Withdrawn(address indexed user, uint256 amount);
    event GaugeAdded(address indexed gauge);
    event GaugeVoted(address indexed user, address indexed gauge, uint256 bps);
    event GaugeAdminChanged(address indexed next);

    error ZeroAmount();
    error BadUnlockTime();
    error LockExists();
    error NoLock();
    error LockNotExpired();
    error LockExpired();
    error NotGaugeAdmin();
    error UnknownGauge();
    error GaugeExists();
    error TooManyGauges();
    error AllocationExceeded();

    constructor(IERC20 plank_, address gaugeAdmin_) {
        if (address(plank_) == address(0) || gaugeAdmin_ == address(0)) revert ZeroAmount();
        plank = plank_;
        gaugeAdmin = gaugeAdmin_;
    }

    // ── Locking ────────────────────────────────────────────────────────────

    /// @notice Lock `amount` PLANK until `unlockTime` (rounded down to a week).
    function createLock(uint256 amount, uint256 unlockTime) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        Lock storage l = locks[msg.sender];
        if (l.amount != 0) revert LockExists();
        uint256 end = (unlockTime / WEEK) * WEEK;
        if (end <= block.timestamp || end > block.timestamp + MAX_LOCK) revert BadUnlockTime();

        // Credit the actual delta — a fee-on-transfer PLANK must not be able to
        // mint voting power it did not pay for.
        uint256 before = plank.balanceOf(address(this));
        plank.safeTransferFrom(msg.sender, address(this), amount);
        uint256 credited = plank.balanceOf(address(this)) - before;
        if (credited == 0) revert ZeroAmount();

        l.amount = credited;
        l.end = end;
        totalLocked += credited;
        emit LockCreated(msg.sender, credited, end);
    }

    function increaseAmount(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        Lock storage l = locks[msg.sender];
        if (l.amount == 0) revert NoLock();
        if (l.end <= block.timestamp) revert LockExpired();

        uint256 before = plank.balanceOf(address(this));
        plank.safeTransferFrom(msg.sender, address(this), amount);
        uint256 credited = plank.balanceOf(address(this)) - before;
        if (credited == 0) revert ZeroAmount();

        l.amount += credited;
        totalLocked += credited;
        emit LockAmountIncreased(msg.sender, credited, l.amount);
    }

    function increaseUnlockTime(uint256 unlockTime) external nonReentrant {
        Lock storage l = locks[msg.sender];
        if (l.amount == 0) revert NoLock();
        if (l.end <= block.timestamp) revert LockExpired();
        uint256 end = (unlockTime / WEEK) * WEEK;
        if (end <= l.end || end > block.timestamp + MAX_LOCK) revert BadUnlockTime();
        l.end = end;
        emit LockExtended(msg.sender, end);
    }

    /// @notice Withdraw your own expired lock. Nobody else can ever call this
    /// for you, and no admin function anywhere on this contract touches it.
    function withdraw() external nonReentrant {
        Lock storage l = locks[msg.sender];
        if (l.amount == 0) revert NoLock();
        if (block.timestamp < l.end) revert LockNotExpired();
        uint256 amount = l.amount;
        l.amount = 0;
        l.end = 0;
        totalLocked -= amount;
        plank.safeTransfer(msg.sender, amount);
        emit Withdrawn(msg.sender, amount);
    }

    /// @notice Voting power now: amount * timeRemaining / MAX_LOCK.
    function balanceOf(address user) public view returns (uint256) {
        Lock memory l = locks[user];
        if (l.amount == 0 || l.end <= block.timestamp) return 0;
        return (l.amount * (l.end - block.timestamp)) / MAX_LOCK;
    }

    function lockSlope(address user) public view returns (uint256) {
        Lock memory l = locks[user];
        if (l.amount == 0 || l.end <= block.timestamp) return 0;
        return l.amount / MAX_LOCK;
    }

    // ── Gauges ─────────────────────────────────────────────────────────────

    function addGauge(address gauge) external {
        if (msg.sender != gaugeAdmin) revert NotGaugeAdmin();
        if (gauge == address(0)) revert UnknownGauge();
        if (isGauge[gauge]) revert GaugeExists();
        if (gaugeList.length >= MAX_GAUGES) revert TooManyGauges();
        isGauge[gauge] = true;
        gaugeList.push(gauge);
        gaugePoint[gauge].ts = block.timestamp;
        emit GaugeAdded(gauge);
    }

    function setGaugeAdmin(address next) external {
        if (msg.sender != gaugeAdmin) revert NotGaugeAdmin();
        if (next == address(0)) revert UnknownGauge();
        gaugeAdmin = next;
        emit GaugeAdminChanged(next);
    }

    /**
     * @notice Allocate `bps` of your vePLANK to `gauge`. Re-voting replaces
     * your previous allocation to that gauge. Total across gauges <= 100%.
     * @dev THE ONLY POWER vePLANK HAS. It directs where already-captured fee
     * revenue is spent on liquidity incentives. It cannot change a basket
     * parameter, cannot add or remove a constituent, cannot alter a fee split
     * inside the vault, and cannot move a single unit of pooled reserve.
     */
    function voteGaugeWeight(address gauge, uint256 bps) external nonReentrant {
        if (!isGauge[gauge]) revert UnknownGauge();
        if (bps > BPS) revert AllocationExceeded();
        Lock memory l = locks[msg.sender];
        if (l.amount == 0) revert NoLock();
        if (l.end <= block.timestamp) revert LockExpired();

        _checkpointGauge(gauge);
        Point storage p = gaugePoint[gauge];

        // Remove the caller's previous contribution to this gauge.
        uint256 oldSlope = userGaugeSlope[msg.sender][gauge];
        uint256 oldEnd = userGaugeEnd[msg.sender][gauge];
        if (oldSlope != 0 && oldEnd > block.timestamp) {
            uint256 oldBias = oldSlope * (oldEnd - block.timestamp);
            p.bias = p.bias > oldBias ? p.bias - oldBias : 0;
            p.slope = p.slope > oldSlope ? p.slope - oldSlope : 0;
            uint256 sc = gaugeSlopeChange[gauge][oldEnd];
            gaugeSlopeChange[gauge][oldEnd] = sc > oldSlope ? sc - oldSlope : 0;
        }

        uint256 used = userUsedBps[msg.sender] - userGaugeBps[msg.sender][gauge] + bps;
        if (used > BPS) revert AllocationExceeded();
        userUsedBps[msg.sender] = used;
        userGaugeBps[msg.sender][gauge] = bps;

        uint256 newSlope = (lockSlope(msg.sender) * bps) / BPS;
        if (newSlope != 0) {
            p.bias += newSlope * (l.end - block.timestamp);
            p.slope += newSlope;
            gaugeSlopeChange[gauge][l.end] += newSlope;
        }
        userGaugeSlope[msg.sender][gauge] = newSlope;
        userGaugeEnd[msg.sender][gauge] = l.end;

        emit GaugeVoted(msg.sender, gauge, bps);
    }

    /// @notice A gauge's decayed weight right now. View — mirrors exactly what
    /// `_checkpointGauge` would write.
    function gaugeWeight(address gauge) public view returns (uint256) {
        Point memory p = gaugePoint[gauge];
        if (p.ts == 0 || p.ts >= block.timestamp) return p.bias;
        uint256 t = (p.ts / WEEK) * WEEK;
        for (uint256 i = 0; i < MAX_WEEK_WALK; i++) {
            t += WEEK;
            bool done = false;
            if (t > block.timestamp) {
                t = block.timestamp;
                done = true;
            }
            uint256 dt = t - p.ts;
            uint256 decay = p.slope * dt;
            p.bias = p.bias > decay ? p.bias - decay : 0;
            p.ts = t;
            if (done) break;
            uint256 ds = gaugeSlopeChange[gauge][t];
            p.slope = p.slope > ds ? p.slope - ds : 0;
        }
        return p.bias;
    }

    /// @notice `gauge`'s share of all gauge weight, in WAD. This is the number
    /// an external fee distributor reads. It is advisory data, not authority.
    function relativeGaugeWeight(address gauge) external view returns (uint256) {
        uint256 total;
        uint256 n = gaugeList.length;
        for (uint256 i = 0; i < n; i++) total += gaugeWeight(gaugeList[i]);
        if (total == 0) return 0;
        return (gaugeWeight(gauge) * 1e18) / total;
    }

    function gaugeCount() external view returns (uint256) {
        return gaugeList.length;
    }

    function gaugeAt(uint256 i) external view returns (address) {
        return gaugeList[i];
    }

    function _checkpointGauge(address gauge) private {
        Point storage sp = gaugePoint[gauge];
        if (sp.ts == 0) {
            sp.ts = block.timestamp;
            return;
        }
        if (sp.ts >= block.timestamp) return;
        Point memory p = sp;
        uint256 t = (p.ts / WEEK) * WEEK;
        for (uint256 i = 0; i < MAX_WEEK_WALK; i++) {
            t += WEEK;
            bool done = false;
            if (t > block.timestamp) {
                t = block.timestamp;
                done = true;
            }
            uint256 dt = t - p.ts;
            uint256 decay = p.slope * dt;
            p.bias = p.bias > decay ? p.bias - decay : 0;
            p.ts = t;
            if (done) break;
            uint256 ds = gaugeSlopeChange[gauge][t];
            p.slope = p.slope > ds ? p.slope - ds : 0;
        }
        sp.bias = p.bias;
        sp.slope = p.slope;
        sp.ts = p.ts;
    }
}
