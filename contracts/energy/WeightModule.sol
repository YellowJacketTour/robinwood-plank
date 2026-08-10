// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IWeightModule} from "./IWeightModule.sol";

/**
 * @notice Minimal view any factory must expose so WeightModule can gate
 * note* calls to real, factory-deployed collection vaults.
 */
interface IVaultFactoryView {
    function isVault(address vault) external view returns (bool);
}

/**
 * @notice The subset of `CollectionVault` this module reads DIRECTLY rather
 * than trusting a self-report. Read via low-level `staticcall` so that a
 * non-conforming (or EOA-mock) vault degrades to "no information" instead of
 * reverting the whole `weights()` hot path — which is Pipe I and Pipe L's
 * only source of allocation and must never brick (audit C-1's lesson).
 */
interface ICollectionVaultRealizable {
    function paymentReserve() external view returns (uint256);
    function shareReserve() external view returns (uint256);
    function realizableBps(uint256 sharesIn) external view returns (uint256);
}

/**
 * ============================================================================
 *  WeightModule — REWRITTEN per DESIGN-HONEST-INDEX-2026-08-09 §3.
 *  Closes audit C-4, H-4, H-6, H-8.
 *
 *  WHAT CHANGED AND WHY (each item is a closed finding, not a refactor):
 *
 *  1. UNRECOVERABLE CONTRIBUTION ONLY (§3.1, closes H-4).
 *     Weight now credits only value that irreversibly reached the commons —
 *     the `sinkCut` a vault pushes to `upstreamSink`. Previously the vault
 *     could route the fee to a `treasury_` it chose itself at `deployVault`
 *     and self-compound the rest, recapturing ~91.9% of what it "paid": about
 *     0.004 WETH bought 12.5% of all fee flow, permanently. Crediting only
 *     the sink cut makes faking the signal cost exactly what it earns, which
 *     is the design's `R <= C` bound.
 *
 *     NOTE that this module cannot VERIFY the reported figure is the sink cut
 *     — it is a self-report from a factory-gated vault, and the vault's own
 *     `_routeStreamA` is the enforcement point. What this module CAN do, and
 *     now does, is refuse to let the two signals a vault can inflate for free
 *     (depth, volume) carry weight without cost; see 2 and 3.
 *
 *  2. DEPTH = WINDOWED MINIMUM (§3.2, closes C-4/H-6).
 *     `noteDepth` used to persist the LATEST reported value forever, so
 *     flash-loan -> addLiquidity -> one dust swap -> removeLiquidity latched a
 *     fake 10,000 WETH depth permanently for ~0.004 WETH. Depth is now the
 *     MINIMUM over `DEPTH_BUCKETS` buckets of `DEPTH_BUCKET_BLOCKS` each, and
 *     a bucket with NO sample counts as ZERO. Consequences, both intended:
 *       - a flash-loan spike occupies one bucket and is minimised away;
 *       - depth weight requires liquidity that is real, and *continuously
 *         observable*, for the entire window.
 *     `pokeDepth` is permissionless and reads the vault's real
 *     `paymentReserve` directly, so anyone — a keeper, a rival collection, the
 *     Bus itself — can put the true number on the record. A vault cannot
 *     protect a stale high sample by going quiet.
 *
 *  3. VOLUME = SINK FEE, NOT GROSS NOTIONAL (§3.2, closes H-6).
 *     Gross notional round-trips to ~zero cost, so it was free to inflate.
 *     The EWMA is also no longer seeded undamped on its first sample (audit
 *     H-6's third clause) — the first observation now enters at ALPHA like
 *     every other, so one large first print cannot instantly own the signal.
 *
 *  4. DECAY ACTUALLY REACHES ZERO (§3.2).
 *     The old shrink was `s*K/(K+quiet)` — hyperbolic, needing ~2 years of
 *     silence to reach 1%. It is now a genuine half-life: the score halves
 *     every `DECAY_BLOCKS` of silence past the grace window and hits exact
 *     zero after 128 half-lives, with linear interpolation inside each step.
 *
 *  5. EXIT-CAPACITY CAP REPLACES THE FIAT CAP (§3.3, closes H-8).
 *     `W_MAX_BPS = 2500` is gone. A vault's cap is now its SHARE of total
 *     measured exit capacity, where capacity is `EXIT_HAIRCUT_BPS` of its
 *     WINDOWED-MINIMUM depth, quality-adjusted by the vault's own
 *     `realizableBps()`. Because those caps are shares of a total they sum to
 *     10_000 by construction, the waterfall can always fill to exactly
 *     10_000 — which is precisely the invariant H-8 found broken (three
 *     admitted vaults summed to 7500 and leaked 25% of the largest pipe to
 *     dividends; two vaults leaked 50%; one leaked 75%).
 *
 *  6. ROBINWOOD FLOOR, 8.1%, SELF-FULFILLING (§3.4).
 *     `robinwoodVault` always receives `max(810, meritocratic share)`. It is
 *     exempt from concentration by decree but NOT from exit capacity, because
 *     exempting it there would mean printing a redeemability we cannot honour
 *     and §1 is not negotiable. Where capacity cannot support 810 bps, the
 *     shortfall is published via `robinwoodShortfallBps()` rather than waived,
 *     so Pipe L can spend it deepening Robinwood's own pool until the floor
 *     becomes honestly supportable.
 *
 *  Still no settlement oracle anywhere in this file.
 * ============================================================================
 */
