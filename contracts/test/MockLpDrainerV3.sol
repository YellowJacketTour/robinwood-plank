// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {MarketplankVaultV3} from "../MarketplankVaultV3.sol";

/**
 * AUDIT TEST-ONLY. The V3 counterpart of MockLpDrainer.
 *
 * Runs the V2 attack shape — add liquidity, trade against the pool, remove —
 * atomically in one transaction against V3's proportional LP. It must NOT
 * profit: V3 pays removal pro-rata of current reserves, so the price move the
 * attacker creates is absorbed by their own LP position.
 */
contract MockLpDrainerV3 is IERC721Receiver {
    MarketplankVaultV3 public immutable vault;

    constructor(MarketplankVaultV3 vault_) {
        vault = vault_;
    }

    receive() external payable {}

    /// Add liquidity with `ethIn` (shares pulled to match), sell `sellShares`
    /// against the price that moves, then burn all LP back out.
    function attack(uint256 ethIn, uint256 maxShares, uint256 sellAmount) external {
        (uint256 lp, ) = vault.addLiquidity{value: ethIn}(maxShares, 0);
        vault.sellShares(sellAmount, 0);
        vault.removeLiquidity(lp, 0, 0);
    }

    /// The share-side mirror: add liquidity, buy against it, remove.
    function attackBuy(uint256 ethIn, uint256 maxShares, uint256 buyEth) external {
        (uint256 lp, ) = vault.addLiquidity{value: ethIn}(maxShares, 0);
        vault.buyShares{value: buyEth}(0);
        vault.removeLiquidity(lp, 0, 0);
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

/// A treasury that rejects ETH, to prove fee accrual never bricks deposits and
/// only withdrawFees() can revert on it.
contract MockRevertingTreasury {
    receive() external payable {
        revert("no ETH");
    }
}

/// A contract that requests a random redeem but never implements
/// onERC721Received — the V3 payable-signature counterpart of MockNonReceiver.
/// Proves an undeliverable requester cannot brick the vault-wide slot.
contract MockNonReceiverV3 {
    MarketplankVaultV3 private immutable vault;

    constructor(MarketplankVaultV3 vault_) {
        vault = vault_;
    }

    function request() external payable {
        vault.requestRandomRedeem{value: msg.value}();
    }
}
