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

import {
    CoreStorage,
    ERC20Storage,
    ParamsStorage,
    GovernanceStorage,
    RolesStorage,
    AllocationStorage,
    EcosystemStorage,
    DividendStorage,
    StreamStorage,
    ReentrancyStorage
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

    // ERC-20
    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    // Roles (ported from ScopedRoles)
    event RoleQueued(bytes32 indexed role, address indexed next, uint64 eta);
    event RoleApplied(bytes32 indexed role, address indexed previous, address indexed next);

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
    error BadBatch();
    error ShortDelivery();
    error ConstituentExiting();
    error AllocationCapExceeded();
    error EcosystemSinkUnset();
    error ApprovalNotConsumed();

    error NotRoleHolder(bytes32 role);
    error UnknownRole(bytes32 role);
    error BadRoleHolder();
    error NoRoleQueued();
    error RoleTimelockNotElapsed();

    error ReentrantCall();

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
        emit Checkpointed(token, IndexOracle.observe(c, p.priceCapBps, p.minCheckpointInterval, bootstrap));
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

    function _nav() internal view returns (uint256 navLow, uint256 navHigh) {
        CoreStorage.Layout storage cs = CoreStorage.layout();
        Params storage p = _params();
        return IndexValuation.navBand(cs.constituentList, cs.constituents, p.bandBps, p.staleAfter);
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
}
