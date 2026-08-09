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

/// @dev Minimal reads/writes of `CollectionVault` — buy its own share `S`
/// directly at the vault's own AMM price. NOTE: `CollectionVault` IS the ERC20
/// (it inherits `ERC20` directly — see `CollectionVault.sol`), so `vault`'s
/// own address doubles as `S`'s token address; no separate xToken wrapper
/// exists to read or write here anymore (DESIGN-CAKE-EAT-IT-SHARE-ATOM-
/// 2026-08-08.md §2/§4/§10 — supersedes PR4's dual vToken+xToken design).
interface ICollectionVaultBuy {
    function buyShares(uint256 amountIn, uint256 minSharesOut) external returns (uint256 sharesOut);
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
 *  THE MAX_IMPACT_BPS GUARD (SPEC §2.3 rule 4). Computed against the vault's
 *  own CURRENT `paymentReserve`/`shareReserve` — the no-impact "spot" share
 *  count a budget WOULD buy at the CURRENT ratio, compared against what
 *  `buyShares`'s constant-product math ACTUALLY returns. A leg whose implied
 *  impact exceeds `MAX_IMPACT_BPS` reverts inside `buyLeg` (via
 *  `ImpactTooHigh`), which — per the paragraph above — safely unwinds that
 *  one leg's spend and returns its budget to the Bus via Pipe D, exactly the
 *  documented "impact too high -> skip that leg" behavior.
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
    /// @dev Verbatim from `EnergyBus.MAX_IMPACT_BPS` / ONESHOT §4.2 — the
    /// SAME 3% ceiling, reused rather than re-derived.
    uint256 public constant MAX_IMPACT_BPS = 300;

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
    error ImpactTooHigh();
    error NoShares();
    error PoolNotOpen();

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

        uint256 leftover = weth.balanceOf(address(this));
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

        // Impact guard (SPEC §2.3 rule 4 / ONESHOT §4.2 `MAX_IMPACT_BPS`):
        // compare the constant-product `buyShares` output against the
        // no-impact "spot" estimate at the vault's CURRENT reserves.
        uint256 paymentReserveBefore = v.paymentReserve();
        uint256 shareReserveBefore = v.shareReserve();
        uint256 spotShares = (budget * shareReserveBefore) / (paymentReserveBefore + budget);

        weth.forceApprove(vault, budget);
        sharesOut = v.buyShares(budget, 0);
        weth.forceApprove(vault, 0);
        if (sharesOut == 0) revert NoShares();

        if (spotShares > 0) {
            uint256 shortfall = spotShares > sharesOut ? spotShares - sharesOut : 0;
            uint256 impactBps = (shortfall * BPS_DENOM) / spotShares;
            if (impactBps > MAX_IMPACT_BPS) revert ImpactTooHigh();
        }

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
}
