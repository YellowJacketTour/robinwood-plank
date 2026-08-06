// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {IndexFacetBase} from "./IndexFacetBase.sol";
import {IIndexPriceSource} from "../../IIndexPriceSource.sol";
import {Constituent} from "../../lib/IndexTypes.sol";
import {CoreStorage, EcosystemStorage, DividendStorage} from "../storage/IndexStorage.sol";

/**
 * ============================================================================
 *  IndexBootstrapFacet — seeding, opening, reconciliation, and delisting.
 *
 *  NOT FOR DEPLOYMENT except as a facet.
 *
 *  The seeder has real power only BEFORE the basket opens and none the instant
 *  it does. `openIndex` is ONE-WAY: `CoreStorage.indexOpen` has no path that
 *  writes it back to false anywhere in the finalized facet set, which is what
 *  makes `finalize`'s own `indexOpen == false` precondition meaningful.
 *
 *  `seeder` now lives in `core` storage rather than in an `immutable`, because
 *  under DELEGATECALL an `immutable` resolves to the value baked into whichever
 *  FACET is executing — so two facets would silently disagree about who the
 *  seeder is. It is written once, by the diamond's own constructor, before any
 *  facet exists to be called, and `Diamond.noWriteToImmutables.test.ts` proves
 *  no function in the finalized set writes it again. That is a DIFFERENT proof
 *  from the one `immutable` used to give for free, and it is the replacement
 *  for it rather than a weakening of it.
 * ============================================================================
 */
contract IndexBootstrapFacet is IndexFacetBase {
    // ── The migrated `immutable`s, read-only ───────────────────────────────

    function seeder() external view returns (address) {
        return CoreStorage.layout().seeder;
    }

    function timelockDelay() external view returns (uint256) {
        return CoreStorage.layout().timelockDelay;
    }

    function dividendAsset() external view returns (address) {
        return CoreStorage.layout().dividendAsset;
    }

    function indexOpen() external view returns (bool) {
        return CoreStorage.layout().indexOpen;
    }

    // ══ Bootstrap ═════════════════════════════════════════════════════════

    /// @notice List a constituent before open. Seeder only, bootstrap only.
    function seedConstituent(
        IERC20 token,
        IIndexPriceSource source,
        uint256 rawTargetWeightBps
    ) external nonReentrant {
        CoreStorage.Layout storage cs = CoreStorage.layout();
        if (msg.sender != cs.seeder) revert NotSeeder();
        if (cs.indexOpen) revert IndexAlreadyOpen();
        _list(address(token), source, rawTargetWeightBps, uint64(block.timestamp), 0);
    }

    /// @notice Move constituent tokens into the basket before open. No claim is
    /// minted for them — the seed is donated.
    function seedDeposit(IERC20 token, uint256 amount) external nonReentrant {
        CoreStorage.Layout storage cs = CoreStorage.layout();
        if (msg.sender != cs.seeder) revert NotSeeder();
        if (cs.indexOpen) revert IndexAlreadyOpen();
        Constituent storage c = _get(address(token));
        uint256 credited = _pullCredited(token, msg.sender, amount);
        c.reserve += credited;
        _observe(address(token), c, true);
        emit Seeded(address(token), credited);
    }

    /**
     * @notice Open the basket for public use. Seeder only. ONE-WAY.
     * @dev Requires every listed constituent to hold a strictly positive
     * reserve and at least one price observation, so no leg is born silent.
     * The seed shares go to the canonical dead address permanently, so total
     * supply is never zero while the basket is live — which is what makes the
     * first-depositor inflation attack structurally impossible on top of the
     * virtual-shares offset, rather than merely expensive.
     */
    function openIndex(uint256 seedShares) external nonReentrant {
        CoreStorage.Layout storage cs = CoreStorage.layout();
        if (msg.sender != cs.seeder) revert NotSeeder();
        if (cs.indexOpen) revert IndexAlreadyOpen();
        if (seedShares < MIN_SEED_SHARES) revert BadParam();
        uint256 n = cs.constituentList.length;
        if (n == 0) revert NotListed();
        for (uint256 i = 0; i < n; i++) {
            Constituent storage c = cs.constituents[cs.constituentList[i]];
            if (c.reserve == 0 || c.obsCount == 0) revert ZeroAmount();
            c.rampStart = uint64(block.timestamp);
            c.rampDuration = 0; // genesis constituents start at full weight
        }
        cs.indexOpen = true;
        _mintShares(SEED_LOCK_ADDR, seedShares); // permanently locked, unredeemable
        // THE 0 -> NONZERO TRANSITION, and the only one that ever occurs: see
        // the header above. This is the sole call site for `_armCarry` in the
        // whole facet set. If anything was carried by a stream pushed while
        // supply was zero (pre-open), the release clock starts at the NEXT
        // block — never this one — so the seeder who just opened the index
        // cannot capture it in this same transaction (round 9e).
        _armCarry();
        emit IndexOpened(seedShares);
    }

    // ══ Reconciliation ════════════════════════════════════════════════════

    /**
     * @notice Credit value that is ALREADY held by this contract but accounted
     * nowhere into `token`'s redeemable reserve. Permissionless.
     *
     * The load-bearing line is the SUBTRACTION. `reservedClaims`,
     * `ecosystemFeesWei` and the whole dividend liability are held balances
     * owed elsewhere; a sync that ignored them would re-credit somebody's
     * deferred redemption leg or somebody's accrued dividend into the pro-rata
     * pool. It can never fabricate value (the credit is a measured surplus over
     * everything accounted), never move value out (there is no transfer and no
     * recipient argument), and never be aimed (the credit lands in the reserve
     * of the token named, redeemable pro rata by every holder).
     */
    function syncConstituentBalance(address token) external nonReentrant returns (uint256 credited) {
        CoreStorage.Layout storage cs = CoreStorage.layout();
        Constituent storage c = _get(token);
        uint256 accounted = c.reserve
            + cs.reservedClaims[token]
            + EcosystemStorage.layout().ecosystemFeesWei[token];
        if (token == cs.dividendAsset) {
            DividendStorage.Layout storage d = DividendStorage.layout();
            accounted += d.totalDividendsReceived - d.totalDividendsWithdrawn;
        }
        uint256 bal = IERC20(token).balanceOf(address(this));
        if (bal <= accounted) return 0;
        credited = bal - accounted;
        c.reserve += credited;
        emit ConstituentSynced(token, credited);
        _fireHook(HOOK_AFTER_SYNC_, abi.encode(token, credited));
    }

    /// @notice Drop a deactivated, fully-redeemed constituent. Permissionless
    /// and only ever possible when there is nothing left to strand.
    function delistEmpty(address token) external nonReentrant {
        CoreStorage.Layout storage cs = CoreStorage.layout();
        Constituent storage c = _get(token);
        if (c.active) revert BadParam();
        if (c.reserve != 0) revert ReservesOutstanding();
        uint256 n = cs.constituentList.length;
        for (uint256 i = 0; i < n; i++) {
            if (cs.constituentList[i] == token) {
                cs.constituentList[i] = cs.constituentList[n - 1];
                cs.constituentList.pop();
                break;
            }
        }
        delete cs.constituents[token];
        emit ConstituentDelisted(token);
        _recomputeEligibleCount();
    }
}
