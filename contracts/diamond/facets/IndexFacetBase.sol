// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {IIndexPriceSource} from "../../IIndexPriceSource.sol";
import {IndexMath} from "../../lib/IndexMath.sol";
import {Observation, Constituent, OBS_SLOTS as TYPES_OBS_SLOTS} from "../../lib/IndexTypes.sol";
import {IndexValuation} from "../../lib/IndexValuation.sol";
import {IndexOracle} from "../../lib/IndexOracle.sol";
import {IndexEligibility} from "../../lib/IndexEligibility.sol";
import {IndexParams, IndexParamSet as Params} from "../../lib/IndexParams.sol";
import {IndexPoolValuation} from "../../lib/IndexPoolValuation.sol";
import {IIndexCoinPool} from "../../IIndexCoinPool.sol";

import {
    CoreStorage,
    ERC20Storage,
    ParamsStorage,
    GovernanceStorage,
    RolesStorage,
    AllocationStorage,
    EcosystemStorage,
    DividendStorage,
    ValueAccrualStorage,
    StreamStorage,
    WeightStorage,
    PoolStorage,
    ReentrancyStorage,
    HooksStorage
} from "../storage/IndexStorage.sol";

/**
 * ============================================================================
 *  IndexFacetBase — the shared, STATELESS base every index facet extends.
 *
 *  NOT FOR DEPLOYMENT. `abstract`, and it has no selectors of its own.
 *
 *  WHY A BASE CONTRACT AND NOT A `library`
 *  ---------------------------------------
 *  Three reasons, and the first is the load-bearing one.
 *
 *  1. ABI SURFACE. Every `error` and `event` the ~519 existing tests name —
 *     `NotListed`, `SlippageExceeded`, `RedeemedProRata`, … — has to appear in
 *     the ABI of the facet that can throw or emit it, because the tests assert
 *     on them BY NAME through the combined handle. Errors and events declared
 *     in a base contract are inherited into each facet's ABI unconditionally.
 *     That is a guarantee; library-error ABI inclusion is a compiler detail.
 *
 *  2. NO DEPLOYED BYTECODE. Everything here is `internal`, so it is INLINED
 *     into each facet. There is no second deployed object, and therefore no
 *     `DELEGATECALL` — which matters because `LibBytecodeScan` rejects opcode
 *     `0xf4` in any facet outright. This is the same decision design doc
 *     section 2.4 makes for the five `lib/` libraries, applied one level up:
 *     the scan and the internal-linkage choice are ONE decision, not two.
 *
 *  3. DEAD-CODE ELIMINATION. solc drops internal functions a given facet never
 *     calls, so `IndexCoreFacet` does not carry the oracle's variance
 *     accumulator and `IndexLensFacet` does not carry the payout path. Each
 *     facet pays only for what it uses, which is the whole point of the split.
 *
 *  THE RULE THIS FILE MUST NEVER BREAK
 *  -----------------------------------
 *  IT DECLARES NO STATE VARIABLE. Not one, not ever, and neither may anything
 *  that inherits it. Only `constant`s, errors, events, modifiers and functions.
 *  A single inherited mapping here would land on the diamond's own slot 0 in
 *  EVERY facet at once. `Diamond.storage.test.ts` reads solc's emitted
 *  `storageLayout` for every facet and fails the build on any non-constant
 *  entry, so this is checked rather than merely intended.
 *
 *  PROVENANCE
 *  ----------
 *  Every constant, guard and internal below is a VERBATIM port of
 *  GlobalHexVault's — same value, same rounding direction, same revert. Where
 *  the monolith read `constituentList` it now reads `CoreStorage.layout().constituentList`,
 *  and that substitution is the entire diff. The design doc's instruction is
 *  that the claims survive the refactor, so the arithmetic is not re-derived,
 *  re-optimised or "tidied" anywhere in this port.
 * ============================================================================
 */
