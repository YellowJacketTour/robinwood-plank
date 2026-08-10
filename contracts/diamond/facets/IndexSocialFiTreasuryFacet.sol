// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IndexFacetBase} from "./IndexFacetBase.sol";
import {CoreStorage, PlatformTreasuryStorage} from "../storage/IndexStorage.sol";

/**
 * ============================================================================
 *  IndexSocialFiTreasuryFacet — §7.12 "platform socialfi treasury"
 *  (design doc DESIGN-N-VAULT-FACTORY-AND-VALUE-ACCRUAL-2026-08-06.md §7.12).
 *
 *  NOT FOR DEPLOYMENT except as a facet.
 *
 *  NAMED `SocialFi`, NOT `PlatformTreasury`, DELIBERATELY: `IndexGovernanceFacet`
 *  already exposes a DIFFERENT, unrelated `platformTreasury()` /
 *  `executePlatformTreasury()` pair over `AllocationStorage` (the §7.x
 *  mint-allocation share recipient — a share-mint destination, not a fee
 *  carve-out). Reusing that name here would collide on the exact same
 *  selectors `diamondCut` already owns, and would blur two genuinely
 *  different mechanisms under one name. `PlatformTreasuryStorage` is the
 *  storage library's name only (never exposed as a getter directly); every
 *  externally callable surface in this facet uses the `socialFi*` prefix so
 *  it cannot collide with, or be confused with, `AllocationStorage`'s
 *  `platformTreasury`.
 *
 *  READ THIS BEFORE TOUCHING ANYTHING IN THIS FILE: THIS IS DELIBERATELY,
 *  EXPLICITLY THE SAME DIFFERENT TRUST MODEL AS `IndexDevFundFacet` (§7.11),
 *  AND THE DESIGN DOC SAYS SO IN ITS OWN WORDS, RESTATED HERE BECAUSE IT IS
 *  EASY TO BLUR THE TWO TOGETHER.
 *
 *  Every other value-routing mechanism this codebase has built (§7.3's
 *  reserve growth and dividend claim, §7.7's buyback-and-lock) is engineered
 *  so that no one, including the team, has spending access to the value it
 *  routes — that is the whole point of the non-decreasing-NAV invariant and
 *  the lock-not-renounce pattern `IndexBuybackFacet` uses. This treasury is,
 *  honestly, the opposite: real, spendable value under team control,
 *  earmarked (per the design doc) to fund future PLANK airdrops tied to a
 *  socialfi leaderboard system, a later and separate product design this
 *  facet only funds, never specifies. That is a legitimate and common DeFi
 *  pattern, but this file — and every comment, event and test near it — MUST
 *  NOT use "no admin path", "no one can touch it", or equivalent language,
 *  because it would be false here. `treasury` is disclosed as intended, in
 *  production, to be a timelocked multisig, not a bare EOA — but nothing in
 *  Solidity's type system can enforce what kind of address a caller
 *  supplies, so that is a deployment discipline, not an on-chain guarantee
 *  this facet makes.
 *
 *  WHAT IS DIFFERENT FROM §7.11, MECHANICALLY:
 *   - §7.11 skims a percentage of a MINT's payment, at mint time. §7.12
 *     carves a percentage out of value ALREADY reaching the index sink via
 *     §7.2's mandatory routing (swap-fee splits and mint/redeem fees, across
 *     every vault) — measured and credited through the identical
 *     `_sync`/`reconcile` path §7.2/§7.3 already built — BEFORE that value
 *     counts toward §7.3's three-way split (reserve growth / dividend pot /
 *     buyback earmark). The three-way split's ratios apply to what is LEFT
 *     after this carve-out, never to the original credited amount.
 *   - §7.11 swaps its skim for PLANK through an external router (a `try/
 *     catch`-guarded, revert-tolerant call). §7.12 has no swap and no
 *     router: the carved share is delivered to `treasury` by a plain
 *     `IERC20.safeTransfer`, the exact push-then-opportunistic-reconcile
 *     plumbing already proven in §7.2 — atomic, cannot brick the sync it
 *     rides on, because a standard ERC-20 transfer to a governed address
 *     either succeeds or reverts the whole `_sync` call; there is no
 *     partial-failure state to guard against the way an external swap venue
 *     needs one.
 *
 *  WHAT IS ACTUALLY BOUNDED HERE, MECHANICALLY:
 *   - `carveOutBps` cannot exceed `IndexFacetBase.CEIL_PLATFORM_TREASURY_BPS`
 *     (5%), enforced at EXECUTION (`_applySocialFiTreasuryBps`), the same "a
 *     timelock bounds WHEN, never HOW BIG" doctrine `CEIL_DEV_FUND_BPS` and
 *     `CEIL_BUYBACK_SPLIT_BPS` already prove for the other two governed
 *     splits in this facet set.
 *  WHICH ROLE GOVERNS THIS (2026-08-09 audit fix M-5 — CHANGED):
 *  `queueSocialFiTreasury` / `queueSocialFiTreasuryBps` sat behind
 *  ROLE_RISK_PARAM and now sit behind ROLE_PLATFORM_ALLOCATION, for the same
 *  reason and by the same rule as `IndexDevFundFacet`'s pair — see that
 *  file's header. In one line: the risk role owns what anyone is CHARGED;
 *  this facet only decides where an ALREADY-CHARGED fee is BOOKED, which is
 *  the value-flow role's half of `IndexParams.roleForParamKey`'s own stated
 *  split. A compromised risk key can no longer redirect a spendable treasury
 *  to an address of its choosing.
 *
 *   - `treasury` and `carveOutBps` are BOTH governed and timelocked through
 *     the identical queue/execute pair every other risk-surface change in
 *     this facet set uses (`IndexDevFundFacet.queueDevFundTreasury`'s shape,
 *     `IndexGovernanceFacet.queueParam`'s shape) — so a change to WHO
 *     receives the carve-out, or WHAT FRACTION of routed value is carved, is
 *     visible and delayed exactly like every other privileged action here,
 *     never instant and silent.
 *   - the actual carve-out — `IndexFacetBase._creditRoutedValue`, called
 *     from `IndexBootstrapFacet._sync` on every `syncConstituentBalance` and
 *     `reconcile` call — runs BEFORE the three-way split, on every token the
 *     split ever sees (ETH/payment-token or collection shares alike, since
 *     `_sync` is per-token and this carve-out lives inside the one function
 *     every token's routed credit passes through).
 *
 *  WHAT IS EXPLICITLY NOT DECIDED HERE, PER THE DESIGN DOC: the exact
 *  percentage, the treasury's real-world multisig threshold/signer set, and
 *  the actual shape of the socialfi leaderboard / airdrop-eligibility system
 *  itself. Those are governance and product decisions this facet only
 *  provides the MECHANISM for, never the policy.
 * ============================================================================
 */
