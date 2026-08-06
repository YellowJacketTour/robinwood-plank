// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {IndexFacetBase} from "./IndexFacetBase.sol";
import {Constituent} from "../../lib/IndexTypes.sol";

/**
 * ============================================================================
 *  IndexTradeFacet — the two PRICED, single-asset convenience paths.
 *
 *  NOT FOR DEPLOYMENT except as a facet.
 *
 *  Both paths here are conveniences priced at what they cost. The FREE path —
 *  strict pro-rata in-kind redemption — is in `IndexCoreFacet` and shares
 *  nothing with this file except the storage it reads: no function here can be
 *  reached from `redeemProRata`, and nothing here can gate it.
 *
 *  DIRECTION SYMMETRY. There is ONE imbalance-fee formula and both paths charge
 *  it, with the identical shape of arguments — (the non-pro-rata amount, the
 *  depth it is charged against). No `isBuy` argument, no direction branch, no
 *  second fee table, no directional multiplier. The ONE asymmetry that exists
 *  is `_mintFeeBps`, and it is a function of (current weight, target weight)
 *  only: it vanishes identically at target, and it is not keyed on
 *  buy-versus-sell at all. It is deliberately not mirrored onto the redeem
 *  side, because mirroring it would SURCHARGE an exit that unbalances the
 *  basket — charging less to rebalance on the way in is a discount; charging
 *  more to leave is a lock-in.
 * ============================================================================
 */
contract IndexTradeFacet is IndexFacetBase {
    using SafeERC20 for IERC20;

    /**
     * @notice Mint by depositing ONE constituent.
     * @dev Conservative in three independent places: what you deposit is valued
     * at that constituent's band LOW, the basket you are buying into is valued
     * at NAV_HIGH, and the imbalance fee is subtracted from the resulting
     * shares. An asymmetric-fee basket is a basket you can round-trip for free
     * in one direction, so the deposit side mirrors the redemption side's fee.
     */
    function mintSingleAsset(
        address token,
        uint256 amountIn,
        uint256 minSharesOut
    ) external nonReentrant whenOpen returns (uint256 sharesOut) {
        if (amountIn == 0) revert ZeroAmount();
        Constituent storage c = _get(token);
        _requireNotExiting(token, c);

        (uint256 lo, , ) = _priceBand(token);
        if (lo == 0) revert StalePrice();
        (, uint256 navHigh) = _nav();
        if (navHigh == 0) revert NoPriceData();

        uint256 credited = _pullCredited(IERC20(token), msg.sender, amountIn);
        uint256 ethValue = Math.mulDiv(credited, lo, WAD);
        _requirePersistenceIfLarge(token, ethValue, false);

        // Pro-rata-equivalent shares, floored, against the OVER-stated basket.
        uint256 supplyBefore = _totalSupply();
        sharesOut = Math.mulDiv(ethValue, supplyBefore + VIRTUAL_SHARES, navHigh + VIRTUAL_ASSETS);
        uint256 feeBps = _mintFeeBps(token, _imbalanceFeeBps(credited, c.reserve));
        sharesOut -= (sharesOut * feeBps) / BPS;
        if (sharesOut == 0) revert ZeroAmount();

        uint256[] memory weightsBefore = _allWeightsBps();
        // The fee this mint charged, expressed in the DEPOSITED token. The
        // split is taken out of THAT and nothing else; whatever is not split
        // off still lands in the reserve and still lifts NAV per share.
        c.reserve += credited - _accrueEcosystem(token, (credited * feeBps) / BPS);
        // The slippage guard is checked against what the DEPOSITOR actually
        // receives, not the pre-allocation gross — a guard that can be
        // satisfied by shares the caller never gets is not a guard.
        uint256 grossMinted = sharesOut;
        sharesOut = _mintWithAllocation(msg.sender, sharesOut);
        if (sharesOut < minSharesOut) revert SlippageExceeded();
        _requireCapNotWorsened(weightsBefore);

        // Round 9f, ported verbatim (design doc §5.4): this path also grows
        // `totalSupply`, so it also displaces stream backing proportionally.
        // `grossMinted` — not the net paid to the depositor — is the actual
        // growth in `totalSupply`, which is the quantity the derivation in
        // WrappedIndexShare.sol's header is stated in terms of. (Supply is
        // never zero here in practice — see IndexCoreFacet.mintProRata.)
        _revestOnMint(grossMinted, supplyBefore);

        emit MintedSingle(msg.sender, token, credited, sharesOut);
    }

    /**
     * @notice Convenience exit into ONE constituent. Decomposed exactly the way
     * Balancer formalises a non-proportional exit: the same pro-rata burn
     * computed VIRTUALLY, an internal swap of the other legs into the requested
     * asset at the vault's own band prices, and a Curve-style imbalance fee
     * that scales with how imbalanced the withdrawal leaves the basket.
     * @dev The fee is RETAINED IN RESERVES — never routed to a treasury, an
     * admin or a fee recipient. It accrues to the holders who stayed, which is
     * precisely whose cost the redeemer is being charged for.
     */
    function redeemSingleAsset(
        uint256 sharesIn,
        address token,
        uint256 minAmountOut
    ) external nonReentrant whenOpen returns (uint256 amountOut) {
        if (sharesIn == 0) revert ZeroAmount();
        Constituent storage target = _get(token);

        uint256 feeAmount;
        (amountOut, feeAmount) = _previewSingleExit(sharesIn, token);
        // The split comes out of `feeAmount` — the fee this exit ALREADY
        // charged — and never out of the payout. `amountOut` is computed above
        // this line and is not touched by it.
        uint256 cut = _accrueEcosystem(token, feeAmount);
        if (amountOut + cut >= target.reserve) revert ReserveWouldEmpty();
        if (amountOut < minAmountOut) revert SlippageExceeded();

        {
            (uint256 targetLo, , ) = _priceBand(token);
            // `true`: the single-asset EXIT is the one path the exit-window
            // guard applies to.
            _requirePersistenceIfLarge(token, Math.mulDiv(amountOut, targetLo, WAD), true);
        }

        uint256[] memory weightsBefore = _allWeightsBps();
        _burnShares(msg.sender, sharesIn);
        target.reserve -= amountOut + cut;
        IERC20(token).safeTransfer(msg.sender, amountOut);
        // Shrinking one leg mechanically RAISES every other leg's share of NAV,
        // which is its own way of breaching the cap — so the check covers the
        // whole basket, not just the leg the caller named.
        _requireCapNotWorsened(weightsBefore);

        emit RedeemedSingle(msg.sender, token, sharesIn, amountOut);
    }
}