contract WeightModule is IWeightModule {
    uint256 internal constant WAD = 1e18;
    uint256 internal constant BPS_DENOM = 10_000;

    // ---- Signal blend (unchanged genesis constants) ----
    uint256 public constant ALPHA_F_WAD = 450_000_000_000_000_000; // 0.45
    uint256 public constant BETA_P_WAD = 250_000_000_000_000_000; // 0.25
    uint256 public constant GAMMA_D_WAD = 150_000_000_000_000_000; // 0.15
    uint256 public constant DELTA_V_WAD = 150_000_000_000_000_000; // 0.15

    uint256 public constant K_BLOCKS = 50_400;
    uint256 public constant F_MIN_WEI = 0.05 ether;
    uint256 public constant DECAY_BLOCKS = 100_800;

    /// @dev Weight given to the newest sample in the V-signal EWMA (20%).
    /// Applied to the FIRST sample too — see header item 3.
    uint256 internal constant EWMA_ALPHA_WAD = 200_000_000_000_000_000;

    // ---- Depth window (header item 2) ----
    /// @notice Number of buckets in the rolling depth window.
    uint256 public constant DEPTH_BUCKETS = 6;
    /// @notice Blocks per bucket. 6 x 1200 = 7200 blocks ~= 1 day on a 12s
    /// chain. Faking depth therefore means holding real liquidity for a day,
    /// through every bucket, in front of a permissionless `pokeDepth`.
    uint256 public constant DEPTH_BUCKET_BLOCKS = 1_200;

    // ---- Exit capacity (header item 5) ----
    /// @notice The haircut the index is willing to eat to exit a constituent.
    /// For a constant-product pool, withdrawing fraction `f` of the payment
    /// reserve costs approximately `f` in haircut, so "10% of the shallowest
    /// observed WETH reserve" is the honest bounded-haircut exit size.
    uint256 public constant EXIT_HAIRCUT_BPS = 1_000;
    /// @notice Probe divisor for the realizable-quality read: selling
    /// `shareReserve / 9` shares is exactly the ~10%-haircut point on a
    /// constant-product curve (`y/(y+s) = 0.9` at `s = y/9`).
    uint256 internal constant EXIT_PROBE_DIVISOR = 9;

    // ---- Robinwood floor (header item 6) ----
    uint256 public constant ROBINWOOD_FLOOR_BPS = 810; // 8.1%

    struct VaultScore {
        uint256 feeWethCumulative; // F_i cumulative SINK-DELIVERED wei
        int256 mintPressureCumulative; // P_i signed net sink-denominated pressure
        uint256 depthWeth; // last reported depth (display/telemetry only, NEVER scored)
        uint256 volumeEwma; // V_i EWMA of SINK-FEE wei
        uint64 firstFeeBlock;
        uint64 lastFeeBlock;
        bool admitted;
    }

    /// @dev Ring of `DEPTH_BUCKETS` (epoch, minimum-in-epoch) pairs. Kept out
    /// of `VaultScore` so the public `scores` getter stays a flat tuple.
    struct DepthWindow {
        uint64[6] epoch;
        uint256[6] minValue;
    }

    address public immutable factory;
    /// @dev The only address that may ever name Robinwood, and only once.
    address public immutable robinwoodSetter;

    address public robinwoodVault;

    mapping(address => VaultScore) public scores;
    mapping(address => DepthWindow) internal depthWindows;
    address[] internal admittedVaults;
    mapping(address => bool) internal isAdmittedVault;

    constructor(address factory_) {
        if (factory_ == address(0)) revert ZeroAddress();
        factory = factory_;
        robinwoodSetter = msg.sender;
    }

    modifier onlyFactoryVault(address vault) {
        if (msg.sender != vault || !IVaultFactoryView(factory).isVault(vault)) {
            revert NotFactoryVault();
        }
        _;
    }

    // -------------------------------------------------------------------
    // Robinwood designation — set once, ever.
    // -------------------------------------------------------------------

    /// @notice Name the permanent 8.1% beneficiary (design §3.4). Callable
    /// exactly once, by the deployer, and never changeable afterwards — a
    /// mutable beneficiary would be a governance lever over the largest pipe,
    /// which is precisely the class of key the audit flagged as over-broad.
    function setRobinwoodVault(address vault) external {
        if (msg.sender != robinwoodSetter) revert NotRobinwoodSetter();
        if (robinwoodVault != address(0)) revert RobinwoodAlreadySet();
        if (vault == address(0)) revert ZeroAddress();
        robinwoodVault = vault;
        emit RobinwoodVaultSet(vault);
    }

    // -------------------------------------------------------------------
    // Signal ingestion — self-reported, factory-gated, sink-denominated.
    // -------------------------------------------------------------------

    /// @inheritdoc IWeightModule
    function noteFee(address vault, uint256 sinkAmountWei) external onlyFactoryVault(vault) {
        VaultScore storage vs = scores[vault];
        // A zero sink cut is not activity: a vault that routes 100% of its fee
        // to its own treasury has contributed NOTHING unrecoverable, so it
        // must not even start its maturity clock. This is the entry point of
        // the `R <= C` bound (design §3.1 / audit H-4).
        if (sinkAmountWei == 0) return;
        if (vs.firstFeeBlock == 0) {
            vs.firstFeeBlock = uint64(block.number);
        }
        vs.lastFeeBlock = uint64(block.number);
        vs.feeWethCumulative += sinkAmountWei;
        emit FeeNoted(vault, sinkAmountWei, vs.feeWethCumulative);
    }

    /// @inheritdoc IWeightModule
    function noteMintPressure(address vault, int256 netSinkDeltaWei) external onlyFactoryVault(vault) {
        VaultScore storage vs = scores[vault];
        vs.mintPressureCumulative += netSinkDeltaWei;
        emit MintPressureNoted(vault, netSinkDeltaWei, vs.mintPressureCumulative);
    }

    /// @inheritdoc IWeightModule
    function noteDepth(address vault, uint256 reserveWethWei) external onlyFactoryVault(vault) {
        _recordDepth(vault, reserveWethWei);
    }

    /// @inheritdoc IWeightModule
    function noteVolume(address vault, uint256 sinkFeeWei) external onlyFactoryVault(vault) {
        VaultScore storage vs = scores[vault];
        // NO undamped first sample (audit H-6). Starting from zero and
        // applying ALPHA uniformly means a single large opening print buys
        // only ALPHA of the signal, and sustaining it costs sustained sink
        // fees — which is the whole point.
        vs.volumeEwma = (vs.volumeEwma * (WAD - EWMA_ALPHA_WAD) + sinkFeeWei * EWMA_ALPHA_WAD) / WAD;
        emit VolumeNoted(vault, sinkFeeWei, vs.volumeEwma);
    }

    /// @inheritdoc IWeightModule
    function pokeDepth(address vault) external {
        // Permissionless BUT still factory-scoped: only a real vault can hold
        // weight, so only a real vault's depth is worth recording.
        if (!IVaultFactoryView(factory).isVault(vault)) revert NotFactoryVault();
        (bool ok, uint256 reserve) = _tryUint(vault, abi.encodeWithSelector(ICollectionVaultRealizable.paymentReserve.selector));
        _recordDepth(vault, ok ? reserve : 0);
    }

    /// @dev Fold `reserve` into the current bucket as a MINIMUM. A bucket
    /// belonging to a past epoch is reset (its history has rolled off); a
    /// bucket in the current epoch keeps the SMALLEST value seen this epoch,
    /// so a spike cannot erase a preceding trough within the same bucket.
    function _recordDepth(address vault, uint256 reserve) internal {
        VaultScore storage vs = scores[vault];
        vs.depthWeth = reserve; // telemetry only — never read by _rawScore
        DepthWindow storage dw = depthWindows[vault];
        uint64 epoch = uint64(block.number / DEPTH_BUCKET_BLOCKS);
        uint256 slot = uint256(epoch) % DEPTH_BUCKETS;
        if (dw.epoch[slot] != epoch) {
            dw.epoch[slot] = epoch;
            dw.minValue[slot] = reserve;
        } else if (reserve < dw.minValue[slot]) {
            dw.minValue[slot] = reserve;
        }
        emit DepthNoted(vault, reserve, _windowMin(vault));
    }

    /// @inheritdoc IWeightModule
    function windowMinDepth(address vault) external view returns (uint256) {
        return _windowMin(vault);
    }

    /// @dev The scored depth: the minimum across the window, where a CLOSED
    /// bucket that was never sampled — or whose sample has rolled out of the
    /// window — counts as ZERO. That asymmetry is the whole mechanism:
    /// absence of evidence about a pool's depth is treated as absence of
    /// depth, so the only way to hold this signal is to be continuously,
    /// verifiably deep, and `pokeDepth` lets ANYONE supply the evidence that
    /// a pool has thinned out.
    ///
    /// The CURRENT bucket is still open, so it is counted only if it already
    /// has a sample. Requiring it would zero every vault's depth at each
    /// epoch boundary until a keeper ran, which would make the allocation
    /// flap for reasons that say nothing about liquidity.
    function _windowMin(address vault) internal view returns (uint256) {
        DepthWindow storage dw = depthWindows[vault];
        uint64 cur = uint64(block.number / DEPTH_BUCKET_BLOCKS);
        uint64 span = uint64(DEPTH_BUCKETS) - 1;
        uint64 first = cur >= span ? cur - span : 0;

        uint256 minSeen = type(uint256).max;
        for (uint64 e = first; e < cur; e++) {
            uint256 slot = uint256(e) % DEPTH_BUCKETS;
            uint256 v = dw.epoch[slot] == e ? dw.minValue[slot] : 0;
            if (v < minSeen) minSeen = v;
            if (minSeen == 0) return 0;
        }
        uint256 curSlot = uint256(cur) % DEPTH_BUCKETS;
        if (dw.epoch[curSlot] == cur && dw.minValue[curSlot] < minSeen) {
            minSeen = dw.minValue[curSlot];
        }
        return minSeen == type(uint256).max ? 0 : minSeen;
    }

    // -------------------------------------------------------------------
    // Admit
    // -------------------------------------------------------------------

    function checkAdmit(address vault) external returns (bool) {
        VaultScore storage vs = scores[vault];
        if (vs.admitted) revert AlreadyAdmitted();
        // F is now sink-delivered wei only, so the admission floor became a
        // real 0.05 WETH of unrecoverable contribution rather than 0.05 WETH
        // of fee the vault mostly paid to itself (audit C-4's "admission costs
        // only the sink cut" — now admission costs exactly the sink cut,
        // because nothing else counts).
        if (vs.feeWethCumulative < F_MIN_WEI) revert NotAdmitted();
        vs.admitted = true;
        isAdmittedVault[vault] = true;
        admittedVaults.push(vault);
        emit Admitted(vault);
        return true;
    }

    function isAdmitted(address vault) external view returns (bool) {
        return scores[vault].admitted;
    }

    // -------------------------------------------------------------------
    // Score
    // -------------------------------------------------------------------

    function score(address vault) external view returns (uint256) {
        return _rawScore(vault);
    }

    function _rawScore(address vault) internal view returns (uint256) {
        VaultScore storage vs = scores[vault];
        if (vs.firstFeeBlock == 0) return 0;

        uint256 delta = block.number - vs.firstFeeBlock;
        uint256 m = (delta * WAD) / (delta + K_BLOCKS);
        if (m == 0) return 0;

        uint256 fHat = vs.feeWethCumulative;
        uint256 pHat = vs.mintPressureCumulative > 0 ? uint256(vs.mintPressureCumulative) : 0;
        // D is the WINDOWED MINIMUM, never the latched latest (audit C-4/H-6).
        uint256 dHat = _windowMin(vault);
        uint256 vHat = vs.volumeEwma;

        uint256 composite = (ALPHA_F_WAD * fHat + BETA_P_WAD * pHat + GAMMA_D_WAD * dHat + DELTA_V_WAD * vHat) / WAD;
        uint256 s = (m * composite) / WAD;
        return _applyDecay(s, block.number - vs.lastFeeBlock);
    }

    /// @dev True half-life decay. `DECAY_BLOCKS` of silence is free (a quiet
    /// day is not death); every `DECAY_BLOCKS` after that HALVES the score,
    /// with linear interpolation inside a step so the curve has no cliffs.
    /// After 128 half-lives the score is exactly zero — a dormant collection
    /// stops receiving energy without anyone voting on it (design §3.2).
    function _applyDecay(uint256 s, uint256 sinceLast) internal pure returns (uint256) {
        if (s == 0 || sinceLast <= DECAY_BLOCKS) return s;
        uint256 quiet = sinceLast - DECAY_BLOCKS;
        uint256 halvings = quiet / DECAY_BLOCKS;
        if (halvings >= 128) return 0;
        s >>= halvings;
        if (s == 0) return 0;
        uint256 rem = quiet % DECAY_BLOCKS;
        // Linear glide across the current half-life: at rem = DECAY_BLOCKS the
        // multiplier reaches 1/2, matching the next integer halving exactly.
        return s - (s * rem) / (2 * DECAY_BLOCKS);
    }

    // -------------------------------------------------------------------
    // Exit capacity (design §3.3)
    // -------------------------------------------------------------------

    /// @inheritdoc IWeightModule
    function exitCapacityWeth(address vault) external view returns (uint256) {
        return _exitCapacityWeth(vault);
    }

    /// @dev Capacity = `EXIT_HAIRCUT_BPS` of the WINDOWED-MINIMUM WETH depth,
    /// scaled by how much of a spot mark that pool can actually realize.
    ///
    /// Both inputs are hostile-resistant in the right direction:
    ///   - windowed minimum: cannot be inflated by a flash loan, only by
    ///     genuinely held liquidity;
    ///   - `realizableBps`: read from the vault, and a vault that lies here
    ///     lies about its OWN redeemability, which the index measures again
    ///     at settlement time (design §1.3) — inflating it buys weight but
    ///     not value, because purchases credit only what is absorbable.
    ///
    /// A vault that reports nothing has capacity 0 and therefore weight 0.
    /// That is the correct default: an unmeasured pipe gets no energy.
    function _exitCapacityWeth(address vault) internal view returns (uint256) {
        uint256 d = _windowMin(vault);
        if (d == 0) return 0;
        uint256 capacity = (d * EXIT_HAIRCUT_BPS) / BPS_DENOM;
        if (capacity == 0) return 0;
        uint256 q = _realizableQualityBps(vault);
        return (capacity * q) / BPS_DENOM;
    }

    /// @dev `realizableBps` at the bounded-haircut probe size. Returns
    /// BPS_DENOM ("assume no extra quality penalty") only when the vault does
    /// not implement the primitive at all — in which case capacity still
    /// rests entirely on the windowed-minimum depth, which is the unfakeable
    /// half. Never returns more than BPS_DENOM: a vault claiming >100%
    /// realizable is claiming it can pay more than the mark, and we clamp
    /// rather than believe it.
    function _realizableQualityBps(address vault) internal view returns (uint256) {
        (bool okShares, uint256 shareRes) =
            _tryUint(vault, abi.encodeWithSelector(ICollectionVaultRealizable.shareReserve.selector));
        if (!okShares || shareRes < EXIT_PROBE_DIVISOR) return BPS_DENOM;
        (bool okQ, uint256 q) = _tryUint(
            vault,
            abi.encodeWithSelector(ICollectionVaultRealizable.realizableBps.selector, shareRes / EXIT_PROBE_DIVISOR)
        );
        if (!okQ) return BPS_DENOM;
        return q > BPS_DENOM ? BPS_DENOM : q;
    }

    /// @dev Non-reverting `staticcall` returning a single uint256. A
    /// constituent that reverts, self-destructs, or was never a conforming
    /// vault must degrade the ALLOCATION, never brick it.
    function _tryUint(address target, bytes memory data) internal view returns (bool ok, uint256 value) {
        if (target.code.length == 0) return (false, 0);
        (bool success, bytes memory ret) = target.staticcall(data);
        if (!success || ret.length < 32) return (false, 0);
        return (true, abi.decode(ret, (uint256)));
    }

    // -------------------------------------------------------------------
    // Weights
    // -------------------------------------------------------------------

    /// @inheritdoc IWeightModule
    function robinwoodShortfallBps() external view returns (uint256) {
        address rw = robinwoodVault;
        if (rw == address(0) || !isAdmittedVault[rw]) return 0;
        uint256 capBps = _capBpsFor(rw);
        return capBps >= ROBINWOOD_FLOOR_BPS ? 0 : ROBINWOOD_FLOOR_BPS - capBps;
    }

    /// @dev Robinwood's exit-capacity cap in bps of the whole index — the one
    /// number the §3.4 floor is allowed to lose to.
    function _capBpsFor(address vault) internal view returns (uint256) {
        uint256 n = admittedVaults.length;
        uint256 total;
        uint256 mine;
        for (uint256 i = 0; i < n; i++) {
            uint256 c = _exitCapacityWeth(admittedVaults[i]);
            total += c;
            if (admittedVaults[i] == vault) mine = c;
        }
        // No capacity measured anywhere: no cap can be derived, so none binds.
        if (total == 0) return BPS_DENOM;
        return (mine * BPS_DENOM) / total;
    }

    /**
     * @inheritdoc IWeightModule
     *
     * @dev The allocation, in order:
     *   1. meritocratic share  w_i = s_i / sum(s)
     *   2. exit-capacity cap   w_i <= capacity_i / sum(capacity)   (§3.3)
     *   3. Robinwood floor     w_RW = max(810, w_RW), still <= its cap (§3.4)
     *   4. renormalize to EXACTLY 10_000                            (H-8)
     *
     * Step 2's caps are SHARES OF A TOTAL, so they sum to 10_000 and the
     * waterfall can always place every last bp. That structural property is
     * what makes step 4 an identity rather than a hope — the old fiat cap had
     * no such property, which is exactly how three vaults summed to 7500.
     */
    function weights() external view returns (address[] memory vaults, uint256[] memory wBps) {
        uint256 n = admittedVaults.length;
        vaults = new address[](n);
        wBps = new uint256[](n);
        if (n == 0) return (vaults, wBps);

        uint256[] memory raw;
        uint256[] memory capBps;
        bool anyScore;
        (raw, capBps, anyScore) = _gather(vaults);
        if (!anyScore) return (vaults, wBps);

        (uint256 rwIdx, uint256 rwFloor) = _robinwoodBounds(vaults, capBps);
        _allocate(raw, capBps, wBps, rwIdx, rwFloor);
    }

    /// @dev Fills `vaults`, and returns per-vault raw scores plus each vault's
    /// exit-capacity cap ALREADY EXPRESSED IN BPS OF THE INDEX. Split out of
    /// `weights()` purely for stack depth (this repo pins a non-viaIR
    /// compiler, the same reason `CollectionLpAdapter` splits its leg).
    function _gather(address[] memory vaults)
        internal
        view
        returns (uint256[] memory raw, uint256[] memory capBps, bool anyScore)
    {
        uint256 n = vaults.length;
        raw = new uint256[](n);
        capBps = new uint256[](n);
        uint256 sum;
        uint256 capTotal;
        for (uint256 i = 0; i < n; i++) {
            vaults[i] = admittedVaults[i];
            raw[i] = _rawScore(vaults[i]);
            sum += raw[i];
            capBps[i] = _exitCapacityWeth(vaults[i]); // capacity in wei for now
            capTotal += capBps[i];
        }
        if (sum == 0) return (raw, capBps, false);

        if (capTotal == 0) {
            // Nothing measurable anywhere (no vault has ever been sampled).
            // No derived cap exists, so none is invented — reintroducing a
            // fiat cap here is exactly what §3.3 refuses.
            for (uint256 i = 0; i < n; i++) capBps[i] = BPS_DENOM;
        } else {
            uint256 deepest;
            for (uint256 i = 1; i < n; i++) {
                if (capBps[i] > capBps[deepest]) deepest = i;
            }
            uint256 capSumBps;
            for (uint256 i = 0; i < n; i++) {
                capBps[i] = (capBps[i] * BPS_DENOM) / capTotal;
                capSumBps += capBps[i];
            }
            // The caps MUST sum to exactly 10_000, or the waterfall inherits
            // the very under-summing defect audit H-8 reported: floor
            // division here loses up to n-1 bps, and every lost bp is a bp of
            // the largest pipe that silently leaks to dividends. Hand the
            // rounding dust to the DEEPEST pool, which by definition has the
            // exit capacity to honour it.
            if (capSumBps < BPS_DENOM) capBps[deepest] += BPS_DENOM - capSumBps;
        }
        anyScore = true;
    }

    /// @dev Robinwood's floor is a LOWER bound clamped by its own capacity
    /// cap: never waived by decree, never faked past what it can honestly pay.
    function _robinwoodBounds(address[] memory vaults, uint256[] memory capBps)
        internal
        view
        returns (uint256 rwIdx, uint256 rwFloor)
    {
        rwIdx = type(uint256).max;
        address rw = robinwoodVault;
        if (rw == address(0)) return (rwIdx, 0);
        for (uint256 i = 0; i < vaults.length; i++) {
            if (vaults[i] == rw) {
                return (i, capBps[i] < ROBINWOOD_FLOOR_BPS ? capBps[i] : ROBINWOOD_FLOOR_BPS);
            }
        }
    }

    /// @dev Waterfall: fix every vault that is pinned (at its cap, or at the
    /// Robinwood floor), redistribute the remainder pro-rata by raw score
    /// among the free ones, repeat until stable. Bounded by `n + 1` passes
    /// because each pass pins at least one vault or terminates.
    function _allocate(
        uint256[] memory raw,
        uint256[] memory capBps,
        uint256[] memory wBps,
        uint256 rwIdx,
        uint256 rwFloor
    ) internal pure {
        uint256 n = raw.length;
        bool[] memory pinned = new bool[](n);

        for (uint256 pass = 0; pass <= n; pass++) {
            uint256 pinnedBps;
            uint256 freeRaw;
            for (uint256 i = 0; i < n; i++) {
                if (pinned[i]) pinnedBps += wBps[i];
                else freeRaw += raw[i];
            }
            uint256 remaining = pinnedBps >= BPS_DENOM ? 0 : BPS_DENOM - pinnedBps;

            for (uint256 i = 0; i < n; i++) {
                if (pinned[i]) continue;
                wBps[i] = freeRaw == 0 ? 0 : (raw[i] * remaining) / freeRaw;
            }

            bool changed = false;
            for (uint256 i = 0; i < n; i++) {
                if (pinned[i]) continue;
                if (wBps[i] > capBps[i]) {
                    wBps[i] = capBps[i];
                    pinned[i] = true;
                    changed = true;
                } else if (i == rwIdx && wBps[i] < rwFloor) {
                    wBps[i] = rwFloor;
                    pinned[i] = true;
                    changed = true;
                }
            }
            if (!changed) break;
        }
        _placeRemainder(wBps, capBps, raw);
    }

    /// @dev Closes audit H-8 exactly. Floor division above always leaves the
    /// total AT OR BELOW 10_000; every leftover bp is handed to the highest-
    /// scoring vault that still has cap headroom, so `weights()` sums to
    /// EXACTLY 10_000 and the pipe leaks nothing to dividends by accident.
    function _placeRemainder(uint256[] memory wBps, uint256[] memory capBps, uint256[] memory raw) internal pure {
        uint256 n = wBps.length;
        uint256 total;
        for (uint256 i = 0; i < n; i++) total += wBps[i];
        if (total >= BPS_DENOM) return;
        uint256 leftover = BPS_DENOM - total;

        // Repeatedly give the leftover to the best-scoring vault with room.
        for (uint256 pass = 0; pass < n && leftover > 0; pass++) {
            uint256 best = type(uint256).max;
            for (uint256 i = 0; i < n; i++) {
                if (wBps[i] >= capBps[i]) continue;
                if (best == type(uint256).max || raw[i] > raw[best]) best = i;
            }
            if (best == type(uint256).max) return; // every vault is at its cap
            uint256 room = capBps[best] - wBps[best];
            uint256 give = room < leftover ? room : leftover;
            wBps[best] += give;
            leftover -= give;
        }
    }
}