contract IndexSocialFiTreasuryFacet is IndexFacetBase {
    // ── Views ───────────────────────────────────────────────────────────

    function socialFiTreasury() external view returns (address) {
        return PlatformTreasuryStorage.layout().treasury;
    }

    function socialFiTreasuryBps() external view returns (uint256) {
        return PlatformTreasuryStorage.layout().carveOutBps;
    }

    function queuedSocialFiTreasury() external view returns (address value, uint64 eta, bool pending) {
        PlatformTreasuryStorage.QueuedAddress storage q = PlatformTreasuryStorage.layout().queuedTreasury;
        return (q.value, q.eta, q.pending);
    }

    function queuedSocialFiTreasuryBps() external view returns (uint256 value, uint64 eta, bool pending) {
        PlatformTreasuryStorage.QueuedUint256 storage q = PlatformTreasuryStorage.layout().queuedCarveOutBps;
        return (q.value, q.eta, q.pending);
    }

    // ── Treasury ────────────────────────────────────────────────────────

    /**
     * @notice Queue a new socialfi-treasury address — the destination the
     * carved-out share of every routed fee is delivered to. Documented, not
     * enforced: in production this is intended to be a timelocked multisig,
     * never a bare EOA, so that spending OUT of the treasury is itself
     * visible and delayed rather than instant and silent. This facet cannot
     * check what kind of address it is; the governance-setter for it is
     * itself timelocked, exactly like every other privileged address change
     * in this codebase, which is the property this facet DOES mechanically
     * provide.
     */
    function queueSocialFiTreasury(address treasury) external onlyRole(ROLE_PLATFORM_ALLOCATION_) {
        uint64 eta = uint64(block.timestamp + CoreStorage.layout().timelockDelay);
        PlatformTreasuryStorage.layout().queuedTreasury =
            PlatformTreasuryStorage.QueuedAddress({value: treasury, eta: eta, pending: true});
        emit SocialFiTreasuryQueued(treasury, eta);
    }

    function executeSocialFiTreasury() external {
        PlatformTreasuryStorage.Layout storage pt = PlatformTreasuryStorage.layout();
        PlatformTreasuryStorage.QueuedAddress memory q = pt.queuedTreasury;
        if (!q.pending) revert NothingQueued();
        _requireMature(q.eta); // AUDIT M-1: eta <= now <= eta + GRACE_PERIOD
        delete pt.queuedTreasury;
        pt.treasury = q.value;
        emit SocialFiTreasurySet(q.value);
    }

    // ── The governed percentage ────────────────────────────────────────

    /**
     * @notice Queue a new socialfi-treasury carve-out, in bps of value
     * reaching `_creditRoutedValue`, taken BEFORE §7.3's three-way split
     * runs. Ceiling is checked at EXECUTION, not here — same "a timelock
     * bounds WHEN, not HOW BIG" doctrine `IndexDevFundFacet.queueDevFundBps`
     * and `IndexGovernanceFacet._applyValueAccrualSplit` already document,
     * so a governance vote for an absurd value is visible for the FULL delay
     * before it can ever be rejected at the floor.
     */
    function queueSocialFiTreasuryBps(uint256 bps) external onlyRole(ROLE_PLATFORM_ALLOCATION_) {
        uint64 eta = uint64(block.timestamp + CoreStorage.layout().timelockDelay);
        PlatformTreasuryStorage.layout().queuedCarveOutBps =
            PlatformTreasuryStorage.QueuedUint256({value: bps, eta: eta, pending: true});
        emit SocialFiTreasuryBpsQueued(bps, eta);
    }

    function executeSocialFiTreasuryBps() external {
        PlatformTreasuryStorage.Layout storage pt = PlatformTreasuryStorage.layout();
        PlatformTreasuryStorage.QueuedUint256 memory q = pt.queuedCarveOutBps;
        if (!q.pending) revert NothingQueued();
        _requireMature(q.eta); // AUDIT M-1: eta <= now <= eta + GRACE_PERIOD
        delete pt.queuedCarveOutBps;
        _applySocialFiTreasuryBps(q.value);
    }

    /// @dev The ONE enforcement point for `CEIL_PLATFORM_TREASURY_BPS`.
    /// Re-checked HERE, at execution, exactly like every other hard ceiling
    /// in this facet set.
    function _applySocialFiTreasuryBps(uint256 bps) private {
        if (bps > CEIL_PLATFORM_TREASURY_BPS) revert BadParam();
        PlatformTreasuryStorage.layout().carveOutBps = bps;
        emit SocialFiTreasuryBpsSet(bps);
    }
}
