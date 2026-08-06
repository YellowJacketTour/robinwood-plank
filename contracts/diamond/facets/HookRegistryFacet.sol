// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IndexFacetBase} from "./IndexFacetBase.sol";
import {HooksStorage} from "../storage/IndexStorage.sol";

/**
 * ============================================================================
 *  HookRegistryFacet — de-fanged, Uniswap-v4-inspired observer hooks
 *  (design doc section 8, Stage 6).
 *
 *  NOT FOR DEPLOYMENT except as a facet. Owns the `hooks` namespace and
 *  nothing else.
 *
 *  WHAT THIS IS NOT
 *  -----------------
 *  This is not ERC-7575 asset-locking escrow — that model was explicitly
 *  REJECTED for this project. It is not a v4-style hook that can alter
 *  control flow, consume a return value, or gate an operation. A registered
 *  hook is a passive, best-effort OBSERVER: it is told a fact after the fact
 *  and its opinion is never consulted.
 *
 *  THE SIX RULES, ALL NON-NEGOTIABLE (design doc section 8)
 *  ----------------------------------------------------------
 *  1. `CALL`, never `DELEGATECALL` — enforced in `IndexFacetBase._fireHook`,
 *     the only place a hook is ever invoked. This facet's own bytecode makes
 *     no external call at all.
 *  2. Bounded gas (`HOOK_GAS`) — same file, same reasoning as `PAYOUT_GAS`.
 *  3. Non-reverting — a failing hook emits `HookFailed` and is ignored.
 *  4. Hook points are compile-time constants (`HOOK_AFTER_LISTING_`,
 *     `HOOK_AFTER_CHECKPOINT_`, `HOOK_AFTER_SYNC_` in `IndexFacetBase`).
 *     `registerHook` REJECTS any `point` outside that enumerated set —
 *     governance chooses WHO, never WHERE.
 *  5. The enumerated set contains no point on `redeemProRata`, `claimPending`
 *     or `claimPendingMany` — there is no fourth constant to register against,
 *     and `IndexCoreFacet` never imports `HooksStorage` in the first place.
 *     Asserted by `Hooks.exitDoorFree.test.ts` and by
 *     `Diamond.facets.test.ts`'s source-level scan of `IndexCoreFacet`.
 *  6. A hook is never on a value path — `hooksFor`/`hookPermissions` are
 *     views, and `registerHook`'s only effect is a write to the `hooks`
 *     namespace. Nothing here moves a reserve, mints, or burns.
 * ============================================================================
 */
contract HookRegistryFacet is IndexFacetBase {
    // ── The hook points, exposed ONCE ──────────────────────────────────────
    //
    // Same reasoning as `IndexGovernanceFacet`'s role-key getters: the values
    // are `constant` in `IndexFacetBase` so every facet agrees on them, and
    // the `public`-style getters live in exactly one facet to avoid a
    // duplicate-selector rejection at `diamondCut` time.

    function AFTER_LISTING() external pure returns (bytes32) {
        return HOOK_AFTER_LISTING_;
    }

    function AFTER_CHECKPOINT() external pure returns (bytes32) {
        return HOOK_AFTER_CHECKPOINT_;
    }

    function AFTER_SYNC() external pure returns (bytes32) {
        return HOOK_AFTER_SYNC_;
    }

    // ── Views ──────────────────────────────────────────────────────────────

    function hooksFor(bytes32 point) external view returns (address) {
        return HooksStorage.layout().hooks[point];
    }

    function hookPermissions(address hook) external view returns (uint16) {
        return HooksStorage.layout().hookPermissions[hook];
    }

    // ── Registration ───────────────────────────────────────────────────────

    /**
     * @notice Register (or replace, or clear with `hook == address(0)`) the
     * observer at `point`. `ROLE_RISK_PARAM`-gated, and that gate is itself
     * only ever reachable through `IndexGovernanceFacet`'s timelocked role
     * handover (`queueRole` / `executeRole`) — so a hostile hook can only
     * ever be installed by an actor who already cleared the same timelock
     * every other risk-surface change goes through.
     *
     * `permissions` is stored and readable but consulted by NOTHING in this
     * codebase today — it exists as a forward-declared bitmap for an
     * integrator to read off-chain, not as an on-chain gate, which is
     * deliberate: rule 6 is that nothing a hook (or its registration)
     * returns is used in arithmetic anywhere in this facet set.
     */
    function registerHook(bytes32 point, address hook, uint16 permissions) external onlyRole(ROLE_RISK_PARAM_) {
        if (!_isKnownHookPoint(point)) revert InvalidHookPoint(point);
        HooksStorage.Layout storage h = HooksStorage.layout();
        h.hooks[point] = hook;
        h.hookPermissions[hook] = permissions;
        emit HookRegistered(point, hook, permissions);
    }
}
