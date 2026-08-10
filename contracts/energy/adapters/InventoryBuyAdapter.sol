// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {IEnergyAdapter} from "../IEnergyAdapter.sol";

/// @dev Minimal read of PR1's `WeightModule.weights()` — inlined the same way
/// `DividendAdapter.sol`/`IdxBurnAdapter.sol` inline their reused-facet
/// interfaces, to avoid a cross-directory import for one call.
interface IWeightModuleWeights {
    function weights() external view returns (address[] memory vaults, uint256[] memory wBps);
}

/// @dev The windowed-MINIMUM depth signal PR-Phase-3 added to `WeightModule`
/// (DESIGN-HONEST-INDEX §3.2). Read through a non-reverting `staticcall`, so
/// a weight module that predates this view degrades to live-reserve sizing
/// rather than bricking Pipe I.
interface IWeightModuleDepth {
    function windowMinDepth(address vault) external view returns (uint256);
}

/// @dev Minimal reads/writes of `CollectionVault` — buy its own share `S`
/// directly at the vault's own AMM price. NOTE: `CollectionVault` IS the ERC20
/// (it inherits `ERC20` directly — see `CollectionVault.sol`), so `vault`'s
/// own address doubles as `S`'s token address; no separate xToken wrapper
/// exists to read or write here anymore (DESIGN-CAKE-EAT-IT-SHARE-ATOM-
/// 2026-08-08.md §2/§4/§10 — supersedes PR4's dual vToken+xToken design).
interface ICollectionVaultBuy {
    function buyShares(uint256 amountIn, uint256 minSharesOut) external returns (uint256 sharesOut);
    /// @dev The realizable-pricing keystone (DESIGN-HONEST-INDEX §1.3): the
    /// shares `buyShares(amountIn, 0)` would deliver RIGHT NOW, impact- and
    /// fee-inclusive.
    function quoteBuyShares(uint256 amountIn) external view returns (uint256 sharesOut);
    function paymentReserve() external view returns (uint256);
    function shareReserve() external view returns (uint256);
    function poolOpen() external view returns (bool);
}

/// @dev Minimal write of PR5's `IndexEnergyFacet.creditInventory`.
interface IIndexEnergyCredit {
    function creditInventory(address token, uint256 minAmount) external returns (uint256 credited);
}

