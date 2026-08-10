// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {IndexFacetBase} from "./IndexFacetBase.sol";
import {Constituent} from "../../lib/IndexTypes.sol";
import {CoreStorage} from "../storage/IndexStorage.sol";

/// @dev Minimal reads/writes of a constituent `CollectionVault`, mirroring
/// `InventoryBuyAdapter.ICollectionVaultBuy` (Pipe I, `contracts/energy/
/// adapters/InventoryBuyAdapter.sol`) plus the two extra reads a zap needs:
/// `swapFeeBps` (to invert the constant-product formula for a target
/// output) and `sellShares` (to unwind an over-bought leg back into payment
/// token rather than stranding it). `CollectionVault` IS the ERC20 share
/// itself (see that contract's own header) — `vault`'s address doubles as
/// the constituent token address.
interface ICollectionVaultZap {
    function buyShares(uint256 amountIn, uint256 minSharesOut) external returns (uint256 sharesOut);
    function sellShares(uint256 sharesIn, uint256 minAmountOut) external returns (uint256 amountOut);
    function paymentReserve() external view returns (uint256);
    function shareReserve() external view returns (uint256);
    function poolOpen() external view returns (bool);
    function paymentToken() external view returns (address);
    function swapFeeBps() external view returns (uint256);
}

/**
 * ============================================================================
 *  IndexZapFacet — single-payment-asset zap into the weighted-basket mint.
 *  DESIGN-COLLECTION-VAULT-NATIVE-LP-AND-ZAP-MINT-2026-08-08.md §3.2.
 *
 *  NOT FOR DEPLOYMENT except as a facet.
 *
 *  WHAT THIS IS. One call, one input asset (`CoreStorage.dividendAsset`,
 *  the same WETH-shaped `paymentToken` every constituent `CollectionVault`
 *  already prices its own AMM in), automatic acquisition of the exact
 *  weighted basket `IndexCoreFacet.mintProRata` would otherwise require the
 *  caller to already hold, and an EXACT `desiredSharesOut` gross mint — or
 *  a clean revert, never a partial fill.
 *
 *  WHY THIS DOES NOT LITERALLY CALL `IndexCoreFacet.mintProRata` AS AN
 *  EXTERNAL SELF-CALL. `mintProRata` prices `want` per leg with the SAME
 *  formula reused verbatim below —
 *  `Math.mulDiv(sharesOut, c.reserve + VIRTUAL_ASSETS, denom, Math.Rounding.Up)`
 *  — and then PULLS that amount FROM `msg.sender` via
 *  `_pullCredited`/`safeTransferFrom`. A zap's whole point is that the
 *  diamond itself already holds the freshly-bought constituent tokens
 *  (every `buyShares` leg below lands them at `address(this)`, since the
 *  diamond itself is the caller placing that swap) — so a self-call to the
 *  external `mintProRata` selector would resolve to
 *  `token.safeTransferFrom(address(this), address(this), want)`, a
 *  transfer whose OBSERVED BALANCE DELTA is zero by construction
 *  (`_pullCredited` reverts `ZeroAmount` on exactly this shape — a diamond
 *  cannot pull-from-itself and observe a delta). This facet therefore
 *  shares `IndexFacetBase`'s internal mint core DIRECTLY
 *  (`_mintWithAllocation`, `_routeDevFundBuy`, `_revestOnMint`,
 *  `_attemptOpportunisticReconcile`, `CoreStorage`) — the SAME machinery
 *  `mintProRata` runs on every leg, differing only in HOW `credited` for
 *  each leg is obtained: an AMM buy against that constituent's own vault
 *  instead of a transfer from an external caller who already held the
 *  basket. No pricing formula is re-derived, only the acquisition step is
 *  new, and every constituent is assumed to be a `CollectionVault`'s own
 *  share admitted the same way Pipe I's `InventoryBuyAdapter` already
 *  assumes — no external router, no new price-trusted venue (design doc
 *  §3.2 NOT-YET-DECIDED item 1's chosen, conservative default).
 *
 *  ATOMICITY, DELIBERATELY UNLIKE `InventoryBuyAdapter`. Pipe I's adapter is
 *  a background compounding process and skips a failed leg on purpose. A
 *  zap is a direct user action with one specific desired outcome: every
 *  guard below (`ZapPoolNotOpen`, `SlippageExceeded`, `ZapImpactTooHigh`,
 *  `ZapInsufficientBasketLiquidity`) is a plain `revert`, unwinding the
 *  WHOLE transaction — the caller gets exactly `desiredSharesOut` or
 *  nothing, never a partial basket and never a partial mint.
 * ============================================================================
 */
