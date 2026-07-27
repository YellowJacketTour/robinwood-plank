// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {MarketplankVault} from "../MarketplankVault.sol";

/**
 * Test-only. Models the exact attack the commit-reveal split exists to stop:
 * a contract that tries to draw a random NFT and act on the result inside a
 * single transaction, so it could revert and reroll until it hit a rare one.
 * Both calls in one tx must be impossible.
 */
contract MockRerollAttacker is IERC721Receiver {
    MarketplankVault public immutable vault;

    constructor(MarketplankVault vault_) {
        vault = vault_;
    }

    /// @dev Must revert — the committed block has no hash yet.
    function commitAndClaimSameTx() external {
        vault.requestRandomRedeem();
        vault.claimRandomRedeem();
    }

    function commit() external {
        vault.requestRandomRedeem();
    }

    function claim() external {
        vault.claimRandomRedeem();
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