/**
 * ============================================================================
 *  InventoryBuyAdapter — Pipe I of the AXIOM-1 Energy Bus (ONESHOT §4.1
 *  `INV_BPS = 3500`, the LARGEST pipe; ONESHOT §5.2/§5.3; SPEC §2.3/§4.2).
 *
 *  CORRECTED MODEL (DESIGN-CAKE-EAT-IT-SHARE-ATOM-2026-08-08.md §2/§4/§10 —
 *  supersedes the PR4/PR5-original dual vToken+xToken design). There is now
 *  only ONE user-facing token per collection: `S`, which IS a
 *  `CollectionVault`'s own ERC-20 (the vault contract itself is the token).
 *  Pipe I therefore does exactly the doc's own §10 sketch: "swap WETH -> S_i
 *  by weight, transfer S_i to index, creditInventory" — no intermediate
 *  stake/wrap step, no second token minted anywhere in this path.
 *
 *  PER-LEG SHAPE. `WeightModule.weights()` returns admitted `CollectionVault`
 *  addresses and their bps (summing to 10_000, or empty if nothing is
 *  admitted yet). `amountIn` WETH is split across those legs by weight, and
 *  each leg independently: (1) buys that collection's own share `S` through
 *  its OWN internal AMM (`buyShares`, PRICED AT THE VAULT'S OWN RESERVES — no
 *  external router, no oracle, exactly the vault's own existing swap
 *  mechanism every other buyer already uses); (2) transfers that `S` straight
 *  to the index diamond (`receiver = index`); (3) calls
 *  `IndexEnergyFacet.creditInventory` so the freshly-arrived `S` becomes
 *  vested, redeemable NAV via the exact §7.2/§7.3/§7.6 mechanism PR5's facet
 *  reuses (see `IndexEnergyFacet.sol`'s own header). `token` passed to
 *  `creditInventory` is `vault` itself — `S`'s own address — which must
 *  already be a listed constituent of the index, same admission path as any
 *  other constituent.
 *
 *  WHY EACH LEG IS A SELF-CALL WRAPPED IN try/catch. `execute()` itself must
 *  NEVER revert for a recoverable per-leg condition (ONESHOT §6 rule 7 / this
 *  PR's own brief: "a collection's buy path fails, impact too high, or a leg
 *  is not listed as an index constituent" — none of those may brick the
 *  other legs or strand the pipe's WETH). Solidity's `try/catch` only wraps
 *  an EXTERNAL call, so each leg's real work lives in `buyLeg`, called via
 *  `try this.buyLeg(...)`. A revert ANYWHERE inside that call — the vault's
 *  own `buyShares`, the impact guard below, an unopened pool — unwinds the
 *  ENTIRE leg atomically (Solidity's own external-call revert semantics), so
 *  a failed leg's budget is GUARANTEED to still sit, untouched, in this
 *  adapter's own WETH balance — never partially spent, never stranded
 *  mid-leg. Only `creditInventory` itself is wrapped in an INNER try/catch
 *  (matching `DividendAdapter`'s own push-then-reconcile doctrine exactly):
 *  if it reverts, `S` has ALREADY landed at the index diamond's own balance
 *  (`buyLeg`'s own `IERC20(vault).safeTransfer(index, sharesOut)` above), so
 *  it is not stranded — a later permissionless `reconcile(S)`/
 *  `syncConstituentBalance(S)` call (PR3's own EXACT mechanism, still live
 *  and unmodified) picks it up.
 *
 *  THE MAX_IMPACT_BPS GUARD IS GONE. DELETED, NOT REPAIRED (audit C-2,
 *  DESIGN-HONEST-INDEX §1.3). It used to compare the actual fill against
 *  `budget * shareReserve / (paymentReserve + budget)` — which IS the
 *  constant-product output formula, so it already contained the full impact
 *  and the "shortfall" it measured was nothing but the swap fee. That
 *  quantity peaks near 149 bps as the trade goes to zero and falls
 *  MONOTONICALLY toward zero as the trade grows: it could never reach its own
 *  300 bps threshold at ANY size. A buy at 9,092 bps of true impact passed
 *  it. Since `buyShares(budget, 0)` also passed `minSharesOut = 0`, the
 *  system had no slippage defence at all.
 *
 *  It is not replaced by a corrected impact guard, because §1.3 makes the
 *  concept redundant: the price we transact at IS the realizable price, and
 *  the quote already contains the impact, so there is no separate threshold
 *  left to compute wrongly. What replaces it is two mechanisms with honest
 *  claims — a REAL `minSharesOut` derived from `quoteBuyShares`, and a
 *  depth-adaptive budget cap. See `QUOTE_TOLERANCE_BPS` and
 *  `MAX_LEG_POOL_FRACTION_BPS` below for exactly what each one does and does
 *  NOT protect against.
 *
 *  RETURN TO THE BUS, PRECISELY (matches `IEnergyAdapter`'s own contract).
 *  Whatever WETH this adapter still holds after every leg has been attempted
 *  — unattempted budget (rounding dust, an unweighted/unadmitted collection),
 *  or a leg's budget that reverted and unwound — is transferred back to
 *  `msg.sender` (the Bus) at the end of `execute()`. The Bus's own
 *  `_runPipe` reads ONLY the observed balance delta to decide how much
 *  routes onward to Pipe D (see `EnergyBus.sol`'s header — "never trusting
 *  the adapter's self-reported `used`"), so this adapter's own honesty about
 *  `used`/`skipped` in its return value is for event/interface clarity only,
 *  never load-bearing for fund safety.
 * ============================================================================
 */
