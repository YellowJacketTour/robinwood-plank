// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IndexFacetBase} from "./IndexFacetBase.sol";
import {CoreStorage, DevFundStorage} from "../storage/IndexStorage.sol";

/**
 * ============================================================================
 *  IndexDevFundFacet — §7.11 "dev-fund allocation via PLANK market-buy"
 *  (design doc DESIGN-N-VAULT-FACTORY-AND-VALUE-ACCRUAL-2026-08-06.md §7.11).
 *
 *  NOT FOR DEPLOYMENT except as a facet.
 *
 *  READ THIS BEFORE TOUCHING ANYTHING IN THIS FILE: THIS IS DELIBERATELY,
 *  EXPLICITLY A DIFFERENT TRUST MODEL FROM EVERYTHING ELSE IN THIS FACET
 *  SET, AND THE DESIGN DOC SAYS SO IN ITS OWN WORDS.
 *
 *  Every other value-routing mechanism this codebase has built (§7.3's
 *  reserve growth and dividend claim, §7.7's buyback-and-lock) is engineered
 *  so that no one, including the team, has spending access to the value it
 *  routes — that is the whole point of the non-decreasing-NAV invariant and
 *  the lock-not-renounce pattern `IndexBuybackFacet` uses. A dev fund is,
 *  honestly, the opposite: real, spendable value under team control. That is
 *  a legitimate and common DeFi pattern, but this file — and every comment,
 *  event and test near it — MUST NOT use "no admin path", "no one can touch
 *  it", or equivalent language, because it would be false here. `treasury`
 *  is disclosed as intended, in production, to be a timelocked multisig, not
 *  a bare EOA — but nothing in Solidity's type system can enforce what kind
 *  of address a caller supplies, so that is a deployment discipline, not an
 *  on-chain guarantee this facet makes.
 *
 *  WHAT IS ACTUALLY BOUNDED HERE, MECHANICALLY:
 *   - `devFundBps` cannot exceed `IndexFacetBase.CEIL_DEV_FUND_BPS` (2%),
 *     enforced at EXECUTION (`_applyDevFundBps`), the same "a timelock
 *     bounds WHEN, never HOW BIG" doctrine `CEIL_BUYBACK_SPLIT_BPS` already
 *     proves for §7.7's earmark.
 *  WHICH ROLE GOVERNS THIS (2026-08-09 audit fix M-5 — CHANGED):
 *  `queueDevFundRouter` / `queueDevFundTreasury` / `queueDevFundBps` sat
 *  behind ROLE_RISK_PARAM. That was wrong, and wrong by this codebase's OWN
 *  stated rule — `IndexParams.roleForParamKey`'s header draws the line
 *  explicitly: the risk role owns the fee SCHEDULE (what anyone is charged),
 *  and the value-flow role (ROLE_PLATFORM_ALLOCATION) owns "where an
 *  already-charged fee is BOOKED and in what asset it is paid out". That is
 *  exactly and only what these three keys decide. `devFundBps` is a carve-out
 *  of an already-charged mint payment; `treasury` is the address it is booked
 *  to; `router` is the venue that value is swapped through before it lands
 *  there — a hostile router is a value destination wearing a plumbing hat.
 *
 *  The concrete consequence: a compromised RISK key can no longer point a
 *  spendable, team-directed treasury at itself. That is the single largest
 *  blast-radius reduction available here, because the risk key's remaining
 *  reach is entirely over BOUNDED numbers, while this one reached an
 *  ARBITRARY ADDRESS that receives real value. Two of the three keys that can
 *  aim value at an address now live behind one role, and that role holds
 *  nothing else.
 *
 *   - `router`, `treasury` and `devFundBps` are ALL governed and timelocked
 *     through the identical queue/execute pair every other risk-surface
 *     change in this facet set uses (`IndexGovernanceFacet.queueParam`'s
 *     shape, `IndexPoolFacet.queueIndexPool`'s shape) — so a change to WHO
 *     receives the dev fund, or WHAT FRACTION of a mint routes to it, is
 *     visible and delayed exactly like every other privileged action here,
 *     never instant and silent.
 *   - the actual swap-and-spend at mint time — `IndexFacetBase.
 *     _routeDevFundBuy`, called from `IndexCoreFacet.mintProRata` and
 *     `IndexTradeFacet.mintSingleAsset` — can never revert the mint it rides
 *     on; see that function's header for why.
 *
 *  WHAT IS EXPLICITLY NOT DECIDED HERE, PER THE DESIGN DOC: the exact
 *  percentage, the treasury's real-world multisig threshold/signer set, and
 *  whether the bought PLANK is ever released to circulating supply or held
 *  indefinitely. Those are governance decisions this facet only provides the
 *  MECHANISM for, never the policy.
 * ============================================================================
 */
