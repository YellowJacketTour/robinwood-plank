// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {IEnergyAdapter} from "../IEnergyAdapter.sol";

/// @dev Same reused-facet-interface inlining discipline as
/// `InventoryBuyAdapter.sol` — one call, no cross-directory import.
interface IWeightModuleWeights {
    function weights() external view returns (address[] memory vaults, uint256[] memory wBps);
}

/// @dev See `InventoryBuyAdapter.IWeightModuleDepth` for the full argument:
/// the windowed-MINIMUM depth is the only depth figure a same-block attacker
/// cannot inflate, so it — not the live reserve — is what the leg cap is
/// measured against.
interface IWeightModuleDepth {
    function windowMinDepth(address vault) external view returns (uint256);
}

/// @dev Minimal reads/writes of `CollectionVault`, extended past
/// `InventoryBuyAdapter`'s own `ICollectionVaultBuy` with the native-LP
/// surface this adapter actually needs: `addLiquidity` (balanced two-sided
/// deposit, `CollectionVault.sol:509-534`), `sellShares` (to unwind any
/// leftover `S` this adapter over-acquired for a leg, `CollectionVault.sol:
/// 404-428`), and `lpToken` (the per-vault `CollectionVaultLP` receipt,
/// `CollectionVault.sol:169`).
interface ICollectionVaultLpOps {
    function buyShares(uint256 amountIn, uint256 minSharesOut) external returns (uint256 sharesOut);
    function quoteBuyShares(uint256 amountIn) external view returns (uint256 sharesOut);
    function sellShares(uint256 sharesIn, uint256 minAmountOut) external returns (uint256 amountOut);
    function addLiquidity(uint256 paymentIn, uint256 minLpOut) external returns (uint256 lpOut, uint256 sharesIn);
    function paymentReserve() external view returns (uint256);
    function shareReserve() external view returns (uint256);
    function poolOpen() external view returns (bool);
    function lpToken() external view returns (address);
}

/**
 * ============================================================================
 *  CollectionLpAdapter — Pipe L of the AXIOM-1 Energy Bus (ONESHOT §4.1
 *  `CLP_BPS = 1500`; §4.1b "L: POL non-withdrawable + harvestAndCompound;
 *  skim to Bus"; §6.6's explicit non-negotiable that this pipe funds MORE of
 *  the permanently-locked floor over time, never a withdrawable position for
 *  anyone).
 *
 *  REBUILT AGAINST THE CORRECT MODEL. The first attempt at this pipe
 *  (`CollectionLpRenounceAdapter.sol`, referenced only in this repo's own git
 *  history and `docs/DESIGN-COLLECTION-VAULT-NATIVE-LP-AND-ZAP-MINT-2026-08-
 *  08.md`'s Part 1 audit) was built against a donation-only model
 *  (`CollectionVault.donateReserves`) that mints no receipt at all, found
 *  buggy, and deleted when the architecture pivoted to real native LP
 *  (`CollectionVault.addLiquidity`/`removeLiquidity`, the `CollectionVaultLP`
 *  ERC-20 receipt, and the `LP_LOCK_ADDR` genesis-floor lock —
 *  `CollectionVault.sol:169-179,470-564`). This adapter is built against THAT
 *  mechanism, not the deleted one.
 *
 *  PER-LEG SHAPE, mirroring `InventoryBuyAdapter`'s own proven pattern.
 *  `WeightModule.weights()` splits this pipe's WETH budget across admitted
 *  `CollectionVault`s by weight. Each leg independently:
 *    1. Splits its own budget: `LEG_PAIR_SPLIT_BPS` (50%) becomes `paymentIn`
 *       for the eventual `addLiquidity` call, the other half (`buyBudget`) is
 *       spent acquiring the matching `S` via the vault's OWN `buyShares` —
 *       the exact pricing/impact-guard discipline `InventoryBuyAdapter`
 *       already proves out, reused verbatim here (`MAX_IMPACT_BPS = 300`).
 *    2. Approves the vault for the `S` just bought, then calls
 *       `addLiquidity(paymentIn, 0)`. `addLiquidity` itself DERIVES the
 *       exact matching `sharesIn` from the pool's CURRENT ratio at call time
 *       (`CollectionVault.sol:518`, never a caller-nominal figure) and pulls
 *       exactly that much `S` from this adapter's own balance/allowance —
 *       so this adapter never nominates `sharesIn` itself, it only ensures
 *       it holds enough `S` for whatever the vault computes.
 *    3. Any `S` this adapter over-bought relative to what `addLiquidity`
 *       actually pulled is sold straight back via `sellShares`, so no `S`
 *       dust is ever stranded off the WETH-denominated accounting the Bus
 *       expects from every adapter.
 *    4. The real LP-token receipt `addLiquidity` mints to this adapter is
 *       IMMEDIATELY forwarded to the SAME `LP_LOCK_ADDR` the vault's own
 *       genesis floor already uses (`CollectionVault.sol:177`) — never held
 *       by this adapter, the Bus, or governance, per §6.6's non-negotiable.
 *
 *  WHY EACH LEG IS A SELF-CALL WRAPPED IN try/catch, ATOMICALLY. Exactly
 *  `InventoryBuyAdapter`'s own documented reasoning: a revert anywhere inside
 *  `buyLeg` (unopened pool, impact guard, `addLiquidity` itself reverting
 *  because the derived `sharesIn` exceeds what this adapter could acquire
 *  within its own budget) unwinds the ENTIRE leg atomically via Solidity's
 *  own external-call revert semantics — the leg's budget is GUARANTEED to
 *  still sit, untouched, in this adapter's own WETH balance, never partially
 *  spent, never stranded. `execute()` itself therefore never reverts for a
 *  recoverable per-leg condition.
 *
 *  §4.1b's 20%-SKIM-TO-BUS, INVESTIGATED AND RESOLVED HONESTLY (this is the
 *  one piece that cannot be copy-pasted from `InventoryBuyAdapter`; see the
 *  full writeup below `_SKIM_BPS`).
 *
 *  RETURN TO THE BUS, PRECISELY. Whatever WETH this adapter still holds after
 *  the skim carve-out and every leg has been attempted is transferred back to
 *  `msg.sender` (the Bus) at the end of `execute()`, exactly
 *  `InventoryBuyAdapter`'s own doctrine — the Bus's own `_runPipe` reads only
 *  the observed balance delta, never this adapter's self-reported `used`.
 * ============================================================================
 */