abstract contract IndexFacetBase {
    using SafeERC20 for IERC20;

    // ── Constants (verbatim from GlobalIndexVault) ─────────────────────────

    uint256 internal constant BPS = 10_000;
    uint256 internal constant WAD = 1e18;

    uint256 internal constant VIRTUAL_SHARES = 10 ** 3;
    uint256 internal constant VIRTUAL_ASSETS = 1;

    uint256 internal constant MAX_CONSTITUENTS = 32;
    uint256 internal constant OBS_SLOTS = TYPES_OBS_SLOTS;
    uint256 internal constant MIN_SEED_SHARES = 1e6;

    /**
     * @dev NAMED `_ADDR` and kept `internal` DELIBERATELY.
     *
     * The monolith had `address public constant SEED_LOCK`. A `public constant`
     * on a shared facet BASE would generate the identical getter — and therefore
     * the identical 4-byte selector — in every facet that inherits it, and
     * `diamondCut` rejects a selector that is already owned. The public getter
     * therefore lives in exactly ONE facet (`IndexShareFacet.SEED_LOCK()`), and
     * the value lives here so every facet still reads the same constant.
     * `INDEX_VERSION` is the same situation and is handled the same way.
     */
    address internal constant SEED_LOCK_ADDR = 0x000000000000000000000000000000000000dEaD;

    uint256 internal constant CEIL_PLATFORM_ALLOCATION_BPS = 500;
    uint256 internal constant DEFAULT_PLATFORM_ALLOCATION_BPS = 200;
    uint256 internal constant CEIL_ECOSYSTEM_SPLIT_BPS = 3_000;
    uint256 internal constant DEFAULT_ECOSYSTEM_SPLIT_BPS = 2_000;

    uint256 internal constant DEFAULT_TARGET_HHI_BPS = 2_000;
    uint256 internal constant MIN_TARGET_HHI_BPS = 200;
    uint256 internal constant MAX_TARGET_HHI_BPS = BPS;

    uint256 internal constant VOL_STEP_BPS = 100;
    uint256 internal constant MIN_REQUIRED_CHECKPOINTS = 2;
    uint256 internal constant MAX_REQUIRED_CHECKPOINTS = OBS_SLOTS;
    uint256 internal constant EXIT_WINDOW_EXTRA_CHECKPOINTS = 2;
    uint256 internal constant ELIGIBILITY_GAS_CAP = 50_000;

    uint256 internal constant PAYOUT_GAS = 250_000;

    /// @dev Gas ceiling on a stream `balanceOf` probe, ported verbatim from
    /// WrappedIndexShare. A view that needs more than this is not a token, it
    /// is a liability.
    uint256 internal constant PROBE_GAS = 100_000;

    /// @dev Gas ceiling on an observer hook `CALL` (design doc section 8, rule
    /// 2). Same 63/64-rule reasoning as `PAYOUT_GAS` / `PROBE_GAS`: bounding
    /// the gas FORWARDED is what makes the bound on what a hostile hook can
    /// consume real, rather than a hope. Sized generously above `PROBE_GAS`
    /// (a handful of COLD `SSTORE`s, EIP-2929-priced, plus dispatch) so an
    /// honest observer that records a couple of words is not starved by the
    /// same bound that exists to stop a hostile one.
    uint256 internal constant HOOK_GAS = 150_000;

    /// @notice Disclosed, deliberate bound on iterated stream assets. Same
    /// value as MAX_CONSTITUENTS, same reasoning: `redeemProRata` must stay
    /// gas-safe as the stream count grows, and 32 is generous headroom.
    uint256 internal constant MAX_STREAMS = 32;

    /**
     * @dev Round-9f re-vest window, ported verbatim from WrappedIndexShare. A
     * CONSTANT, deliberately: nothing settable here, because anything settable
     * would be a lever over when users can redeem. See WrappedIndexShare.sol's
     * header ("ROUND 9f") for the full derivation.
     */
    uint256 internal constant STREAM_VEST_BLOCKS = 300;

    /**
     * @dev §7.5/§7.6 continuous constituent weight, ported block-based timing
     * from `STREAM_VEST_BLOCKS`/`_addVest`/`_unvestedOf` above and adapted from
     * a per-stream vest AMOUNT to a per-constituent weight SCORE (design doc
     * DESIGN-N-VAULT-FACTORY-AND-VALUE-ACCRUAL-2026-08-06.md §7.5, §7.6).
     *
     * `WEIGHT_MATURITY_BLOCKS` is the window a freshly-recorded fee receipt
     * takes to finish converting from `unvested` into `matured` — same shape
     * as `STREAM_VEST_BLOCKS`, reused at the same value so a burst of activity
     * at Δh = 0 contributes m(0) = 0 exactly, matching the round-9f-style bound
     * already proven for stream vesting.
     *
     * `WEIGHT_DORMANCY_BLOCKS` is deliberately a LARGER, separate window: it is
     * the horizon over which an already-`matured` weight decays toward zero
     * from pure inactivity (no analogue in the stream-vest port, because
     * streams never decay — only constituent weight does, per §7.5 rule 4).
     * Keeping it wider than the maturity window matters: if the two windows
     * were equal, a constituent's weight would finish maturing at the exact
     * block its decay clock also finishes zeroing it out, so sustained
     * activity could never actually reach near-full weight. Ten maturity
     * windows of headroom is what makes "sustained activity over the maturity
     * window produces weight approaching full value" achievable in practice.
     */
    uint256 internal constant WEIGHT_MATURITY_BLOCKS = STREAM_VEST_BLOCKS;
    uint256 internal constant WEIGHT_DORMANCY_BLOCKS = STREAM_VEST_BLOCKS * 10;

    /// @dev The `M` in `revest = net * M * w / (S + w + VIRTUAL_SHARES)`.
    /// `M = 25` bounds atomic capture at 1% and the salami-sliced limit at 4%.
    uint256 internal constant DILUTION_REVEST_MULTIPLE = 25;

    uint256 internal constant MAGNITUDE = 2 ** 64;
    uint256 internal constant MAX_MAGNIFIED_PER_SHARE = 2 ** 126;
    uint256 internal constant MAX_PUSH_HEADROOM_DIVISOR = 2 ** 32;
    uint256 internal constant MAX_SHARE_SUPPLY = 2 ** 128;

    /// @dev Generation marker. `internal` for the same selector-collision
    /// reason as `SEED_LOCK_ADDR`; exposed once, by `IndexLensFacet`.
    uint256 internal constant INDEX_VERSION_ = 1;

    // ── Role keys ──────────────────────────────────────────────────────────
    //
    // `constant`, so they are baked identically into every facet's bytecode.
    // TRAILING UNDERSCORE, for the same reason as `SEED_LOCK_ADDR`: the monolith
    // declared these `public`, and a `public constant` on a shared facet base
    // would emit the identical getter — and therefore the identical selector —
    // in every facet, which `diamondCut` rejects. The five public getters live
    // in exactly one facet, `IndexGovernanceFacet`, which is also the only facet
    // that has anything to do with roles.
    // Design doc section 3.3 rule 2 only forces the three former `immutable`s
    // into storage; a `constant` cannot differ between facets and therefore
    // stays exactly where it was.

    bytes32 internal constant ROLE_ADMIN_ = "role.admin";
    bytes32 internal constant ROLE_CONSTITUENT_ADMISSION_ = "vault.admission";
    bytes32 internal constant ROLE_RISK_PARAM_ = "vault.risk";
    bytes32 internal constant ROLE_PLATFORM_ALLOCATION_ = "vault.allocation";
    /// @notice The wrapper's stream-listing capability, joining the vault's
    /// role set as design doc section 2.3 specifies. It reaches no value path.
    bytes32 internal constant ROLE_STREAM_LISTER_ = "vault.streams";

    // ── Hook points (design doc section 8) ──────────────────────────────────
    //
    // COMPILE-TIME CONSTANTS, not caller input — `HookRegistryFacet.registerHook`
    // can only ever populate one of these three keys (§8 rule 4), and NONE of
    // them fires anywhere on `redeemProRata`, `claimPending` or
    // `claimPendingMany` (§8 rule 5, asserted by `Hooks.exitDoorFree.test.ts`).

    bytes32 internal constant HOOK_AFTER_LISTING_ = keccak256("hook.after_listing");
    bytes32 internal constant HOOK_AFTER_CHECKPOINT_ = keccak256("hook.after_checkpoint");
    bytes32 internal constant HOOK_AFTER_SYNC_ = keccak256("hook.after_sync");

    function _isKnownHookPoint(bytes32 point) internal pure returns (bool) {
        return point == HOOK_AFTER_LISTING_ || point == HOOK_AFTER_CHECKPOINT_ || point == HOOK_AFTER_SYNC_;
    }

    // ── Events (verbatim) ──────────────────────────────────────────────────

    event ConstituentQueued(address indexed token, uint64 eta, bool removal);
    event ConstituentListed(address indexed token, address source, uint256 rawWeightBps);
    event ConstituentDeactivated(address indexed token);
    event ConstituentDelisted(address indexed token);
    event ParamQueued(bytes32 indexed key, uint256 value, uint64 eta);
    event ParamApplied(bytes32 indexed key, uint256 value);
    event Seeded(address indexed token, uint256 amount);
    event IndexOpened(uint256 lockedSeedShares);
    event Checkpointed(address indexed token, uint256 price);
    event MintedProRata(address indexed to, uint256 shares);
    event RedeemedProRata(address indexed from, uint256 shares);
    event MintedSingle(address indexed to, address indexed token, uint256 amountIn, uint256 shares);
    event RedeemedSingle(address indexed from, address indexed token, uint256 shares, uint256 amountOut);
    event MetricUpdated(address indexed token, uint256 metric);
    event EligibleCountUpdated(uint256 eligibleCount, uint256 effectiveCapBps);
    event EcosystemFeesHarvested(address indexed token, address indexed sink, uint256 amount);
    event DividendsReceived(address indexed from, uint256 amount, uint256 eligibleSupply);
    event DividendClaimed(address indexed account, uint256 amount);
    event PayoutDeferred(address indexed account, address indexed token, uint256 amount);
    event PendingClaimed(address indexed account, address indexed token, uint256 amount);
    event ConstituentSynced(address indexed token, uint256 credited);
    event DividendsDeferred(uint256 amount, uint256 carried);
    event ValueAccrualSplitApplied(uint256 dividendBps, uint256 buybackBps);
    event BuybackEarmarked(address indexed token, uint256 amount);
    /// @notice §7.5: a confirmed on-chain fee receipt was recorded toward
    /// `token`'s continuous weight. `amount` is always the SAME balance-delta
    /// `_sync` already measured for `ConstituentSynced` — never a
    /// caller-supplied number, and never emitted from anywhere else.
    event ConstituentActivityRecorded(address indexed token, uint256 amount);

    // Streams (ported from WrappedIndexShare)
    event StreamQueued(address indexed token, uint64 eta);
    event StreamListed(address indexed token);
    event StreamDelisted(address indexed token);
    event StreamPruned(address indexed token);
    event StreamFunded(address indexed token, address indexed from, uint256 credited);

    // ERC-20
    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    // Roles (ported from ScopedRoles)
    event RoleQueued(bytes32 indexed role, address indexed next, uint64 eta);
    event RoleApplied(bytes32 indexed role, address indexed previous, address indexed next);

    // Hooks (design doc section 8)
    /// @notice A hook registration was queued. Mirrors `ParamQueued`/
    /// `ConstituentQueued`/`StreamQueued` — every risk-surface change queues
    /// through the vault's one timelock before it can take effect.
    event HookQueued(bytes32 indexed point, address indexed hook, uint16 permissions, uint64 eta);
    event HookRegistered(bytes32 indexed point, address indexed hook, uint16 permissions);
    /// @notice A registered hook reverted, ran out of its bounded gas, or was
    /// not a contract. Emitted instead of propagating — see `_fireHook`: the
    /// underlying operation this hook observed has already fully committed.
    event HookFailed(bytes32 indexed point, address indexed hook);

    // ── Errors (verbatim) ──────────────────────────────────────────────────

    error NotSeeder();
    error IndexNotOpen();
    error IndexAlreadyOpen();
    error AlreadyListed();
    error NotListed();
    error TooManyConstituents();
    error BadParam();
    error NothingQueued();
    error TimelockNotElapsed();
    error ZeroAmount();
    error SlippageExceeded();
    error ConcentrationCapExceeded();
    error ReserveWouldEmpty();
    error CheckpointTooSoon();
    error NoPriceData();
    error StalePrice();
    error PersistenceCheckFailed();
    error ReservesOutstanding();
    /// @dev The mirror image of `InvalidStream`'s already-a-constituent check
    /// in `IndexStreamFacet._validateStreamCandidate`: a token already tracked
    /// as a reward stream cannot ALSO be admitted as a constituent. Two
    /// registries claiming the same token would let a stream deposit (no
    /// weight, no price source, no pro-rata accounting) collide with a
    /// constituent's priced, weighted, capped accounting for the identical
    /// balance.
    error TokenIsRegisteredStream();
    error BadBatch();
    error ShortDelivery();
    error ConstituentExiting();
    error AllocationCapExceeded();
    error EcosystemSinkUnset();
    error ApprovalNotConsumed();

    // §7.10 — the dedicated index-coin pool
    error PoolAlreadySet();
    error PoolActedThisBlock();
    error InsufficientPoolFunding();
    /// @dev Adversarial-review fix (2026-08-06): `deployToIndexPool` would
    /// exceed the governed cap on cumulative shares minted to the pool
    /// (`PoolStorage.maxPoolShareBps` of `totalSupply`) — see that function's
    /// header for why this cap exists at all.
    error PoolShareCapExceeded();

    error NotRoleHolder(bytes32 role);
    error UnknownRole(bytes32 role);
    error BadRoleHolder();
    error NoRoleQueued();
    error RoleTimelockNotElapsed();

    error ReentrantCall();

    // Hooks (design doc section 8)
    error InvalidHookPoint(bytes32 point);

    // Streams (ported from WrappedIndexShare)
    error InvalidStream();
    error StreamAlreadyListed();
    error StreamCapReached();
    error NotAStream();
    error NoStreamQueued();
    error StreamTimelockNotElapsed();
    error StreamStillListed();
    error StreamNotEmpty();
    error NothingCredited();

    /// @dev Named rather than folded into `ZeroAmount`: an ERC-20 balance or
    /// allowance shortfall is a different failure from a zero-amount call, and
    /// an audited ABI that conflates them is a lie about what the contract can
    /// do. OpenZeppelin 4.x used revert STRINGS here; a custom error is the
    /// same claim, cheaper, and typed.
    error InsufficientBalance(address from, uint256 have, uint256 want);
    error InsufficientAllowance(address owner, address spender, uint256 have, uint256 want);

    // ── Guards ─────────────────────────────────────────────────────────────

    /**
     * @dev ONE reentrancy word for the WHOLE diamond, in its own namespace.
     *
     * This is strictly stronger than the monolith's guard, not merely
     * equivalent: OpenZeppelin's `ReentrancyGuard` is per-contract, so under a
     * naive port `nonReentrant` on `IndexCoreFacet` would not have excluded a
     * reentrant call into `IndexDividendFacet`. Sharing one namespaced word
     * restores — and widens — cross-facet exclusion.
     */
    modifier nonReentrant() {
        ReentrancyStorage.Layout storage r = ReentrancyStorage.layout();
        if (r.status == ReentrancyStorage.ENTERED) revert ReentrantCall();
        r.status = ReentrancyStorage.ENTERED;
        _;
        r.status = ReentrancyStorage.NOT_ENTERED;
    }

    modifier whenOpen() {
        if (!CoreStorage.layout().indexOpen) revert IndexNotOpen();
        _;
    }

    modifier onlyRole(bytes32 role) {
        if (msg.sender != RolesStorage.layout().roleHolder[role]) revert NotRoleHolder(role);
        _;
    }

    function _isKnownRole(bytes32 role) internal pure returns (bool) {
        return
            role == ROLE_ADMIN_ ||
            role == ROLE_CONSTITUENT_ADMISSION_ ||
            role == ROLE_RISK_PARAM_ ||
            role == ROLE_PLATFORM_ALLOCATION_ ||
            role == ROLE_STREAM_LISTER_;
    }

    // ── Storage accessors, spelled out once ────────────────────────────────

    function _params() internal view returns (Params storage) {
        return ParamsStorage.layout().params;
    }

    function _get(address token) internal view returns (Constituent storage c) {
        c = CoreStorage.layout().constituents[token];
        if (!c.listed) revert NotListed();
    }

    // ══ ERC-20, over the `erc20` namespace ═════════════════════════════════
    //
    // Hand-written rather than inherited from OpenZeppelin, and that is forced
    // rather than chosen: `ERC20` declares `_balances` at slot 0 of whatever
    // inherits it, which under DELEGATECALL is the diamond's own slot 0 — i.e.
    // directly on top of the EIP-2535 selector table. The semantics below are
    // OZ 4.x's, transfer-for-transfer, including the zero-address checks, the
    // infinite-allowance shortcut in `_spendAllowance`, and the `_afterTokenTransfer`
    // dividend hook firing on mint (`from == 0`) and burn (`to == 0`) alike.

    function _totalSupply() internal view returns (uint256) {
        return ERC20Storage.layout().totalSupply;
    }

    function _balanceOf(address a) internal view returns (uint256) {
        return ERC20Storage.layout().balances[a];
    }

    function _transferShares(address from, address to, uint256 value) internal {
        if (from == address(0) || to == address(0)) revert BadParam();
        ERC20Storage.Layout storage s = ERC20Storage.layout();
        uint256 bal = s.balances[from];
        if (bal < value) revert InsufficientBalance(from, bal, value);
        unchecked {
            s.balances[from] = bal - value;
            s.balances[to] += value;
        }
        emit Transfer(from, to, value);
        _afterTokenTransfer(from, to, value);
    }

    function _mintShares(address to, uint256 value) internal {
        if (to == address(0)) revert BadParam();
        ERC20Storage.Layout storage s = ERC20Storage.layout();
        s.totalSupply += value;
        unchecked {
            s.balances[to] += value;
        }
        emit Transfer(address(0), to, value);
        _afterTokenTransfer(address(0), to, value);
    }

    function _burnShares(address from, uint256 value) internal {
        ERC20Storage.Layout storage s = ERC20Storage.layout();
        uint256 bal = s.balances[from];
        if (bal < value) revert InsufficientBalance(from, bal, value);
        unchecked {
            s.balances[from] = bal - value;
            s.totalSupply -= value;
        }
        emit Transfer(from, address(0), value);
        _afterTokenTransfer(from, address(0), value);
    }

    function _approveShares(address owner, address spender, uint256 value) internal {
        if (owner == address(0) || spender == address(0)) revert BadParam();
        ERC20Storage.layout().allowances[owner][spender] = value;
        emit Approval(owner, spender, value);
    }

    function _spendAllowance(address owner, address spender, uint256 value) internal {
        uint256 current = ERC20Storage.layout().allowances[owner][spender];
        if (current != type(uint256).max) {
            if (current < value) revert InsufficientAllowance(owner, spender, current, value);
            unchecked {
                _approveShares(owner, spender, current - value);
            }
        }
    }

    /**
     * @dev THE DIVIDEND CORRECTION HOOK, ported argument for argument.
     *
     * No external call, no `require`, no division, and one multiplication whose
     * range is pinned by two compile-time bounds — so it cannot revert a
     * transfer, and that is a proof rather than an intention. Design doc
     * section 5.4 rejects generalising the accumulator over the stream set
     * precisely so this stays ONE asset and O(1); the property "the hook
     * cannot brick a transfer" therefore carries over unmodified.
     */
    function _afterTokenTransfer(address from, address to, uint256 value) internal {
        if (from == address(0) && ERC20Storage.layout().totalSupply > MAX_SHARE_SUPPLY) {
            revert BadParam();
        }
        DividendStorage.Layout storage d = DividendStorage.layout();
        int256 correction = int256(d.magnifiedDividendPerShare * value);
        if (from != address(0)) d.magnifiedDividendCorrections[from] += correction;
        if (to != address(0)) d.magnifiedDividendCorrections[to] -= correction;
    }

    // ══ Oracle internals ══════════════════════════════════════════════════

    function _observe(address token, Constituent storage c, bool bootstrap) internal {
        Params storage p = _params();
        uint256 price = IndexOracle.observe(c, p.priceCapBps, p.minCheckpointInterval, bootstrap);
        emit Checkpointed(token, price);
        _fireHook(HOOK_AFTER_CHECKPOINT_, abi.encode(token, price));
    }

    function _last(Constituent storage c) internal view returns (Observation memory) {
        return c.obs[c.obsHead];
    }

    function _priceBand(address token) internal view returns (uint256 low, uint256 high, uint256 twap) {
        Params storage p = _params();
        return IndexOracle.priceBand(_get(token), p.bandBps, p.staleAfter);
    }

    function _requiredCheckpoints(uint256 ethValue) internal view returns (uint256) {
        Params storage p = _params();
        return IndexMath.requiredCheckpoints(ethValue, p.persistenceCheckpoints, p.largeOpValueWei, OBS_SLOTS);
    }

    function _requiredCheckpointsFor(address token, uint256 ethValue) internal view returns (uint256) {
        uint256 required = _requiredCheckpoints(ethValue) + IndexOracle.realizedVol(_get(token)) / VOL_STEP_BPS;
        uint256 floorReq = _params().persistenceCheckpoints;
        if (floorReq < MIN_REQUIRED_CHECKPOINTS) floorReq = MIN_REQUIRED_CHECKPOINTS;
        if (required < floorReq) required = floorReq;
        if (required > MAX_REQUIRED_CHECKPOINTS) required = MAX_REQUIRED_CHECKPOINTS;
        return required;
    }

    function _persistenceHoldsFor(address token, uint256 required) internal view returns (bool) {
        Params memory p = _params();
        return
            IndexOracle.persistenceHoldsFor(
                _get(token),
                required,
                p.bandBps,
                p.staleAfter,
                p.persistenceToleranceBps
            );
    }

    function _requirePersistenceIfLarge(address token, uint256 ethValue, bool exitWindow) internal view {
        if (ethValue < _params().largeOpValueWei) return;
        uint256 required = _requiredCheckpointsFor(token, ethValue);
        if (exitWindow && _exitWindowOpen(token)) {
            required += EXIT_WINDOW_EXTRA_CHECKPOINTS;
            if (required > MAX_REQUIRED_CHECKPOINTS) required = MAX_REQUIRED_CHECKPOINTS;
        }
        if (!_persistenceHoldsFor(token, required)) revert PersistenceCheckFailed();
    }

    function _exitWindowOpen(address token) internal view returns (bool) {
        CoreStorage.Layout storage cs = CoreStorage.layout();
        GovernanceStorage.Layout storage gs = GovernanceStorage.layout();
        Constituent storage tc = cs.constituents[token];
        GovernanceStorage.QueuedListing storage tq = gs.queuedListings[token];
        if (!tc.active || (tq.pending && tq.isRemoval)) return false;
        uint256 n = cs.constituentList.length;
        for (uint256 i = 0; i < n; i++) {
            GovernanceStorage.QueuedListing storage q = gs.queuedListings[cs.constituentList[i]];
            if (q.pending && q.isRemoval) return true;
        }
        return false;
    }

    function _requireNotExiting(address token, Constituent storage c) internal view {
        if (!c.active) revert ConstituentExiting();
        GovernanceStorage.QueuedListing storage q = GovernanceStorage.layout().queuedListings[token];
        if (q.pending && q.isRemoval) revert ConstituentExiting();
    }

    // ══ Eligibility + the dynamic cap ═════════════════════════════════════

    function _checkEligibility(address constituent)
        internal
        view
        returns (bool eligible, uint256 feesWei, uint256 elapsedBlocks)
    {
        ParamsStorage.Layout storage ps = ParamsStorage.layout();
        return
            IndexEligibility.checkEligibility(
                constituent,
                ps.minEligibilityFeesWei,
                ps.minEligibilityBlocks,
                ELIGIBILITY_GAS_CAP
            );
    }

    function _recomputeEligibleCount() internal {
        CoreStorage.Layout storage cs = CoreStorage.layout();
        uint256 count;
        uint256 n = cs.constituentList.length;
        for (uint256 i = 0; i < n; i++) {
            address t = cs.constituentList[i];
            if (!cs.constituents[t].active) continue;
            (bool ok, , ) = _checkEligibility(t);
            if (ok) count++;
        }
        cs.eligibleConstituentCount = count;
        emit EligibleCountUpdated(count, _effectiveCapBps());
    }

    function _effectiveCapBps() internal view returns (uint256) {
        uint256 dyn = IndexMath.capBpsFor(
            CoreStorage.layout().eligibleConstituentCount,
            ParamsStorage.layout().targetHhiBps
        );
        uint256 flat = _params().concentrationCapBps;
        return dyn < flat ? dyn : flat;
    }

    // ══ Valuation ═════════════════════════════════════════════════════════

    /**
     * @dev §7.10: the dedicated index-coin/payment-token pool's own live
     * position (see `IndexPoolValuation`'s header for the closed-form
     * derivation) is folded in HERE, at the one place every NAV consumer in
     * this facet set already reads through — `IndexLensFacet.nav()`,
     * `IndexTradeFacet.mintSingleAsset`/`redeemSingleAsset` (both via
     * `_nav`/`_previewSingleExit`), and `IndexPoolFacet.deployToIndexPool`
     * itself. `redeemProRata` in `IndexCoreFacet` deliberately never reaches
     * this function at all (see that file's header — "it reads no price"),
     * so the pool's valuation has no bearing on the free exit door either
     * before or after this change.
     *
     * `PoolStorage.layout().pool == address(0)` (no pool configured yet) is
     * the untouched default, and `IndexPoolValuation.includePool` treats an
     * all-zero pool position identically to "no pool" — so every existing
     * test, none of which ever calls `setIndexPool`, observes byte-for-byte
     * the same `_nav()` this function returned before this change.
     */
    function _nav() internal view returns (uint256 navLow, uint256 navHigh) {
        CoreStorage.Layout storage cs = CoreStorage.layout();
        Params storage p = _params();
        (navLow, navHigh) = IndexValuation.navBand(cs.constituentList, cs.constituents, p.bandBps, p.staleAfter);
        address pool = PoolStorage.layout().pool;
        if (pool != address(0)) {
            (uint256 poolPayment, uint256 poolCoin) = IIndexCoinPool(pool).getReserves();
            (navLow, navHigh) = IndexPoolValuation.includePool(navLow, navHigh, poolPayment, poolCoin, _totalSupply());
        }
    }

    /**
     * @dev §7.10 test-5's same-block staleness guard: refuse a NAV-priced
     * mutation if the pool's reserves moved (a swap OR a `deploy`) in THIS
     * block. A same-block swap-then-mint/redeem is the one shape where the
     * closed-form valuation's live reserve read is momentarily off the
     * pool's own no-fee marginal price (the trade that just landed paid the
     * pool's 1% fee, which is real value the pool keeps, but the two
     * reserves are transiently away from the ratio a stateless external
     * observer would infer) — bounding WHEN a NAV-priced action may run
     * relative to a pool action is what makes "cannot extract value through
     * staleness" a proven property instead of an assumption. No-op when no
     * pool is configured.
     *
     * DOCUMENTED RESIDUAL RISK (adversarial review, 2026-08-06), left
     * explicitly unaddressed rather than silently: this guard is a SAME-BLOCK
     * check only. It blocks an atomic swap-then-price-dependent-action in one
     * transaction, but it does NOT block a swap in block N followed by a
     * NAV-priced action in block N+1 — no guard anywhere fires on that shape,
     * because `lastActionBlock()` has already moved on by the time block N+1
     * starts. A price distortion that persists across a block boundary (e.g.
     * a large swap left unarbitraged for one block) is therefore still
     * usable against `deployToIndexPool`/`mintSingleAsset`/`redeemSingleAsset`
     * within that window. A TWAP-style multi-block average, or widening this
     * guard's window past same-block, would close it, at the cost of real
     * added complexity (an accumulator in `IndexCoinPool` itself) this pass
     * does not take on. Treated as a bounded, disclosed residual: the same
     * class of risk every AMM-price-consuming integration carries, not a
     * silent gap.
     */
    function _requirePoolQuiescent() internal view {
        address pool = PoolStorage.layout().pool;
        if (pool == address(0)) return;
        if (IIndexCoinPool(pool).lastActionBlock() == block.number) revert PoolActedThisBlock();
    }

    function _allWeightsBps() internal view returns (uint256[] memory) {
        CoreStorage.Layout storage cs = CoreStorage.layout();
        Params storage p = _params();
        return IndexValuation.allWeightsBps(cs.constituentList, cs.constituents, p.bandBps, p.staleAfter);
    }

    /**
     * @dev No basket OPERATION may push a constituent further over the cap.
     * Note that this covers the WHOLE basket, not just the leg the caller
     * named — a large exit from one leg mechanically raises every other leg's
     * share of NAV, and a target-only check waved that through.
     */
    function _requireCapNotWorsened(uint256[] memory weightsBefore) internal view {
        uint256[] memory now_ = _allWeightsBps();
        uint256 cap = _effectiveCapBps();
        for (uint256 i = 0; i < now_.length; i++) {
            if (now_[i] > cap && now_[i] > weightsBefore[i]) revert ConcentrationCapExceeded();
        }
    }

    function _imbalanceFeeBps(uint256 amount, uint256 against) internal view returns (uint256) {
        Params memory p = _params();
        return
            IndexMath.imbalanceFeeBps(
                amount,
                against,
                p.baseImbalanceFeeBps,
                p.imbalanceSlopeBps,
                p.maxImbalanceFeeBps
            );
    }

    function _mintFeeBps(address token, uint256 depthFee) internal view returns (uint256) {
        CoreStorage.Layout storage cs = CoreStorage.layout();
        return
            IndexValuation.mintFeeBps(
                cs.constituentList,
                cs.constituents,
                token,
                depthFee,
                _effectiveCapBps(),
                _params()
            );
    }

    function _previewSingleExit(uint256 sharesIn, address token)
        internal
        view
        returns (uint256 amountOut, uint256 feeAmount)
    {
        _get(token);
        CoreStorage.Layout storage cs = CoreStorage.layout();
        return
            IndexValuation.previewSingleExit(
                cs.constituentList,
                cs.constituents,
                token,
                sharesIn,
                _totalSupply() + VIRTUAL_SHARES,
                _params()
            );
    }

    // ══ Value movement ════════════════════════════════════════════════════

    /// @dev Read the ACTUAL balance delta, never the nominal amount.
    function _pullCredited(IERC20 token, address from, uint256 amount) internal returns (uint256 credited) {
        uint256 before = token.balanceOf(address(this));
        token.safeTransferFrom(from, address(this), amount);
        credited = token.balanceOf(address(this)) - before;
        if (credited == 0) revert ZeroAmount();
    }

    /**
     * @dev Pay one leg without ever reverting the caller. Bounded gas is what
     * makes the bound real: the 63/64 rule means a hostile constituent cannot
     * consume the gas the remaining legs need.
     */
    function _payOrDefer(address token, address to, uint256 amount) internal returns (bool) {
        if (amount == 0) return true;
        (bool ok, bytes memory data) = token.call{gas: PAYOUT_GAS}(
            abi.encodeWithSelector(IERC20.transfer.selector, to, amount)
        );
        if (ok && (data.length == 0 || (data.length >= 32 && abi.decode(data, (bool))))) {
            return true;
        }
        CoreStorage.Layout storage cs = CoreStorage.layout();
        cs.pendingClaim[to][token] += amount;
        cs.reservedClaims[token] += amount;
        emit PayoutDeferred(to, token, amount);
        return false;
    }

    /**
     * @dev Fire an observer hook, if one is registered at `point`. This is the
     * ENTIRE hook call surface (design doc section 8) — every non-negotiable
     * lives in this one function:
     *
     *  1. `CALL`, never `DELEGATECALL` — `hook.call{...}(...)` on an EXTERNAL
     *     address is opcode 0xF1, and `hook` is never `address(this)` or any
     *     value derived from `this`, so the hook runs entirely in its own
     *     storage and can never touch a diamond namespace.
     *  2. BOUNDED GAS — `HOOK_GAS` forwarded, not all remaining gas. The
     *     63/64 rule (EIP-150) means the CALLER always keeps at least 1/64th
     *     of what it had, so a hook that tries to burn its entire stipend
     *     cannot starve the caller's own remaining execution.
     *  3. NON-REVERTING — the outer `bool ok` is read and NEVER propagated;
     *     a reverting, out-of-gas, or nonexistent hook only emits
     *     `HookFailed` and execution continues exactly as if no hook were
     *     registered.
     *  4. `point` is always one of the three compile-time constants declared
     *     above, passed in by the caller of `_fireHook` — never anything
     *     built from user input.
     *  5. NEVER called from `IndexCoreFacet` — `Hooks.exitDoorFree.test.ts`
     *     and `Diamond.facets.test.ts`'s source-level scan both assert
     *     `IndexCoreFacet` never imports `HooksStorage` at all, so there is
     *     no code path from `redeemProRata`, `claimPending` or
     *     `claimPendingMany` into this function.
     *  6. NEVER ON A VALUE PATH — the return data is discarded entirely.
     *     Nothing a hook returns, or whether it succeeds, is used in any
     *     arithmetic anywhere.
     */
    function _fireHook(bytes32 point, bytes memory data) internal {
        address hook = HooksStorage.layout().hooks[point];
        if (hook == address(0)) return;
        (bool ok, ) = hook.call{gas: HOOK_GAS}(abi.encodeWithSignature("onHook(bytes32,bytes)", point, data));
        if (!ok) emit HookFailed(point, hook);
    }

    /// @dev The ONE writer of `ecosystemFeesWei`.
    function _accrueEcosystem(address token, uint256 feeAmount) internal returns (uint256 cut) {
        EcosystemStorage.Layout storage es = EcosystemStorage.layout();
        if (es.ecosystemSink == address(0) || token != es.ecosystemAsset) return 0;
        uint256 bps = es.ecosystemFeeSplitBps;
        if (bps == 0 || feeAmount == 0) return 0;
        cut = (feeAmount * bps) / BPS; // floors, in existing holders' favour
        if (cut == 0) return 0;
        es.ecosystemFeesWei[token] += cut;
    }

    /**
     * @dev Mint `grossShares` in total, splitting off the platform allocation.
     * The two mints sum to EXACTLY `grossShares`, which is what makes existing
     * holders' NAV-per-share provably unaffected.
     */
    function _mintWithAllocation(address to, uint256 grossShares) internal returns (uint256) {
        AllocationStorage.Layout storage a = AllocationStorage.layout();
        address treasury = a.platformTreasury;
        uint256 bps = a.platformAllocationBps;
        if (treasury == address(0) || bps == 0) {
            _mintShares(to, grossShares);
            return grossShares;
        }
        uint256 cut = (grossShares * bps) / BPS; // floors, in the depositor's favour
        uint256 net = grossShares - cut;
        if (net == 0) revert ZeroAmount();
        _mintShares(to, net);
        if (cut > 0) _mintShares(treasury, cut);
        return net;
    }

    // ══ Listing ═══════════════════════════════════════════════════════════

    function _list(
        address token,
        IIndexPriceSource source,
        uint256 rawTargetWeightBps,
        uint64 rampStart,
        uint64 rampDuration
    ) internal {
        if (token == address(0) || address(source) == address(0)) revert BadParam();
        if (rawTargetWeightBps > BPS) revert BadParam();
        CoreStorage.Layout storage cs = CoreStorage.layout();
        Constituent storage c = cs.constituents[token];
        if (c.listed) revert AlreadyListed();
        // Mirror of `_validateStreamCandidate`'s reverse check: a token
        // already tracked as a reward stream (queued OR live — `tracked` is
        // set the moment `executeStream` lands, before `isStream` even
        // matters) can never also be admitted as a priced, weighted
        // constituent of the same basket.
        if (StreamStorage.layout().tracked[token]) revert TokenIsRegisteredStream();
        if (cs.constituentList.length >= MAX_CONSTITUENTS) revert TooManyConstituents();

        c.source = source;
        c.rawTargetWeightBps = rawTargetWeightBps;
        c.metric = rawTargetWeightBps; // seeded; refined via queueMetric
        c.rampStart = rampStart;
        c.rampDuration = rampDuration;
        c.listed = true;
        c.active = true;
        cs.constituentList.push(token);
        _observe(token, c, true);
        emit ConstituentListed(token, address(source), rawTargetWeightBps);
        _fireHook(HOOK_AFTER_LISTING_, abi.encode(token, address(source), rawTargetWeightBps));
        _recomputeEligibleCount();
    }

    // ══ Dividends ═════════════════════════════════════════════════════════

    function _accumulativeDividendOf(address account) internal view returns (uint256) {
        DividendStorage.Layout storage d = DividendStorage.layout();
        return
            uint256(
                int256(d.magnifiedDividendPerShare * _balanceOf(account)) +
                    d.magnifiedDividendCorrections[account]
            ) / MAGNITUDE;
    }

    function _withdrawableDividendOf(address account) internal view returns (uint256) {
        return _accumulativeDividendOf(account) - DividendStorage.layout().withdrawnDividends[account];
    }

    /// @dev The ONE accumulator write. Never reverts a legitimate push: an
    /// unaccommodated remainder is CARRIED, which is what closes the
    /// one-transaction poisoning attack without introducing a refusal path.
    function _creditDividends(uint256 amount) internal {
        if (amount == 0) revert ZeroAmount();
        DividendStorage.Layout storage d = DividendStorage.layout();
        d.totalDividendsReceived += amount;
        uint256 pot = amount + d.undistributedDividends;

        uint256 seedBal = _balanceOf(SEED_LOCK_ADDR);
        uint256 eligible = _totalSupply() - seedBal;
        if (eligible == 0) {
            d.undistributedDividends = pot;
            emit DividendsReceived(msg.sender, amount, 0);
            return;
        }
        uint256 delta = Math.mulDiv(pot, MAGNITUDE, eligible);

        uint256 room = MAX_MAGNIFIED_PER_SHARE - d.magnifiedDividendPerShare;
        uint256 step = room / MAX_PUSH_HEADROOM_DIVISOR;
        if (step == 0) step = room;
        uint256 carried;
        if (delta > step) {
            delta = step;
            carried = pot - Math.mulDiv(delta, eligible, MAGNITUDE);
        }
        d.undistributedDividends = carried;
        d.magnifiedDividendPerShare += delta;

        if (seedBal > 0) {
            d.magnifiedDividendCorrections[SEED_LOCK_ADDR] -= int256(delta * seedBal);
        }
        if (carried > 0) emit DividendsDeferred(pot, carried);
        emit DividendsReceived(msg.sender, amount, eligible);
    }

    /**
     * @dev §7.3's three-way split, applied at the ONE place newly-routed
     * value is credited (`IndexBootstrapFacet._sync`, reached through both
     * `syncConstituentBalance` and the `reconcile` alias — see that file's
     * header). `amount` is value ALREADY physically held by this contract
     * (measured as a balance-delta surplus by the caller), so this function
     * only ever re-labels accounting, never transfers or fabricates.
     *
     * The dividend leg is credited ONLY when `token == dividendAsset` — the
     * EIP-2222 accumulator is deliberately single-asset (design doc §5.4,
     * `DividendStorage`'s own header), so a share denominated in any other
     * token cannot be force-fit into it. When it does not apply, that share
     * is NEVER stranded: it falls back into `reserveShare` below, which is
     * exactly the "no input can strand a routed dividend" doctrine
     * `IndexDividendFacet` already documents, extended to this split.
     *
     * The buyback leg is a pure accounting increment
     * (`ValueAccrualStorage.buybackEarmarkWei`) — §7.7's mechanism is not
     * built, so there is no transfer, no sink call and no spend path here;
     * the earmarked value remains part of this contract's own balance and
     * therefore part of what `_sync`'s `accounted` subtraction already
     * protects from being re-credited a second time.
     */
    function _creditRoutedValue(address token, Constituent storage c, uint256 amount) internal {
        ValueAccrualStorage.Layout storage va = ValueAccrualStorage.layout();
        uint256 dividendShare = token == CoreStorage.layout().dividendAsset
            ? Math.mulDiv(amount, va.dividendBps, BPS)
            : 0;
        uint256 buybackShare = Math.mulDiv(amount, va.buybackBps, BPS);
        uint256 reserveShare = amount - dividendShare - buybackShare;

        if (reserveShare > 0) c.reserve += reserveShare;
        if (buybackShare > 0) {
            va.buybackEarmarkWei[token] += buybackShare;
            emit BuybackEarmarked(token, buybackShare);
        }
        if (dividendShare > 0) _creditDividends(dividendShare);

        // §7.5: every confirmed routed-value credit is also a fee receipt
        // toward `token`'s continuous weight. Recorded on the FULL `amount`
        // (not a sub-share) — weight tracks confirmed activity, not any one
        // leg of where that activity's value ultimately landed.
        _recordConstituentActivity(token, amount);
    }

    // ══ §7.5 continuous constituent weight ═══════════════════════════════
    //
    // Reuses the exact block-based timing pattern `_addVest`/`_unvestedOf`
    // already prove for stream vesting (round 9e/9f), adapted from a per-
    // stream vest AMOUNT to a per-constituent weight SCORE. See design doc
    // §7.5/§7.6 and the header on `WeightStorage` for the full derivation.
    //
    // THE ONE WRITER: `_recordConstituentActivity`, called from exactly one
    // place — `_creditRoutedValue` above, itself reached only through
    // `IndexBootstrapFacet._sync`'s balance-delta measurement. No function
    // anywhere accepts a caller-supplied weight, activity amount, or score;
    // the only input this mechanism ever sees is `_sync`'s own `credited`
    // value, which is itself a measured surplus, never a nominal argument.
    //
    // NO REMOVAL: nothing in this section ever touches `CoreStorage`'s
    // `constituentList` — a constituent's weight can fall to (near) zero from
    // sustained inactivity, and rise again from renewed activity, but the
    // constituent itself is never ejected from the list by anything here.
    //
    // NO EFFECT ON MINTING: nothing in this section is read by
    // `IndexCoreFacet`'s `mintProRata` or any other deposit-routing path —
    // `Diamond.facets.test.ts`-style source scanning would catch an import of
    // `WeightStorage` from that facet, and `IndexWeight.*.test.ts` exercises
    // the behavioural side directly.

    /// @dev The still-unvested remainder of `token`'s most recent activity
    /// window, read live — a direct structural port of `_unvestedOf` over
    /// `WeightStorage.WeightVest` instead of `StreamStorage.StreamVest`.
    function _weightPendingRemaining(address token) internal view returns (uint256) {
        WeightStorage.WeightVest storage v = WeightStorage.layout().vest[token];
        uint256 u = v.unvested;
        if (u == 0) return 0;
        uint256 end_ = v.end;
        if (block.number >= end_) return 0;
        // `last < end` always holds: `_recordConstituentActivity` writes them
        // together as (n, n + WEIGHT_MATURITY_BLOCKS) with
        // WEIGHT_MATURITY_BLOCKS > 0, the same invariant `_addVest` relies on.
        return Math.mulDiv(u, end_ - block.number, end_ - v.last);
    }

    /// @dev The portion of `token`'s tracked activity that has finished
    /// converting from `unvested` into `matured` as of NOW, without writing
    /// anything — used by both the write path (`_recordConstituentActivity`,
    /// to roll it into storage) and the read path (`_constituentWeight`, to
    /// include it in the live baseline before decay is applied).
    function _weightFreshlyMatured(address token) internal view returns (uint256) {
        WeightStorage.WeightVest storage v = WeightStorage.layout().vest[token];
        return v.unvested - _weightPendingRemaining(token);
    }

    /**
     * @dev THE ONE WRITE to `WeightStorage`. Rolls forward whatever has
     * already matured since the last recorded receipt (never lost, never
     * re-decayed at write time — decay is read-time only, see
     * `_constituentWeight`), then adds the newly-measured `amount` as a fresh
     * fully-`unvested` increment and re-arms the maturity window — exactly
     * the `_addVest` pattern, over a different struct and constant.
     *
     * `amount == 0` is a no-op, mirroring `_addVest`'s own guard.
     */
    function _recordConstituentActivity(address token, uint256 amount) internal {
        if (amount == 0) return;
        WeightStorage.Layout storage ws = WeightStorage.layout();
        WeightStorage.WeightVest storage v = ws.vest[token];
        v.matured += _weightFreshlyMatured(token);
        v.unvested = _weightPendingRemaining(token) + amount;
        v.last = uint64(block.number);
        v.end = uint64(block.number + WEIGHT_MATURITY_BLOCKS);
        emit ConstituentActivityRecorded(token, amount);
    }

    /**
     * @dev `token`'s current §7.5 weight: a PURE function of storage and
     * `block.number`, exactly like `_unvestedOf` — no setter anywhere reaches
     * it, and nothing here is settable by any role or caller.
     *
     * Baseline = already-`matured` weight + whatever has freshly finished
     * maturing since the last recorded receipt (read live, never written back
     * here). That baseline then decays LINEARLY toward zero over
     * `WEIGHT_DORMANCY_BLOCKS` measured from the SAME `v.last` the maturity
     * window uses, so:
     *
     *  - a burst of activity at Δh = 0 (this block) has `matured == 0` and
     *    `freshlyMatured == 0` (the whole receipt is still fully `unvested`
     *    the instant it lands), so the baseline itself is zero — m(0) = 0,
     *    without decay even entering into it;
     *  - sustained activity (repeated receipts, each within
     *    `WEIGHT_DORMANCY_BLOCKS` of the last) keeps resetting `v.last`,
     *    so `elapsed` stays small and the accumulated `matured` baseline
     *    is read back at close to full value;
     *  - a constituent nobody has touched for `WEIGHT_DORMANCY_BLOCKS` or
     *    more reads back as exactly zero, with its entry in `constituentList`
     *    completely untouched — decay is a view-time reinterpretation of
     *    existing storage, never a write that could remove anything.
     */
    function _constituentWeight(address token) internal view returns (uint256) {
        WeightStorage.WeightVest storage v = WeightStorage.layout().vest[token];
        uint256 baseline = v.matured + _weightFreshlyMatured(token);
        if (baseline == 0) return 0;
        uint256 elapsed = block.number - v.last;
        if (elapsed >= WEIGHT_DORMANCY_BLOCKS) return 0;
        return Math.mulDiv(baseline, WEIGHT_DORMANCY_BLOCKS - elapsed, WEIGHT_DORMANCY_BLOCKS);
    }

    // ══ Streams — ported verbatim from WrappedIndexShare (design doc §5.4/§5.5) ══
    //
    // NO PER-HOLDER STATE, ever — the architectural rule WrappedIndexShare.sol
    // states and this port does not relax it. Value accrues to the BACKING
    // POOL, read live and net of `reservedClaims + carry + unvestedOf`, so a
    // passive third-party custodian (an LP pool holding the unified share)
    // gets richer automatically, with zero action of its own.

    /// @dev A stream's backing net of everything already owed or displaced.
    /// `reservedClaims` is the SAME per-token ledger `_payOrDefer` writes for
    /// constituent legs — one deferred-claim ledger for the whole diamond.
    function _netOfStream(address token, uint256 bal) internal view returns (uint256) {
        StreamStorage.Layout storage ss = StreamStorage.layout();
        uint256 res = CoreStorage.layout().reservedClaims[token] + ss.carry[token] + _unvestedOf(token);
        return bal > res ? bal - res : 0;
    }

    /// @dev Pure function of storage and `block.number`. No setter anywhere;
    /// no role can read, write, extend or reach it.
    function _unvestedOf(address token) internal view returns (uint256) {
        StreamStorage.StreamVest storage v = StreamStorage.layout().vest[token];
        uint256 u = v.unvested;
        if (u == 0) return 0;
        uint256 end_ = v.end;
        if (block.number >= end_) return 0;
        // `last < end` always holds: `_addVest` writes them together as
        // (n, n + STREAM_VEST_BLOCKS) with STREAM_VEST_BLOCKS > 0.
        return Math.mulDiv(u, end_ - block.number, end_ - v.last);
    }

    /// @dev A stream's net backing, read through a bounded-gas STATICCALL that
    /// cannot revert the caller. Any failure or short return reads as zero —
    /// a broken stream becomes invisible, never fatal.
    function _probeStreamBalance(address token) internal view returns (uint256) {
        (bool ok, bytes memory data) = token.staticcall{gas: PROBE_GAS}(
            abi.encodeWithSelector(IERC20.balanceOf.selector, address(this))
        );
        if (!ok || data.length < 32) return 0;
        return _netOfStream(token, abi.decode(data, (uint256)));
    }

    /// @dev THE ONE CARRY WRITE. With any wrapped supply at all this is a
    /// no-op; with none, the value is held aside rather than left for the next
    /// depositor to flash-capture. See "THE ZERO-DENOMINATOR CARRY" in
    /// WrappedIndexShare.sol (round 9e).
    function _accrueCarry(address token, uint256 amount) internal {
        if (amount == 0 || _totalSupply() != 0) return;
        StreamStorage.Layout storage ss = StreamStorage.layout();
        ss.carry[token] += amount;
        ss.carryUnlockBlock = type(uint256).max;
    }

    /// @dev Fold every carried balance back into backing once real stake has
    /// been held across a block boundary. Unconditional and permissionless.
    function _foldCarry() internal {
        StreamStorage.Layout storage ss = StreamStorage.layout();
        uint256 unlock_ = ss.carryUnlockBlock;
        if (unlock_ == 0 || block.number < unlock_ || _totalSupply() == 0) return;
        uint256 n = ss.streamList.length;
        for (uint256 i = 0; i < n; i++) ss.carry[ss.streamList[i]] = 0;
        ss.carryUnlockBlock = 0;
    }

    /// @dev Arm the release clock when supply transitions 0 -> nonzero with
    /// something carried. `block.number + 1`: the sole minter who just created
    /// the supply cannot capture the pot in their own transaction.
    function _armCarry() internal {
        StreamStorage.Layout storage ss = StreamStorage.layout();
        if (ss.carryUnlockBlock != 0) ss.carryUnlockBlock = block.number + 1;
    }

    /**
     * @dev THE FIX for the atomic mint->redeem stream-backing extraction
     * (round 9f). Runs AFTER a mint, so it cannot affect the mint's own
     * pricing, and reads streams only through the bounded-gas
     * `_probeStreamBalance`, so a hostile stream can neither revert a mint nor
     * consume its gas.
     *
     * `minted == 0` is a no-op: `mintProRata`/`mintSingleAsset` always mint a
     * nonzero amount on success, so this only ever short-circuits a caller
     * that reverted before reaching here.
     */
    function _revestOnMint(uint256 minted, uint256 supplyBefore) internal {
        if (minted == 0) return;
        StreamStorage.Layout storage ss = StreamStorage.layout();
        uint256 denom = supplyBefore + minted + VIRTUAL_SHARES;
        uint256 n = ss.streamList.length;
        for (uint256 i = 0; i < n; i++) {
            address t = ss.streamList[i];
            uint256 net = _probeStreamBalance(t);
            if (net == 0) continue;
            uint256 amt = minted >= denom / DILUTION_REVEST_MULTIPLE
                ? net
                : Math.mulDiv(net, minted * DILUTION_REVEST_MULTIPLE, denom);
            _addVest(t, amt);
        }
    }

    /// @dev Commit the time-based release so far, then displace `amount` more
    /// and re-arm the window.
    function _addVest(address token, uint256 amount) internal {
        if (amount == 0) return;
        StreamStorage.Layout storage ss = StreamStorage.layout();
        StreamStorage.StreamVest storage v = ss.vest[token];
        v.unvested = _unvestedOf(token) + amount;
        v.last = uint64(block.number);
        v.end = uint64(block.number + STREAM_VEST_BLOCKS);
    }
}
