// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {IndexFacetBase} from "./IndexFacetBase.sol";
import {Constituent} from "../../lib/IndexTypes.sol";
import {CoreStorage, PoolStorage} from "../storage/IndexStorage.sol";
import {IIndexCoinPool} from "../../IIndexCoinPool.sol";

/**
 * ============================================================================
 *  IndexPoolFacet — the ONE new permissionless action design doc §7.10's
 *  2026-08-06 task brief scopes: drawing down already-credited reserve into
 *  protocol-owned liquidity for the dedicated index-coin/payment-token pool.
 *
 *  NOT FOR DEPLOYMENT except as a facet.
 *
 *  WHAT THIS FILE DELIBERATELY DOES NOT TOUCH. `IndexBootstrapFacet._sync`
 *  and `IndexFacetBase._creditRoutedValue` — the existing, already-tested
 *  three-way split every routed token (including the payment token) already
 *  goes through — are untouched by this file. Every token this facet moves
 *  was already `_sync`-credited into `c.reserve` by some EARLIER call; this
 *  facet only ever reads and draws down reserve that is already accounted,
 *  it never intercepts or re-tags an incoming credit.
 *
 *  WHY `shareToken`'S OWN RESERVE IS NEVER PHYSICALLY TOUCHED, AND WHAT
 *  "DRAW DOWN" ACTUALLY MEANS HERE. An earlier draft of this facet
 *  decremented `c.reserve[shareToken]` by `shareAmount` and retired the
 *  slice to `SEED_LOCK_ADDR` — and `IndexPoolFacet.test.ts` caught it
 *  as a REAL value leak, not a rounding artefact: the pool can only ever
 *  hold two assets (payment token and index coin — §7.10 rule 3), so a
 *  retired share-token slice has NO physical asset re-entering the system
 *  anywhere, and burning already-accounted value with nothing offsetting it
 *  is a genuine, provable decrease in `nav()/totalSupply` every single call
 *  (worked out in full in that test's header). `shareAmount` therefore never
 *  leaves `c.reserve[shareToken]` — it is read-only here, used PURELY as
 *  (a) the size input to the identical `mintSingleAsset` pricing formula and
 *  (b) a depth/eligibility ceiling (`shareAmount > c.reserve` still reverts,
 *  so a caller can never reference more than the constituent actually has).
 *  The ONLY reserve this facet ever draws down is `c.reserve[paymentToken]`
 *  — the leg that genuinely can, and does, re-enter the system as the
 *  pool's own payment reserve. That single band-for-band substitution
 *  (payment reserve directly held -> the identical value held inside the
 *  pool, priced by the closed form) is what `IndexPoolFacet.test.ts`
 *  proves is exactly neutral.
 * ============================================================================
 */