contract IndexZapFacet is IndexFacetBase {
    using SafeERC20 for IERC20;

    /// @dev Verbatim from `InventoryBuyAdapter.MAX_IMPACT_BPS`
    /// (`contracts/energy/adapters/InventoryBuyAdapter.sol:108`) — the SAME
    /// already-vetted 3% ceiling, reused rather than re-derived, per design
    /// doc §3.2's own NOT-YET-DECIDED resolution ("strong justified
    /// default: yes, reuse the identical 3% ceiling verbatim").
    uint256 public constant MAX_ZAP_IMPACT_BPS = 300;

    error ZapPoolNotOpen();
    error ZapImpactTooHigh();
    error ZapInsufficientBasketLiquidity();
    error ZapWrongPaymentToken();
    /// @notice AUDIT H-2: the leg is not a vault the configured
    /// `CollectionVaultFactory` deployed, so it never receives an allowance
    /// over the diamond's payment token.
    error ZapUnverifiedLeg(address token);
    /// @notice `bringAmounts` (zapMintHybrid) must have exactly one entry
    /// per current constituent, same order as `constituentList` — the same
    /// discipline `mintProRata`'s own `maxAmountsIn` already requires.
    error ZapBadBringLength();

    /// @notice One zap-mint completed. `paymentSpent` is the REAL, net cost
    /// across every leg (after any excess-share sell-back), never a nominal
    /// figure; `paymentRefunded` is exactly `maxPaymentIn - paymentSpent`.
    event ZapMinted(address indexed to, uint256 sharesOut, uint256 paymentSpent, uint256 paymentRefunded);

    /// @notice One constituent leg of a zap: bought `sharesBought` for
    /// `paymentIn`, kept `sharesUsed` (== that leg's pro-rata `want`) toward
    /// the mint, and sold the rest straight back for `refundOut`.
    event ZapLegBought(
        address indexed vault,
        uint256 paymentIn,
        uint256 sharesBought,
        uint256 sharesUsed,
        uint256 refundOut
    );

    /**
     * @notice Deposit ONE payment-token amount, receive an exact
     * `desiredSharesOut`-priced mint, or revert atomically.
     * @param desiredSharesOut exact gross index-coin amount to mint (the
     * same "gross" `mintProRata`'s own `sharesOut` argument names — a
     * configured platform allocation may still split part of it off, same
     * as every other mint path in this diamond).
     * @param maxPaymentIn the caller's own MEV/slippage bound: the whole
     * basket's real acquisition cost (summed over every leg, net of any
     * excess-share sell-back) must not exceed this, or the WHOLE
     * transaction reverts. Any of `maxPaymentIn` left unspent is refunded.
     */
    function zapMint(uint256 desiredSharesOut, uint256 maxPaymentIn)
        external
        nonReentrant
        whenOpen
        returns (uint256 sharesOut, uint256 paymentSpent)
    {
        if (desiredSharesOut == 0) revert ZeroAmount();
        if (maxPaymentIn == 0) revert ZeroAmount();

        IERC20 payment = IERC20(CoreStorage.layout().dividendAsset);

        // Pull the caller's whole slippage budget up front, observed-delta
        // discipline exactly like every other entry point in this diamond —
        // never a caller-nominal figure trusted further down.
        uint256 budget = _pullCredited(payment, msg.sender, maxPaymentIn);
        uint256 supplyBefore = _totalSupply();
        uint256[] memory weightsBefore = _allWeightsBps();

        uint256 totalSpent = _acquireBasket(payment, desiredSharesOut, budget, supplyBefore);

        sharesOut = _mintWithAllocation(msg.sender, desiredSharesOut);
        _requireCapNotWorsened(weightsBefore);

        // Round 9f, ported verbatim per the same reasoning `mintProRata`/
        // `mintSingleAsset` already apply: this path also grows
        // `totalSupply`, so it also displaces stream backing proportionally.
        _revestOnMint(desiredSharesOut, supplyBefore);

        // Adversarial-review-fix parity with `mintProRata`/`mintSingleAsset`
        // (design doc §7.2): opportunistically reconcile every constituent
        // this zap just touched. Non-blocking; see
        // `_attemptOpportunisticReconcile`'s header.
        address[] memory list = CoreStorage.layout().constituentList;
        for (uint256 i = 0; i < list.length; i++) {
            _attemptOpportunisticReconcile(list[i]);
        }

        // Requirement 4: any WETH left over after acquiring the exact
        // basket (rounding headroom on every leg's buy-then-sell-back) is
        // returned to the caller, never stranded.
        uint256 refund = budget - totalSpent;
        if (refund > 0) payment.safeTransfer(msg.sender, refund);

        paymentSpent = totalSpent;
        emit ZapMinted(msg.sender, sharesOut, totalSpent, refund);
    }

    /**
     * @notice Like `zapMint`, but for each constituent leg the caller may
     * bring shares they ALREADY hold instead of paying to buy them fresh —
     * `bringAmounts[i]` is how much of `constituentList[i]`'s own token
     * (approved to this diamond beforehand) to credit directly for that
     * leg. Only the SHORTFALL still needed to reach that leg's pro-rata
     * `want` is bought via AMM, exactly the way `zapMint` buys the whole
     * leg. Still the full weighted basket, every leg filled, one way or
     * another — an index share is an equal claim on the ENTIRE basket, so
     * there is no such thing as a partial-basket mint; what this function
     * makes flexible is WHICH SOURCE funds each leg, never WHICH LEGS are
     * included. `bringAmounts[i] == 0` for every leg is exactly `zapMint`.
     * @param bringAmounts one entry per CURRENT constituent, same order as
     * `constituentList` — reverts `ZapBadBringLength` on a length mismatch,
     * the same discipline `mintProRata`'s `maxAmountsIn` already requires.
     */
    function zapMintHybrid(uint256 desiredSharesOut, uint256 maxPaymentIn, uint256[] calldata bringAmounts)
        external
        nonReentrant
        whenOpen
        returns (uint256 sharesOut, uint256 paymentSpent)
    {
        if (desiredSharesOut == 0) revert ZeroAmount();
        if (maxPaymentIn == 0) revert ZeroAmount();

        CoreStorage.Layout storage cs = CoreStorage.layout();
        if (bringAmounts.length != cs.constituentList.length) revert ZapBadBringLength();

        IERC20 payment = IERC20(cs.dividendAsset);
        uint256 budget = _pullCredited(payment, msg.sender, maxPaymentIn);
        uint256 supplyBefore = _totalSupply();
        uint256[] memory weightsBefore = _allWeightsBps();

        uint256 totalSpent = _acquireBasketHybrid(payment, desiredSharesOut, budget, supplyBefore, bringAmounts);

        sharesOut = _mintWithAllocation(msg.sender, desiredSharesOut);
        _requireCapNotWorsened(weightsBefore);
        _revestOnMint(desiredSharesOut, supplyBefore);

        address[] memory list = cs.constituentList;
        for (uint256 i = 0; i < list.length; i++) {
            _attemptOpportunisticReconcile(list[i]);
        }

        uint256 refund = budget - totalSpent;
        if (refund > 0) payment.safeTransfer(msg.sender, refund);

        paymentSpent = totalSpent;
        emit ZapMinted(msg.sender, sharesOut, totalSpent, refund);
    }

    /// @dev Hybrid counterpart of `_acquireBasket` — same formula, same
    /// per-leg budget accounting, same all-or-nothing revert semantics;
    /// only `_acquireAndCreditHybrid` differs from `_acquireAndCredit`.
    function _acquireBasketHybrid(
        IERC20 payment,
        uint256 desiredSharesOut,
        uint256 budget,
        uint256 supplyBefore,
        uint256[] calldata bringAmounts
    ) private returns (uint256 totalSpent) {
        CoreStorage.Layout storage cs = CoreStorage.layout();
        uint256 denom = supplyBefore + VIRTUAL_SHARES;
        uint256 n = cs.constituentList.length;

        for (uint256 i = 0; i < n; i++) {
            address t = cs.constituentList[i];
            _requireNotExiting(t, cs.constituents[t]);
            uint256 want = _wantFor(t, desiredSharesOut, denom);

            // Never pull more than this leg actually needs, regardless of
            // what the caller passed — an over-generous `bringAmounts[i]`
            // is simply clamped, never a reason to revert or to strand
            // excess approval.
            totalSpent += _acquireAndCreditHybrid(
                payment, t, want, bringAmounts[i] > want ? want : bringAmounts[i], budget - totalSpent
            );
            if (totalSpent > budget) revert SlippageExceeded();
        }
    }

    /// @dev Split out of `_acquireBasketHybrid` purely for stack budget —
    /// same reason `_acquireBasket`/`_acquireAndCredit`/`_acquireLeg` are
    /// already split in this file. Byte-for-byte the same per-leg formula
    /// `_acquireBasket` uses inline; not re-derived, only reused.
    function _wantFor(address t, uint256 desiredSharesOut, uint256 denom) private view returns (uint256 want) {
        want = Math.mulDiv(
            desiredSharesOut,
            CoreStorage.layout().constituents[t].reserve + VIRTUAL_ASSETS,
            denom,
            Math.Rounding.Up
        );
        if (want == 0) revert ZeroAmount();
    }

    /// @dev Same "credit an observed delta, never a number we computed"
    /// discipline as `_acquireAndCredit` (audit H-2) — extended across BOTH
    /// funding sources for one leg, not just the AMM buy. The balance
    /// delta is measured across the WHOLE leg (pull, then buy-the-
    /// shortfall, then any excess sell-back inside `_acquireLeg`), so a
    /// caller-side short delivery (a fee-on-transfer constituent, an
    /// approval race) is caught by the SAME `ShortDelivery` revert as an
    /// AMM-side one — there is exactly one point where this leg's credit is
    /// ever trusted, regardless of how many sub-steps funded it.
    function _acquireAndCreditHybrid(IERC20 payment, address token, uint256 want, uint256 bring, uint256 remaining)
        private
        returns (uint256 spent)
    {
        uint256 beforeBal = IERC20(token).balanceOf(address(this));
        if (bring > 0) {
            IERC20(token).safeTransferFrom(msg.sender, address(this), bring);
        }
        uint256 fromCaller = IERC20(token).balanceOf(address(this)) - beforeBal;
        uint256 stillNeeded = fromCaller >= want ? 0 : want - fromCaller;
        if (stillNeeded > 0) {
            spent = _acquireLeg(payment, token, stillNeeded, remaining);
        }

        uint256 credited = IERC20(token).balanceOf(address(this)) - beforeBal;
        if (credited < want) revert ShortDelivery();

        CoreStorage.layout().constituents[token].reserve += _routeDevFundBuy(token, credited);
    }

    /**
     * @dev The per-leg acquisition loop, split into its own function purely
     * to keep `zapMint`'s own stack frame small (the loop body's locals —
     * `want`, `remaining`, `spent` — would otherwise coexist with every
     * variable declared around it in one frame). Same formula, same guards,
     * same all-or-nothing revert semantics as documented on `zapMint` and
     * `_acquireLeg` — this is a stack-budget split, not a behavioral one.
     */
    function _acquireBasket(IERC20 payment, uint256 desiredSharesOut, uint256 budget, uint256 supplyBefore)
        private
        returns (uint256 totalSpent)
    {
        CoreStorage.Layout storage cs = CoreStorage.layout();
        uint256 denom = supplyBefore + VIRTUAL_SHARES;
        uint256 n = cs.constituentList.length;

        for (uint256 i = 0; i < n; i++) {
            address t = cs.constituentList[i];
            _requireNotExiting(t, cs.constituents[t]);

            // Byte-for-byte `IndexCoreFacet.mintProRata`'s own per-leg
            // formula — the pricing is not re-derived, only reused.
            uint256 want = Math.mulDiv(
                desiredSharesOut,
                cs.constituents[t].reserve + VIRTUAL_ASSETS,
                denom,
                Math.Rounding.Up
            );
            if (want == 0) revert ZeroAmount();

            totalSpent += _acquireAndCredit(payment, t, want, budget - totalSpent);
            if (totalSpent > budget) revert SlippageExceeded();
        }
    }

    /**
     * @dev AUDIT H-2, CLOSED: CREDIT AN OBSERVED DELTA, NEVER A NUMBER WE
     * COMPUTED.
     *
     * `_acquireBasket` used to do `c.reserve += _routeDevFundBuy(t, want)` —
     * `want` being the amount this facet DECIDED it wanted, not the amount that
     * arrived. Every other mint path in this diamond obtains its credit through
     * `_pullCredited`'s balance-delta discipline and refuses a `ShortDelivery`;
     * this one path trusted its own arithmetic about an external AMM's output,
     * through a fee-on-transfer-capable ERC-20, with a sell-back leg in the
     * middle. A leg that delivered less than `want` — a fee-on-transfer
     * constituent, a rounding shortfall, a vault whose `buyShares`
     * under-delivers — minted full shares against a partial deposit and diluted
     * every existing holder.
     *
     * The delta is measured across the WHOLE leg (buy AND excess sell-back), so
     * the unwind is inside the measurement rather than assumed away, and
     * `ShortDelivery` is the same hard revert `mintProRata` uses for the same
     * reason: this path mints an EXACT `desiredSharesOut`, so silently
     * absorbing a shortfall IS dilution.
     *
     * Also split out to keep `_acquireBasket`'s stack frame inside the EVM's
     * 16-slot reach.
     */
    function _acquireAndCredit(IERC20 payment, address token, uint256 want, uint256 remaining)
        private
        returns (uint256 spent)
    {
        uint256 beforeBal = IERC20(token).balanceOf(address(this));
        spent = _acquireLeg(payment, token, want, remaining);
        uint256 credited = IERC20(token).balanceOf(address(this)) - beforeBal;
        if (credited < want) revert ShortDelivery();

        // §7.11, verbatim from `mintProRata`'s own leg: a small governed slice
        // of what this leg is actually worth may route to a PLANK buy for the
        // dev-fund treasury before the remainder backs the newly-minted shares.
        CoreStorage.layout().constituents[token].reserve += _routeDevFundBuy(token, credited);
    }

    /**
     * @dev Buys AT LEAST `want` of `token` (a `CollectionVault`'s own
     * share) using at most `remaining` payment-token budget, then sells any
     * excess straight back into payment token so nothing is stranded at the
     * diamond's own balance. `MAX_ZAP_IMPACT_BPS` is checked against the BUY
     * leg's own constant-product output vs. its no-impact spot estimate,
     * mirroring `InventoryBuyAdapter.buyLeg` exactly (design doc §3.2
     * requirement 2's "respect each constituent's existing MAX_IMPACT_BPS-
     * style impact guard on every swap leg"). A leg that cannot be acquired
     * within its budget or impact bound REVERTS here, which — unlike
     * `InventoryBuyAdapter`'s deliberate per-leg skip — unwinds this WHOLE
     * transaction (design doc §3.2 requirement 3).
     * @return netSpent the real payment-token cost of this leg, after
     * netting out whatever the excess-share sell-back recovered.
     */
    function _acquireLeg(IERC20 payment, address token, uint256 want, uint256 remaining)
        private
        returns (uint256 netSpent)
    {
        // ── AUDIT H-2, second half: VALIDATE PROVENANCE **BEFORE** GRANTING
        // AN ALLOWANCE. The previous order was: ask the untrusted address
        // about itself (`poolOpen()`, `paymentToken()`), believe the answers,
        // then `forceApprove` it over the diamond's WETH. Asking an address
        // whether it is trustworthy is not validation — a hostile contract
        // returns whatever makes the caller proceed. The only question worth
        // asking is one it cannot answer for itself: did the
        // `CollectionVaultFactory` deploy it? That is checked FIRST, and the
        // self-reported reads below are retained only as sanity checks on an
        // address that has already proven its provenance.
        //
        // Fail-closed: with no registry configured, no leg is verifiable and
        // the zap cannot run at all. That is the correct direction for a
        // function that hands out spending authority.
        if (!_isProvenancedVault(token)) revert ZapUnverifiedLeg(token);

        ICollectionVaultZap v = ICollectionVaultZap(token);
        if (!v.poolOpen()) revert ZapPoolNotOpen();
        if (v.paymentToken() != address(payment)) revert ZapWrongPaymentToken();

        (uint256 amountIn, uint256 spotShares) = _quoteLeg(v, want);
        if (amountIn > remaining) revert SlippageExceeded();

        payment.forceApprove(token, amountIn);
        uint256 sharesOut = v.buyShares(amountIn, want);
        payment.forceApprove(token, 0);
        _checkImpact(spotShares, sharesOut);

        uint256 refundOut;
        netSpent = amountIn;
        if (sharesOut > want) {
            refundOut = v.sellShares(sharesOut - want, 0);
            netSpent = refundOut >= amountIn ? 0 : amountIn - refundOut;
        }

        emit ZapLegBought(token, amountIn, sharesOut, want, refundOut);
    }

    /**
     * @dev Invert the vault's own constant-product pricing
     * (`CollectionVault.buyShares`) to ESTIMATE the payment-token amount
     * that buys `want` shares, plus the no-impact "spot" share count that
     * same estimated amount would buy at the CURRENT ratio (for
     * `_checkImpact` below) — split out of `_acquireLeg` purely to keep
     * that function's stack frame small.
     *
     * Forward direction, exactly as `buyShares` computes it:
     *   fee     = credited * swapFeeBps / BPS
     *   sinkCut = fee * 5000 / BPS                      (SWAP_SINK_SPLIT_BPS)
     *   netIn   = credited - sinkCut
     *   inNet   = netIn * (BPS - swapFeeBps) / BPS
     *   sharesOut = inNet * shareReserve / (paymentReserve + inNet)
     * Inverting the two floored fee steps together (ignoring the
     * integer-rounding slack each floor drops, which only ever makes this
     * an UNDER-estimate — covered by the fixed headroom below, and any
     * remaining overshoot is unwound by `_acquireLeg`'s own sell-back):
     *   credited ~= inNet * (2*BPS) * BPS / ((2*BPS - swapFeeBps) * (BPS - swapFeeBps))
     */
    function _quoteLeg(ICollectionVaultZap v, uint256 want)
        private
        view
        returns (uint256 amountIn, uint256 spotShares)
    {
        uint256 paymentReserveBefore = v.paymentReserve();
        uint256 shareReserveBefore = v.shareReserve();
        if (want >= shareReserveBefore) revert ZapInsufficientBasketLiquidity();

        uint256 swapFeeBps = v.swapFeeBps();
        uint256 inNetNeeded = Math.mulDiv(want, paymentReserveBefore, shareReserveBefore - want, Math.Rounding.Up);
        uint256 k = (2 * BPS - swapFeeBps) * (BPS - swapFeeBps);
        amountIn = Math.mulDiv(inNetNeeded, 2 * BPS * BPS, k, Math.Rounding.Up);
        // 0.2% fixed headroom plus a small constant, absorbing the
        // integer-rounding slack the closed-form inversion above drops.
        amountIn = amountIn + (amountIn / 500) + 16;

        spotShares = (amountIn * shareReserveBefore) / (paymentReserveBefore + amountIn);
    }

    /// @dev Verbatim shape of `InventoryBuyAdapter.buyLeg`'s own impact
    /// check, against `MAX_ZAP_IMPACT_BPS`.
    function _checkImpact(uint256 spotShares, uint256 sharesOut) private pure {
        if (spotShares == 0) return;
        uint256 shortfall = spotShares > sharesOut ? spotShares - sharesOut : 0;
        uint256 impactBps = (shortfall * BPS) / spotShares;
        if (impactBps > MAX_ZAP_IMPACT_BPS) revert ZapImpactTooHigh();
    }
}
