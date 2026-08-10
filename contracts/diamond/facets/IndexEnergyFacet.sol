// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IndexFacetBase} from "./IndexFacetBase.sol";
import {CoreStorage, EnergyBusStorage} from "../storage/IndexStorage.sol";

/**
 * ============================================================================
 *  IndexEnergyFacet — PR5 of the AXIOM-1 stack (ONESHOT §5.3, §7 PR5).
 *
 *  `creditInventory(token, minAmt)`, gated `onlyEnergyBus` (modifier shared
 *  from `IndexFacetBase`), is the L2 side of Pipe I (`InventoryBuyAdapter`):
 *  the ONE entry point that lets the Energy Bus tell this Diamond "I just
 *  bought/deposited more of `token`'s inventory (an xToken, or its vToken
 *  fallback) into your own balance — go account for it."
 *
 *  NO SECOND VESTING MECHANISM. This facet builds nothing new for either
 *  "credit only an observed balance delta" or "vest the fresh credit" —
 *  both are already shipped, already adversarially reviewed, and reused
 *  byte-for-byte:
 *
 *   - `IndexFacetBase._reconcileCore(token)` is THE ONE implementation of
 *     "credit only what has already, physically, verifiably arrived"
 *     (`IndexBootstrapFacet.syncConstituentBalance`/`reconcile`'s own
 *     header). It measures `IERC20(token).balanceOf(address(this))` against
 *     everything already accounted and credits ONLY the surplus — never a
 *     caller-supplied amount, never a self-report from the Bus or the
 *     adapter.
 *   - `_reconcileCore` -> `_creditRoutedValue` -> `_addReserveVest` is THE
 *     ONE writer of `ReserveVestStorage` (§7.6's "generalized maturity-
 *     vesting guard"), which is exactly ONESHOT §5.3's instruction: "Vests
 *     via the ALREADY-SHIPPED `_addReserveVest`/generalized vesting guard
 *     in `IndexFacetBase.sol` — do not build a second vesting mechanism."
 *
 *  `creditInventory` therefore does nothing more than: gate the caller
 *  (`onlyEnergyBus`), call the existing reconcile core, and enforce the
 *  adapter's own `minAmt` slippage floor against the OBSERVED credited
 *  amount (never the adapter's nominal transfer) — the same "trust only
 *  measured deltas" discipline as everywhere else in this Diamond.
 *
 *  `token` MUST already be a listed constituent (`IndexBootstrapFacet.
 *  seedConstituent` / a later constituent-admission path) — `_get` reverts
 *  `NotListed` otherwise. This facet adds no new listing capability; an
 *  xToken (or vToken fallback) is admitted into the basket through the
 *  SAME `ROLE_CONSTITUENT_ADMISSION_`-gated path every other constituent
 *  uses, before the Bus can ever credit it.
 *
 *  `onlyEnergyBus` — TIMELOCK-SETTABLE, LIKE EVERY OTHER RISK PARAM. Genesis
 *  default is `address(0)` (fail-closed: nobody can call `creditInventory`
 *  until governance wires a real Bus, and `address(0)` can never be a
 *  `msg.sender`), and the one live address is changed only through the
 *  identical queue/execute/timelock shape `IndexGovernanceFacet.
 *  queueParam`/`executeParam` and `PlatformTreasuryStorage`'s queued pair
 *  already use — see `EnergyBusStorage`'s own header for why this gets a
 *  dedicated namespace instead of riding the existing bounded-`bytes32`
 *  `queuedParams` key space.
 * ============================================================================
 */
contract IndexEnergyFacet is IndexFacetBase {
    // ── Views ──────────────────────────────────────────────────────────────

    function energyBus() external view returns (address) {
        return EnergyBusStorage.layout().energyBus;
    }

    function queuedEnergyBus() external view returns (address value, uint64 eta, bool pending) {
        EnergyBusStorage.QueuedAddress storage q = EnergyBusStorage.layout().queuedEnergyBus;
        return (q.value, q.eta, q.pending);
    }

    // ── Governance: queue/execute, same timelock shape as every other
    //    risk-surface setter in this Diamond ────────────────────────────────

    /// @notice Queue a new EnergyBus address. `ROLE_RISK_PARAM_`-gated —
    /// same role that already tunes every other risk surface
    /// (`IndexGovernanceFacet.queueParam`); wiring the Bus is a risk-surface
    /// change (it is the sole caller admitted to `creditInventory`), not a
    /// constituent-admission one.
    function queueEnergyBus(address bus_) external onlyRole(ROLE_RISK_PARAM_) {
        if (bus_ == address(0)) revert BadParam();
        uint64 eta = uint64(block.timestamp + CoreStorage.layout().timelockDelay);
        EnergyBusStorage.layout().queuedEnergyBus =
            EnergyBusStorage.QueuedAddress({value: bus_, eta: eta, pending: true});
        emit EnergyBusQueued(bus_, eta);
    }

    /// @notice Execute a previously-queued EnergyBus address, once its
    /// timelock has elapsed. Permissionless (identical to
    /// `IndexGovernanceFacet.executeParam` — the timelock is the control,
    /// not the caller).
    function executeEnergyBus() external {
        EnergyBusStorage.Layout storage es = EnergyBusStorage.layout();
        EnergyBusStorage.QueuedAddress memory q = es.queuedEnergyBus;
        if (!q.pending) revert NothingQueued();
        _requireMature(q.eta); // AUDIT M-1: eta <= now <= eta + GRACE_PERIOD
        delete es.queuedEnergyBus;
        es.energyBus = q.value;
        emit EnergyBusSet(q.value);
    }

    // ── Pipe I landing point ───────────────────────────────────────────────

    /**
     * @notice Credit freshly-arrived inventory (`token`, an xToken or its
     * vToken fallback) into this Diamond's redeemable basket. `onlyEnergyBus`
     * — see this facet's header for the full reuse/vesting derivation.
     * @param token The constituent whose balance just grew (already listed).
     * @param minAmt Caller's own slippage floor over the OBSERVED credited
     * surplus — never over a nominal transfer amount, which this function
     * never even accepts as a parameter.
     */
    function creditInventory(address token, uint256 minAmt)
        external
        nonReentrant
        onlyEnergyBus
        returns (uint256 credited)
    {
        credited = _reconcileCore(token);
        if (credited < minAmt) revert BelowMinimum();
        emit EnergyCredited(token, credited);
    }

    error BelowMinimum();
}