contract IndexPoolFacet is IndexFacetBase {
    using SafeERC20 for IERC20;

    event IndexPoolQueued(address indexed pool, uint64 eta);
    event IndexPoolSet(address indexed pool);
    /// @notice Adversarial-review fix (2026-08-06). See `maxPoolShareBps()`'s
    /// header for the full derivation.
    event MaxPoolShareBpsQueued(uint256 value, uint64 eta);
    event MaxPoolShareBpsSet(uint256 value);
    /// @notice 2026-08-06 automation pass: governance change to the
    /// automatic-deploy dust floor (`PoolStorage.minAutoDeployWei`). See
    /// `queueMinAutoDeployWei`'s header.
    event MinAutoDeployWeiQueued(uint256 value, uint64 eta);
    event MinAutoDeployWeiSet(uint256 value);

    /// @dev Hard, non-governable ceiling on `maxPoolShareBps` — 20%. Governance
    /// can tune the cap anywhere from 0 up to this, timelocked, but can never
    /// raise it past a bound fixed in this file's bytecode. Mirrors
    /// `IndexParams.validate`'s "a timelock bounds WHEN a bad change lands,
    /// never HOW BAD it can be" doctrine.
    uint256 private constant MAX_POOL_SHARE_BPS_CEIL = 2_000;
    /// @dev The initial value `executeIndexPool` seeds alongside first pool
    /// activation — 5%, chosen conservative rather than maximal. Changeable
    /// afterward only through `queueMaxPoolShareBps`/`executeMaxPoolShareBps`.
    uint256 private constant DEFAULT_MAX_POOL_SHARE_BPS = 500;

    // ── Admin wiring ──────────────────────────────────────────────────────

    function indexPool() external view returns (address) {
        return PoolStorage.layout().pool;
    }

    function queuedIndexPool() external view returns (address value, uint64 eta, bool pending) {
        PoolStorage.GovernanceQueuedAddress storage q = PoolStorage.layout().queuedPool;
        return (q.value, q.eta, q.pending);
    }

    /**
     * @notice Queue wiring of the dedicated pool. `ROLE_RISK_PARAM_`,
     * timelocked exactly like every other risk-surface change in this facet
     * set (`IndexGovernanceFacet.queuePlatformTreasury`'s identical
     * queue/execute shape) — there is no direct, un-timelocked setter
     * anywhere in this facet set (`IndexDividendAccrual.test.ts` asserts
     * that as a whole-ABI invariant), and this is not the exception.
     */
    function queueIndexPool(address pool) external onlyRole(ROLE_RISK_PARAM_) {
        if (pool == address(0)) revert BadParam();
        if (PoolStorage.layout().pool != address(0)) revert PoolAlreadySet();
        uint64 eta = uint64(block.timestamp + CoreStorage.layout().timelockDelay);
        PoolStorage.layout().queuedPool = PoolStorage.GovernanceQueuedAddress({value: pool, eta: eta, pending: true});
        emit IndexPoolQueued(pool, eta);
    }

    /**
     * @notice Apply a queued pool address once its timelock has elapsed.
     * Permissionless, like every other `execute*` in this facet set. A
     * strict one-way latch — `PoolStorage.pool` can be set exactly once,
     * mirroring `CoreStorage.indexOpen`'s own one-way shape — so there is no
     * "swap the pool out from under live LPs" lever for governance to pull
     * later.
     */
    function executeIndexPool() external {
        PoolStorage.Layout storage ps = PoolStorage.layout();
        PoolStorage.GovernanceQueuedAddress memory q = ps.queuedPool;
        if (!q.pending) revert NothingQueued();
        if (block.timestamp < q.eta) revert TimelockNotElapsed();
        if (ps.pool != address(0)) revert PoolAlreadySet();
        delete ps.queuedPool;
        if (IIndexCoinPool(q.value).paymentToken() != CoreStorage.layout().dividendAsset) revert BadParam();
        if (IIndexCoinPool(q.value).indexCoin() != address(this)) revert BadParam();
        ps.pool = q.value;
        // Adversarial-review fix (2026-08-06): seed the initial dilution cap
        // in the SAME already-timelocked call that first makes
        // `deployToIndexPool` reachable at all, so there is never a window
        // where the pool is wired but the cap is still its zero default
        // (which would otherwise block every deploy outright, not permit one).
        ps.maxPoolShareBps = DEFAULT_MAX_POOL_SHARE_BPS;
        emit IndexPoolSet(q.value);
        emit MaxPoolShareBpsSet(DEFAULT_MAX_POOL_SHARE_BPS);
    }

    // ── §7.10 dilution-cap governance (adversarial-review fix) ───────────

    function maxPoolShareBps() external view returns (uint256) {
        return PoolStorage.layout().maxPoolShareBps;
    }

    function poolSharesMinted() external view returns (uint256) {
        return PoolStorage.layout().poolSharesMinted;
    }

    function queuedMaxPoolShareBps() external view returns (uint256 value, uint64 eta, bool pending) {
        PoolStorage.QueuedUint256 storage q = PoolStorage.layout().queuedMaxPoolShareBps;
        return (q.value, q.eta, q.pending);
    }

    /**
     * @notice Queue a new dilution cap. `ROLE_RISK_PARAM_`, timelocked —
     * same queue/execute shape as `queueIndexPool` and every other
     * risk-surface change in this facet set.
     */
    function queueMaxPoolShareBps(uint256 value) external onlyRole(ROLE_RISK_PARAM_) {
        if (value > MAX_POOL_SHARE_BPS_CEIL) revert BadParam();
        uint64 eta = uint64(block.timestamp + CoreStorage.layout().timelockDelay);
        PoolStorage.layout().queuedMaxPoolShareBps = PoolStorage.QueuedUint256({
            value: value,
            eta: eta,
            pending: true
        });
        emit MaxPoolShareBpsQueued(value, eta);
    }

    /// @notice Apply a queued cap change once its timelock has elapsed.
    /// Permissionless, like every other `execute*` in this facet set.
    function executeMaxPoolShareBps() external {
        PoolStorage.Layout storage ps = PoolStorage.layout();
        PoolStorage.QueuedUint256 memory q = ps.queuedMaxPoolShareBps;
        if (!q.pending) revert NothingQueued();
        if (block.timestamp < q.eta) revert TimelockNotElapsed();
        delete ps.queuedMaxPoolShareBps;
        ps.maxPoolShareBps = q.value;
        emit MaxPoolShareBpsSet(q.value);
    }

    // ── The one new action ──────────────────────────────────────────────

    /**
     * @notice Draw down `shareAmount` of an already-credited constituent
     * reserve, mint index coin against it at the IDENTICAL fair price an
     * external `mintSingleAsset(shareToken, shareAmount, ...)` depositor
     * would get, pair that coin with a proportional slice of the payment
     * reserve, and deposit both as protocol-owned liquidity into the
     * dedicated pool.
     *
     * @dev PRICING IS THE VERBATIM `mintSingleAsset` FORMULA (design doc
     * §7.10 task-brief point 1: "reuse the existing weighted-basket mint
     * math, do not build separate pricing logic"), computed BEFORE either
     * reserve is drawn down — same order of operations as `mintSingleAsset`
     * itself, which is what makes the two prices provably identical for
     * identical starting state (`IndexPoolFacet.test.ts`).
     *
     * The payment-token slice drawn down is exactly `ethValue(shareAmount)`
     * of `navBand` accounting — the identical band-low convention `navBand`
     * already applies to every listed constituent — which is what makes the
     * whole call an exact wash (proven in `IndexPoolFacet.test.ts`):
     * `c.reserve[paymentToken]` loses `ethValue`, and the pool's own
     * position gains a payment-token reserve worth AT LEAST `ethValue`
     * (worth exactly `ethValue` when the payment token's own band-low sits
     * at true parity, and strictly more whenever a nonzero `bandBps` holds
     * it below parity — see the band-reconciliation note below).
     *
     * ADVERSARIAL-REVIEW FIX (2026-08-06): AN INDEPENDENT, GENUINE DILUTION
     * FINDING AND WHY IT IS BOUNDED HERE RATHER THAN ELIMINATED AT THE SOURCE.
     *
     * `_mintShares(pool, sharesMinted)` below grows `totalSupply` the same as
     * any other mint. `_nav()` folds the pool's live position back in
     * (`IndexFacetBase._nav`'s header), so NAV-priced consumers see the
     * correct picture. But `IndexCoreFacet.redeemProRata` and
     * `_previewSingleExit`'s pricing path (`IndexValuation.previewSingleExit`)
     * are BOTH deliberately price-free — `IndexCoreFacet.sol`'s own header:
     * "it reads no price. `redeemProRata` works with every constituent
     * stale." They divide by raw `totalSupply` and pay out raw `c.reserve`
     * per constituent, never reading the pool at all. The pool itself is not
     * a listed constituent and has no redemption path, so `sharesMinted`
     * here is PERMANENTLY unredeemable weight added to that denominator —
     * every call dilutes every other holder's `redeemProRata`/
     * `redeemSingleAsset` payout with nothing added back on that path.
     *
     * TWO FIXES WERE WEIGHED, NOT GUESSED:
     *
     *  (a) Fold the pool's position into `redeemProRata`'s per-leg reserve.
     *      For the `paymentToken` leg this is dimensionally free (the pool's
     *      payment-side balance IS payment-token, no price conversion
     *      needed) and for the shares-in-pool weight it is exactly offset by
     *      excluding `poolSharesMinted` from the denominator — algebraically
     *      exact, verified by hand against the review's own worked example.
     *      IT FAILS FOR A DIFFERENT REASON: `redeemProRata`/`_payOrDefer` pay
     *      out of THIS CONTRACT's own token balance, never the pool's.
     *      `IndexCoinPool` exposes no withdraw path back to the vault (design
     *      doc §7.10: "permanently deepening, protocol-owned pool", no LP
     *      token, push-only `deploy`) — crediting the pool's payment reserve
     *      into the payout ratio would entitle holders to more `paymentToken`
     *      than this contract physically holds, which is not a rounding
     *      slack, it is `_payOrDefer` transferring tokens this contract does
     *      not have. Reachability, not merely price, is the anchor rule
     *      `IndexCoreFacet.sol`'s header states — "no privileged function can
     *      reach reserves already pooled" — and the pool's reserves are
     *      categorically outside this contract's balance once transferred.
     *  (b) BOUND the dilution instead of eliminating it: cap
     *      `poolSharesMinted` (cumulative, `PoolStorage`) to a governed
     *      fraction of `totalSupply` (`maxPoolShareBps`, default 5%, hard
     *      ceiling 20%), enforced on every call below. This is what ships.
     *      It does not restore exact non-decrease — that is architecturally
     *      unreachable per (a) above without a pool withdraw path this
     *      design deliberately does not have — but it turns "unbounded,
     *      compounding, permanent dilution" into "a disclosed, governed,
     *      hard-capped one-time-per-cap-increment maximum", proven by
     *      `IndexPoolFacet.dilutionCap.test.ts`.
     */
    function deployToIndexPool(address shareToken, uint256 shareAmount)
        external
        nonReentrant
        whenOpen
        returns (uint256 sharesMinted)
    {
        return _deployToIndexPoolCore(shareToken, shareAmount);
    }

    /**
     * @notice Automatic-deployment entry point (2026-08-06 automation pass,
     * design doc §7.10 follow-up: "growth compounds automatically whenever
     * used, not only when a keeper happens to call `deployToIndexPool`").
     *
     * @dev NOT A PUBLIC ACTION, despite the `external` visibility — the
     * `msg.sender == address(this)` check below means the ONLY possible
     * caller is the diamond itself, reached exclusively through
     * `IndexFacetBase._attemptAutoDeploy`'s low-level self-call from
     * `IndexBootstrapFacet._sync`. See `_attemptAutoDeploy`'s header for the
     * full reentrancy-safety derivation: this is what lets that non-blocking
     * self-call be `try/catch`-style caught (via `.call`'s `bool ok`) while
     * still being provably unreachable by any outside account or hostile
     * callback. Runs the IDENTICAL `_deployToIndexPoolCore` the explicit
     * `deployToIndexPool` above calls — there is exactly one implementation
     * of the pricing/cap/pairing logic, shared by both entry points.
     *
     * Deliberately carries `whenOpen` (a plain state check, safe to repeat)
     * but NOT `nonReentrant` — the shared reentrancy word is already
     * `ENTERED` by whichever guarded call reached `_sync` in the first
     * place, and re-checking it here would make every single automatic
     * attempt revert.
     */
    function autoDeployToIndexPool(address shareToken, uint256 shareAmount)
        external
        whenOpen
        returns (uint256 sharesMinted)
    {
        if (msg.sender != address(this)) revert BadParam();
        return _deployToIndexPoolCore(shareToken, shareAmount);
    }

    // ── §7.10 automatic-deploy dust floor governance (2026-08-06) ────────

    function minAutoDeployWei() external view returns (uint256) {
        return PoolStorage.layout().minAutoDeployWei;
    }

    function queuedMinAutoDeployWei() external view returns (uint256 value, uint64 eta, bool pending) {
        PoolStorage.QueuedUint256 storage q = PoolStorage.layout().queuedMinAutoDeployWei;
        return (q.value, q.eta, q.pending);
    }

    /**
     * @notice Queue a new automatic-deploy dust floor — the minimum
     * `_sync`-credited amount `IndexFacetBase._attemptAutoDeploy` will even
     * attempt to deploy. `ROLE_RISK_PARAM_`, timelocked, same queue/execute
     * shape as `queueMaxPoolShareBps` and every other risk-surface change in
     * this facet set. No hard ceiling is needed here the way
     * `MAX_POOL_SHARE_BPS_CEIL` bounds the dilution cap — an arbitrarily
     * large floor only ever makes the automation MORE conservative (it
     * degrades toward "never auto-deploy", never toward a larger unsafe
     * action), so there is nothing for a ceiling to protect against.
     */
    function queueMinAutoDeployWei(uint256 value) external onlyRole(ROLE_RISK_PARAM_) {
        uint64 eta = uint64(block.timestamp + CoreStorage.layout().timelockDelay);
        PoolStorage.layout().queuedMinAutoDeployWei = PoolStorage.QueuedUint256({
            value: value,
            eta: eta,
            pending: true
        });
        emit MinAutoDeployWeiQueued(value, eta);
    }

    /// @notice Apply a queued dust-floor change once its timelock has
    /// elapsed. Permissionless, like every other `execute*` in this facet
    /// set.
    function executeMinAutoDeployWei() external {
        PoolStorage.Layout storage ps = PoolStorage.layout();
        PoolStorage.QueuedUint256 memory q = ps.queuedMinAutoDeployWei;
        if (!q.pending) revert NothingQueued();
        if (block.timestamp < q.eta) revert TimelockNotElapsed();
        delete ps.queuedMinAutoDeployWei;
        ps.minAutoDeployWei = q.value;
        emit MinAutoDeployWeiSet(q.value);
    }
}