contract IndexDevFundFacet is IndexFacetBase {
    // ── Views ───────────────────────────────────────────────────────────

    function devFundRouter() external view returns (address) {
        return DevFundStorage.layout().router;
    }

    function devFundTreasury() external view returns (address) {
        return DevFundStorage.layout().treasury;
    }

    function devFundBps() external view returns (uint256) {
        return DevFundStorage.layout().devFundBps;
    }

    function queuedDevFundRouter() external view returns (address value, uint64 eta, bool pending) {
        DevFundStorage.QueuedAddress storage q = DevFundStorage.layout().queuedRouter;
        return (q.value, q.eta, q.pending);
    }

    function queuedDevFundTreasury() external view returns (address value, uint64 eta, bool pending) {
        DevFundStorage.QueuedAddress storage q = DevFundStorage.layout().queuedTreasury;
        return (q.value, q.eta, q.pending);
    }

    function queuedDevFundBps() external view returns (uint256 value, uint64 eta, bool pending) {
        DevFundStorage.QueuedUint256 storage q = DevFundStorage.layout().queuedDevFundBps;
        return (q.value, q.eta, q.pending);
    }

    // ── Router ──────────────────────────────────────────────────────────

    /**
     * @notice Queue a new external-swap-router address. `address(0)` is a
     * valid target — it disables the dev-fund buy outright, the same
     * "un-set is the safe default" shape `PoolStorage.pool`'s zero default
     * already uses, EXCEPT this one is not one-way: unlike the dedicated
     * index-coin pool, the dev-fund router may be re-pointed later (e.g. the
     * live PLANK venue migrating), always through this same timelocked path.
     */
    function queueDevFundRouter(address router) external onlyRole(ROLE_PLATFORM_ALLOCATION_) {
        uint64 eta = uint64(block.timestamp + CoreStorage.layout().timelockDelay);
        DevFundStorage.layout().queuedRouter =
            DevFundStorage.QueuedAddress({value: router, eta: eta, pending: true});
        emit DevFundRouterQueued(router, eta);
    }

    function executeDevFundRouter() external {
        DevFundStorage.Layout storage df = DevFundStorage.layout();
        DevFundStorage.QueuedAddress memory q = df.queuedRouter;
        if (!q.pending) revert NothingQueued();
        _requireMature(q.eta); // AUDIT M-1: eta <= now <= eta + GRACE_PERIOD
        delete df.queuedRouter;
        df.router = q.value;
        emit DevFundRouterSet(q.value);
    }

    // ── Treasury ────────────────────────────────────────────────────────

    /**
     * @notice Queue a new dev-fund treasury address — the destination bought
     * PLANK is delivered to. Documented, not enforced: in production this is
     * intended to be a timelocked multisig, never a bare EOA, so that
     * spending OUT of the treasury is itself visible and delayed rather than
     * instant and silent. This facet cannot check what kind of address it
     * is; the governance-setter for it is itself timelocked, exactly like
     * every other privileged address change in this codebase, which is the
     * property this facet DOES mechanically provide.
     */
    function queueDevFundTreasury(address treasury) external onlyRole(ROLE_PLATFORM_ALLOCATION_) {
        uint64 eta = uint64(block.timestamp + CoreStorage.layout().timelockDelay);
        DevFundStorage.layout().queuedTreasury =
            DevFundStorage.QueuedAddress({value: treasury, eta: eta, pending: true});
        emit DevFundTreasuryQueued(treasury, eta);
    }

    function executeDevFundTreasury() external {
        DevFundStorage.Layout storage df = DevFundStorage.layout();
        DevFundStorage.QueuedAddress memory q = df.queuedTreasury;
        if (!q.pending) revert NothingQueued();
        _requireMature(q.eta); // AUDIT M-1: eta <= now <= eta + GRACE_PERIOD
        delete df.queuedTreasury;
        df.treasury = q.value;
        emit DevFundTreasurySet(q.value);
    }

    // ── The governed percentage ────────────────────────────────────────

    /**
     * @notice Queue a new dev-fund skim, in bps of a mint's payment. Ceiling
     * is checked at EXECUTION, not here — same "a timelock bounds WHEN, not
     * HOW BIG" doctrine `IndexGovernanceFacet._applyValueAccrualSplit`
     * already documents, so a governance vote for an absurd value is visible
     * for the FULL delay before it can ever be rejected at the floor.
     */
    function queueDevFundBps(uint256 bps) external onlyRole(ROLE_PLATFORM_ALLOCATION_) {
        uint64 eta = uint64(block.timestamp + CoreStorage.layout().timelockDelay);
        DevFundStorage.layout().queuedDevFundBps =
            DevFundStorage.QueuedUint256({value: bps, eta: eta, pending: true});
        emit DevFundBpsQueued(bps, eta);
    }

    function executeDevFundBps() external {
        DevFundStorage.Layout storage df = DevFundStorage.layout();
        DevFundStorage.QueuedUint256 memory q = df.queuedDevFundBps;
        if (!q.pending) revert NothingQueued();
        _requireMature(q.eta); // AUDIT M-1: eta <= now <= eta + GRACE_PERIOD
        delete df.queuedDevFundBps;
        _applyDevFundBps(q.value);
    }

    /// @dev The ONE enforcement point for `CEIL_DEV_FUND_BPS`. Re-checked
    /// HERE, at execution, exactly like every other hard ceiling in this
    /// facet set.
    function _applyDevFundBps(uint256 bps) private {
        if (bps > CEIL_DEV_FUND_BPS) revert BadParam();
        DevFundStorage.layout().devFundBps = bps;
        emit DevFundBpsSet(bps);
    }
}