contract CollectionLpAdapter is IEnergyAdapter {
    using SafeERC20 for IERC20;

    uint256 private constant BPS_DENOM = 10_000;

    /// @notice AUDIT C-2 / DESIGN-HONEST-INDEX §1.3. The old `MAX_IMPACT_BPS`
    /// guard is DELETED, not corrected — it compared the fill against the
    /// constant-product output formula, so it measured only the swap fee,
    /// peaked near 149 bps and fell toward zero as trades grew, and could
    /// never reach its own 300 bps threshold at any size. This adapter now
    /// prices its acquisition leg exactly the way `InventoryBuyAdapter` does:
    /// a REAL `minSharesOut` from a pre-trade `quoteBuyShares`, plus a
    /// depth-adaptive cap on how much of a pool one leg may take in a block.
    /// See `InventoryBuyAdapter`'s constants for the full honest statement of
    /// what each mechanism does and does not defend against — in particular
    /// that the quote BOUNDS but does not DEFEAT a sandwich, and the size cap
    /// is the load-bearing half.
    uint256 public constant QUOTE_TOLERANCE_BPS = 50;
    uint256 public constant MAX_LEG_POOL_FRACTION_BPS = 200;

    /// @notice Nominal per-leg split: this fraction of `budget` is spent
    /// acquiring `S` (`buyBudget`); the remainder is the CEILING on
    /// `paymentIn` (`payCap`). This is the same "swap half, deposit half"
    /// shape Part 2 §2 of the design doc documents as the standard
    /// zap-to-LP pattern — but unlike a naive zap, the ACTUAL `paymentIn`
    /// handed to `addLiquidity` is never this nominal half; it is derived
    /// exactly from the post-buy reserve ratio in `buyLeg` (see the comment
    /// there), and only ever capped by this half, never assumed equal to it.
    uint256 public constant LEG_PAIR_SPLIT_BPS = 5_000;

    /// @notice ONESHOT §4.1b `POL_FEE_SKIM_TO_BUS_BPS = 2000`.
    ///
    /// WHY THIS IS IMPLEMENTED AS "NEVER SPEND 20% OF `amountIn` ON A LEG IN
    /// THE FIRST PLACE" RATHER THAN A PERIODIC HARVEST OF ALREADY-LOCKED LP —
    /// investigated per this PR's own brief, documented here rather than
    /// hand-waved:
    ///
    ///   `removeLiquidity` (`CollectionVault.sol:546-564`) is the ONLY way to
    ///   realize ANY value out of an LP position — it burns `msg.sender`'s
    ///   own LP balance and pays the proportional (fee-grown) reserves to
    ///   `msg.sender`. There is no separate "harvest just the fee delta"
    ///   entry point anywhere on `CollectionVault`/`CollectionVaultLP` — the
    ///   fee growth is baked directly into `k` (`paymentReserve`/
    ///   `shareReserve`), so "harvest" and "withdraw principal" are, for this
    ///   contract, the SAME call. That is why the design doc's own §3.1
    ///   requirement 4 calls the fee growth "REAL... accrued since their
    ///   deposit" without describing any harvest function distinct from
    ///   `removeLiquidity` itself.
    ///
    ///   This pipe's own LP receipts are sent to `LP_LOCK_ADDR`
    ///   (`0x000...dEaD`) the instant they are minted (§6.6's own
    ///   non-negotiable, restated in this adapter's own header). Nobody holds
    ///   that address's key — by construction, exactly like the vault's own
    ///   genesis floor. `removeLiquidity` can therefore NEVER be called
    ///   against those specific LP tokens, by this adapter, the Bus, or
    ///   anyone else, ever. A "periodically `removeLiquidity` a governed
    ///   fraction of THIS adapter's own prior locked positions" mechanism —
    ///   floated as one option in this PR's own brief — is not merely
    ///   undesirable here, it is IMPOSSIBLE without directly violating §6.6:
    ///   the only way this adapter could later call `removeLiquidity` on a
    ///   position is to have never sent it to `LP_LOCK_ADDR` in the first
    ///   place, which is precisely the withdrawable-position shape §6.6
    ///   forbids. The "non-negotiable non-withdrawable" requirement and a
    ///   "periodically harvest THIS pipe's own locked LP" mechanism are in
    ///   direct, structural conflict for this specific design — not a gap in
    ///   effort, a genuine incompatibility, so this adapter does not build a
    ///   fake harvest path that would either (a) quietly retain LP instead of
    ///   locking it (violating §6.6), or (b) call `removeLiquidity` from
    ///   `LP_LOCK_ADDR` (impossible — nobody holds that key).
    ///
    ///   What DOES satisfy §4.1b's literal 2000 bps figure, honestly and
    ///   testably, without inventing a mechanism that does not fit: this
    ///   adapter withholds `_SKIM_BPS` (20%) of `amountIn` from every leg
    ///   budget calculation up front, in `execute()`, before any WETH is
    ///   spent on acquiring `S` or added as `paymentIn`. That withheld slice
    ///   is never touched by any leg, so it flows back to the Bus via the
    ///   SAME "unspent budget returns to `msg.sender`" mechanism every other
    ///   adapter already uses (`InventoryBuyAdapter.execute`'s own leftover
    ///   refund) — and the Bus's own `_runPipe` routes that returned WETH to
    ///   Pipe D exactly the way any other pipe's skipped/leftover budget
    ///   already does. This is a real, on-chain, testable 20%-of-this-pipe's-
    ///   inflow redirection to the Bus, using ONLY mechanisms this repo
    ///   already ships (the Bus's existing leftover-routing), rather than a
    ///   new harvest function bolted onto a position this design forbids
    ///   this adapter from ever touching again.
    uint256 public constant SKIM_TO_BUS_BPS = 2_000;

    /// @notice Same dead address `CollectionVault.LP_LOCK_ADDR` uses — every
    /// LP receipt this adapter ever receives is forwarded here, permanently.
    address public constant LP_LOCK_ADDR = 0x000000000000000000000000000000000000dEaD;

    IERC20 public immutable weth;
    address public immutable bus;
    address public immutable weightModule;

    event LegLp(address indexed vault, uint256 budget, uint256 lpLocked);
    event LegSkipped(address indexed vault, uint256 budget);
    event SkimmedToBus(uint256 amount);

    error ZeroAddress();
    error NotBus();
    error NotSelf();
    error NoShares();
    error NoLp();
    error PoolNotOpen();
    error NoRealizableQuote();

    constructor(address weth_, address bus_, address weightModule_) {
        if (weth_ == address(0) || bus_ == address(0) || weightModule_ == address(0)) revert ZeroAddress();
        weth = IERC20(weth_);
        bus = bus_;
        weightModule = weightModule_;
    }

    modifier onlyBus() {
        if (msg.sender != bus) revert NotBus();
        _;
    }

    function execute(uint256 amountIn) external override onlyBus returns (uint256 used, bool skipped) {
        if (amountIn == 0) return (0, false);

        // 20% skim to the Bus, see `SKIM_TO_BUS_BPS`'s full writeup above —
        // never spent on any leg, simply never allocated in the first place.
        uint256 skim = (amountIn * SKIM_TO_BUS_BPS) / BPS_DENOM;
        uint256 deployable = amountIn - skim;
        if (skim > 0) emit SkimmedToBus(skim);

        (address[] memory vaults, uint256[] memory wBps) = IWeightModuleWeights(weightModule).weights();
        uint256 n = vaults.length;

        if (n == 0 || deployable == 0) {
            // No admitted collections, or the whole slice rounded to skim —
            // the entire amountIn is a safe return to the Bus (routes to D).
            weth.safeTransfer(msg.sender, amountIn);
            return (0, true);
        }

        uint256 totalUsed;
        for (uint256 i = 0; i < n; i++) {
            if (wBps[i] == 0) continue;
            uint256 budget = (deployable * wBps[i]) / BPS_DENOM;
            if (budget == 0) continue;
            uint256 bal = weth.balanceOf(address(this));
            if (budget > bal) budget = bal;
            if (budget == 0) continue;

            try this.buyLeg(vaults[i], budget) returns (uint256 spent, uint256 lpLocked) {
                totalUsed += spent;
                emit LegLp(vaults[i], spent, lpLocked);
            } catch {
                // Whole leg unwound atomically — `budget` still sits in this
                // adapter's own WETH balance, refunded to the Bus below.
                emit LegSkipped(vaults[i], budget);
            }
        }

        used = totalUsed;
        skipped = (used == 0);

        // AUDIT C-1: never return more than we received — see the identical
        // guard in InventoryBuyAdapter. A raw-balance refund lets a donation
        // underflow the Bus's delta arithmetic and brick `route()` forever.
        uint256 leftover = weth.balanceOf(address(this));
        if (leftover > amountIn) leftover = amountIn;
        if (leftover > 0) {
            weth.safeTransfer(msg.sender, leftover);
        }
    }

    /**
     * @notice One leg's work: acquire `S` for half of `budget`, deposit a
     * balanced pair via `addLiquidity`, lock the resulting LP receipt
     * forever, sell back any `S` the vault's `addLiquidity` did not need.
     * `external`, callable only by this contract itself, exactly
     * `InventoryBuyAdapter.buyLeg`'s own self-call shape.
     */
    function buyLeg(address vault, uint256 budget) external returns (uint256 spent, uint256 lpLocked) {
        if (msg.sender != address(this)) revert NotSelf();
        ICollectionVaultLpOps v = ICollectionVaultLpOps(vault);
        if (!v.poolOpen()) revert PoolNotOpen();

        uint256 wethBefore = weth.balanceOf(address(this));

        // Depth-adaptive sizing, applied to the WHOLE leg before the pair
        // split so both halves shrink together and `payCap` stays consistent
        // with what the buy half can actually acquire. Unspent budget is
        // refunded to the Bus by `execute()`, so a thin pool simply gets
        // deepened over more routes instead of being taken in one block.
        uint256 maxLeg = (_depthReference(vault, v.paymentReserve()) * MAX_LEG_POOL_FRACTION_BPS) / BPS_DENOM;
        if (maxLeg == 0) revert NoRealizableQuote();
        if (budget > maxLeg) budget = maxLeg;

        uint256 buyBudget = (budget * LEG_PAIR_SPLIT_BPS) / BPS_DENOM;
        uint256 payCap = budget - buyBudget;
        if (buyBudget == 0 || payCap == 0) revert NoLp();

        uint256 sharesOut = _buyLegShares(v, vault, buyBudget);

        // `paymentIn` is derived EXACTLY from the vault's CURRENT (post-buy)
        // ratio — the exact algebraic inverse of `addLiquidity`'s own
        // `sharesIn = paymentIn * shareReserve / paymentReserve`
        // (`CollectionVault.sol:518`) — so the `sharesIn` `addLiquidity`
        // computes from THIS `paymentIn` is guaranteed (up to Solidity's
        // floor-division rounding, which only ever rounds `sharesIn` DOWN)
        // to be `<= sharesOut`, the `S` this adapter actually holds. A
        // blind half/half split cannot offer this guarantee: buying `S`
        // pays the vault's own swap fee, so a naive `paymentIn == buyBudget`
        // split can demand slightly MORE `S` than the fee-reduced `sharesOut`
        // actually bought — this computation removes that gap deterministically
        // instead of hoping a fixed split's margin covers every pool ratio.
        uint256 paymentIn = (sharesOut * v.paymentReserve()) / v.shareReserve();
        if (paymentIn > payCap) paymentIn = payCap;
        if (paymentIn == 0) revert NoLp();

        uint256 lpOut = _addLegLiquidity(v, vault, paymentIn, sharesOut);
        lpLocked = lpOut;

        uint256 wethAfter = weth.balanceOf(address(this));
        spent = wethBefore > wethAfter ? wethBefore - wethAfter : 0;
    }

    /// @dev Acquisition half of a leg: buy `S` at the vault's own REALIZABLE
    /// price — quote first, then transact with that quote (minus a tight
    /// same-call drift tolerance) as a real `minSharesOut`. Exactly
    /// `InventoryBuyAdapter.buyLeg`'s discipline, and for exactly the reasons
    /// documented there. Split out only to keep `buyLeg`'s own stack shallow
    /// enough for the repo's pinned (non-viaIR) compiler settings.
    function _buyLegShares(ICollectionVaultLpOps v, address vault, uint256 buyBudget)
        private
        returns (uint256 sharesOut)
    {
        uint256 quoted = v.quoteBuyShares(buyBudget);
        if (quoted == 0) revert NoRealizableQuote();
        uint256 minSharesOut = (quoted * (BPS_DENOM - QUOTE_TOLERANCE_BPS)) / BPS_DENOM;
        if (minSharesOut == 0) revert NoRealizableQuote();

        weth.forceApprove(vault, buyBudget);
        sharesOut = v.buyShares(buyBudget, minSharesOut);
        weth.forceApprove(vault, 0);
        if (sharesOut == 0) revert NoShares();
    }

    /// @dev Balanced-deposit half of a leg: supply `paymentIn` + the matching
    /// `sharesOut` of `S` to `addLiquidity`, lock the LP receipt forever,
    /// sell back any `S` the vault did not need. Split out for the same
    /// stack-depth reason as `_buyLegShares`.
    function _addLegLiquidity(ICollectionVaultLpOps v, address vault, uint256 paymentIn, uint256 sharesOut)
        private
        returns (uint256 lpOut)
    {
        IERC20(vault).forceApprove(vault, sharesOut);
        weth.forceApprove(vault, paymentIn);
        uint256 sharesIn;
        (lpOut, sharesIn) = v.addLiquidity(paymentIn, 0);
        weth.forceApprove(vault, 0);
        IERC20(vault).forceApprove(vault, 0);
        if (lpOut == 0) revert NoLp();

        // Sell back any `S` this adapter over-acquired relative to what
        // `addLiquidity` actually pulled, so no non-WETH dust is stranded.
        uint256 leftoverShares = sharesOut > sharesIn ? sharesOut - sharesIn : 0;
        if (leftoverShares > 0) {
            try v.sellShares(leftoverShares, 0) {
                // WETH proceeds land back in this adapter's own balance.
            } catch {
                // Non-load-bearing best-effort unwind — worst case a small
                // `S` dust balance remains rather than reverting an
                // already-successful LP deposit.
            }
        }

        // Lock the real LP receipt forever — §6.6's non-negotiable.
        IERC20(v.lpToken()).safeTransfer(LP_LOCK_ADDR, lpOut);
    }

    /// @dev Identical to `InventoryBuyAdapter._depthReference`, including the
    /// honestly-stated fallback: a vault with no observed depth history sizes
    /// against its live reserve, and is separately protected by having ~0
    /// weight and ~0 exit capacity until that history exists.
    function _depthReference(address vault, uint256 liveReserve) internal view returns (uint256) {
        (bool ok, bytes memory ret) =
            weightModule.staticcall(abi.encodeWithSelector(IWeightModuleDepth.windowMinDepth.selector, vault));
        if (!ok || ret.length < 32) return liveReserve;
        uint256 windowMin = abi.decode(ret, (uint256));
        if (windowMin == 0) return liveReserve;
        return windowMin < liveReserve ? windowMin : liveReserve;
    }
}