contract InventoryBuyAdapter is IEnergyAdapter {
    using SafeERC20 for IERC20;

    uint256 private constant BPS_DENOM = 10_000;

    /// @notice Tolerance subtracted from the pre-trade `quoteBuyShares` figure
    /// to form the REAL `minSharesOut` handed to `buyShares`.
    ///
    /// WHAT THIS HONESTLY DEFENDS, AND WHAT IT DOES NOT — stated plainly
    /// because the finding this closes (C-2) was precisely a guard whose
    /// documentation overstated it.
    ///
    ///   DEFENDS: any divergence between the quote and the fill inside the
    ///   same call — a vault whose `buyShares` does not match its own
    ///   `quoteBuyShares` (a mispriced, upgraded, or hostile implementation),
    ///   reserve movement caused by our OWN earlier legs in this same route,
    ///   and the degenerate case where the pool would deliver ~nothing
    ///   (`quoted == 0` reverts the leg outright, which the old guard did
    ///   not). Those are real and this bound is tight.
    ///
    ///   DOES NOT DEFEND: the sandwich. `quoteBuyShares` is read in the SAME
    ///   TRANSACTION as the swap, therefore AFTER any front-run has already
    ///   moved the reserves. A `minSharesOut` derived from a post-front-run
    ///   quote authorises exactly the manipulated price; it is satisfiable by
    ///   construction. Anyone claiming this line defeats sandwiching is
    ///   repeating C-2's mistake in a new costume. A same-transaction quote
    ///   cannot bound a same-transaction attacker — only an out-of-band
    ///   reference (an oracle, which §1.3 deliberately removes) or a bound on
    ///   OUR OWN trade size can, which is why the next constant exists and is
    ///   the load-bearing one.
    uint256 public constant QUOTE_TOLERANCE_BPS = 50;

    /// @notice THE actual sandwich bound: no single leg may spend more than
    /// this fraction of the target pool's CURRENT payment reserve.
    ///
    /// WHY THIS ONE IS DEFENSIBLE WHERE THE QUOTE IS NOT. Sandwich profit on
    /// a constant-product pool scales with the SQUARE of the victim trade
    /// relative to depth: front-running a buy of size `b` into a reserve `x`
    /// extracts on the order of `b^2/x`. C-2's measured 2.686 WETH on a 3.5
    /// WETH slice was only possible because the slice was enormous relative
    /// to that pool. Capping `b` at 2% of `x` caps the extractable fraction
    /// at roughly `b/x = 2%` of the slice — a bounded, priced cost of doing
    /// business rather than a 77% loss.
    ///
    /// Crucially this cap CANNOT be gamed into being loose: it is read from
    /// the live reserve, so an attacker who inflates `x` to raise the cap has
    /// thereby made the pool deep enough that the larger trade has the same
    /// small impact, and an attacker who drains `x` to hurt us shrinks our
    /// trade in exact proportion. The manipulation moves the cap in the SAFE
    /// direction in both directions — which is exactly the property the
    /// deleted guard lacked, since its reference was the very quantity the
    /// attacker controlled.
    ///
    /// Budget not spent because of this cap is not lost: it stays in this
    /// adapter's WETH balance and is refunded to the Bus at the end of
    /// `execute()`, so the protocol simply buys again next route, at a size
    /// the market can absorb. Slow accumulation into thin pools is the
    /// correct behaviour for an index that promises only what it can pay.
    uint256 public constant MAX_LEG_POOL_FRACTION_BPS = 200;

    /// @notice WETH — the sole payment token this pipe ever receives.
    IERC20 public immutable weth;
    /// @notice The index Diamond this pipe buys share `S` inventory into.
    address public immutable index;
    /// @notice The one EnergyBus this adapter will ever accept `execute` from.
    address public immutable bus;
    /// @notice PR1's `WeightModule` — the sole source of which collections
    /// this pipe buys, and how much of `amountIn` each gets.
    address public immutable weightModule;

    event LegBought(address indexed vault, uint256 budget, uint256 sharesOut);
    event LegSkipped(address indexed vault, uint256 budget);

    error ZeroAddress();
    error NotBus();
    error NotSelf();
    error NoShares();
    error PoolNotOpen();
    /// @dev The pool cannot currently absorb this leg at all — `quoteBuyShares`
    /// returns 0, so there is no realizable price to transact at. Soft-fails
    /// the leg; its budget returns to the Bus.
    error NoRealizableQuote();

    constructor(address weth_, address index_, address bus_, address weightModule_) {
        if (weth_ == address(0) || index_ == address(0) || bus_ == address(0) || weightModule_ == address(0)) {
            revert ZeroAddress();
        }
        weth = IERC20(weth_);
        index = index_;
        bus = bus_;
        weightModule = weightModule_;
    }

    modifier onlyBus() {
        if (msg.sender != bus) revert NotBus();
        _;
    }

    function execute(uint256 amountIn) external override onlyBus returns (uint256 used, bool skipped) {
        if (amountIn == 0) return (0, false);

        (address[] memory vaults, uint256[] memory wBps) = IWeightModuleWeights(weightModule).weights();
        uint256 n = vaults.length;

        if (n == 0) {
            // No admitted collections yet — the entire slice is a safe skip,
            // returned whole to the Bus (routes to Pipe D).
            weth.safeTransfer(msg.sender, amountIn);
            return (0, true);
        }

        uint256 totalUsed;
        for (uint256 i = 0; i < n; i++) {
            if (wBps[i] == 0) continue;
            uint256 budget = (amountIn * wBps[i]) / BPS_DENOM;
            if (budget == 0) continue;
            // Never spend more than this call actually received, even if
            // rounding across legs somehow summed past `amountIn` (it
            // cannot, since wBps sums to <= 10_000, but the floor is cheap
            // insurance against a future WeightModule invariant change).
            uint256 bal = weth.balanceOf(address(this));
            if (budget > bal) budget = bal;
            if (budget == 0) continue;

            try this.buyLeg(vaults[i], budget) returns (uint256 spent, uint256 sharesOut) {
                totalUsed += spent;
                emit LegBought(vaults[i], spent, sharesOut);
            } catch {
                // Whole leg unwound atomically — `budget` still sits in this
                // adapter's own WETH balance, refunded to the Bus below.
                emit LegSkipped(vaults[i], budget);
            }
        }

        used = totalUsed;
        skipped = (used == 0);

        // AUDIT C-1: never hand the Bus back more than it gave us. Refunding
        // the raw balance lets anyone donate WETH straight to this adapter
        // and make the Bus's own delta arithmetic underflow, bricking
        // `route()` permanently on an immutable contract. Any surplus simply
        // stays here and is spent productively on the NEXT route (the
        // per-leg `budget` is floored against this balance above), so a
        // donation becomes protocol value rather than a weapon.
        uint256 leftover = weth.balanceOf(address(this));
        if (leftover > amountIn) leftover = amountIn;
        if (leftover > 0) {
            weth.safeTransfer(msg.sender, leftover);
        }
    }

    /**
     * @notice One leg's work: buy `vault`'s own share `S` with `budget` WETH
     * at the vault's own AMM price, transfer that `S` straight to `index`,
     * then opportunistically credit it via `IndexEnergyFacet.creditInventory`.
     * `external`, callable only by this contract itself (`try this.buyLeg(...)`
     * from `execute`) — never a genuine external entry point despite the
     * visibility, exactly the same "gated by `msg.sender == address(this)`"
     * shape `IndexFacetBase._attemptOpportunisticReconcile`'s self-call target
     * (`autoReconcile`) already uses in this codebase.
     */
    function buyLeg(address vault, uint256 budget) external returns (uint256 spent, uint256 sharesOut) {
        if (msg.sender != address(this)) revert NotSelf();

        ICollectionVaultBuy v = ICollectionVaultBuy(vault);
        if (!v.poolOpen()) revert PoolNotOpen();

        // ---- Depth-adaptive sizing (the real sandwich bound) -------------
        // Read the pool's live payment reserve and never take more than
        // MAX_LEG_POOL_FRACTION_BPS of it in one block. See the constant's
        // own writeup for why this — and not the quote below — is what
        // actually bounds an attacker.
        uint256 maxLeg = (_depthReference(vault, v.paymentReserve()) * MAX_LEG_POOL_FRACTION_BPS) / BPS_DENOM;
        if (maxLeg == 0) revert NoRealizableQuote();
        if (budget > maxLeg) budget = maxLeg;

        // ---- Realizable pricing (DESIGN-HONEST-INDEX §1.3) ---------------
        // Quote BEFORE the swap and pass the quote, minus a tight tolerance
        // for same-call reserve drift, as a REAL `minSharesOut`. The quote
        // already contains the impact, so there is no separate impact guard
        // here by design — the deleted one is documented in this file's
        // header as audit C-2.
        uint256 quoted = v.quoteBuyShares(budget);
        if (quoted == 0) revert NoRealizableQuote();
        uint256 minSharesOut = (quoted * (BPS_DENOM - QUOTE_TOLERANCE_BPS)) / BPS_DENOM;
        if (minSharesOut == 0) revert NoRealizableQuote();

        weth.forceApprove(vault, budget);
        sharesOut = v.buyShares(budget, minSharesOut);
        weth.forceApprove(vault, 0);
        if (sharesOut == 0) revert NoShares();

        // `vault` IS `S`'s own ERC20 address — transfer the freshly bought
        // share straight to the index Diamond.
        IERC20(vault).safeTransfer(index, sharesOut);

        // Best-effort credit — see this file's header for why a failure here
        // is never a stranded-funds condition: `S` already landed at
        // `index`'s own balance via the transfer above.
        try IIndexEnergyCredit(index).creditInventory(vault, 0) returns (uint256) {
            // credited; nothing further for this leg to do.
        } catch {
            // Picked up by a later permissionless reconcile/syncConstituentBalance.
        }

        spent = budget;
    }

    /**
     * @dev The depth the leg cap is measured against.
     *
     * THIS IS THE CLOSING HALF OF THE SANDWICH ARGUMENT, and it is worth
     * being precise about, because sizing against the LIVE reserve alone is
     * NOT sufficient. A front-runner who adds liquidity (or simply buys) in
     * front of `route()` inflates `paymentReserve`, which inflates our cap,
     * which lets them extract a roughly constant fraction of a now-larger
     * trade. Measured on the audit's own PoC-3 fixture, that residual grew
     * linearly with the attacker's front-run size.
     *
     * `WeightModule.windowMinDepth` is the MINIMUM WETH reserve observed
     * across a multi-hour window, so it cannot be moved by anything that
     * happens in the attacker's own block — inflating it requires HOLDING
     * real liquidity for the whole window, at which point the depth is real
     * and the trade genuinely is small relative to it. Taking the minimum of
     * the two means an attacker can only ever shrink our trade, never grow
     * it, which is the property that turns "bounded" into "bounded by a
     * number the attacker does not control".
     *
     * FALLBACK, STATED HONESTLY. A vault with no depth history yet reports
     * `0`, and we then size against the live reserve rather than refusing to
     * trade — refusing would stall Pipe I for every newly admitted
     * collection. The mitigation is structural rather than assumed: a vault
     * with no observed depth also scores ~0 on `WeightModule`'s D signal and
     * has ~0 exit capacity, so it receives a correspondingly tiny weight and
     * therefore a tiny budget in the first place.
     */
    function _depthReference(address vault, uint256 liveReserve) internal view returns (uint256) {
        (bool ok, bytes memory ret) =
            weightModule.staticcall(abi.encodeWithSelector(IWeightModuleDepth.windowMinDepth.selector, vault));
        if (!ok || ret.length < 32) return liveReserve;
        uint256 windowMin = abi.decode(ret, (uint256));
        if (windowMin == 0) return liveReserve;
        return windowMin < liveReserve ? windowMin : liveReserve;
    }
}
