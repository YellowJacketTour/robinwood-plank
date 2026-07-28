// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * TEST ONLY. Never deploy.
 *
 * A contract that holds vault shares and requests a random redemption but
 * deliberately does NOT implement onERC721Received. Stands in for two real
 * populations at once:
 *   - a malicious requester who wants to brick the vault-wide single-request
 *     slot for the price of one share, and
 *   - an ordinary smart-contract wallet that simply never implemented the
 *     ERC-721 receiver hook, which reaches the identical state by accident.
 */
interface IVaultLike {
    function requestRandomRedeem() external;
    function claimRandomRedeem() external returns (uint256);
}

contract MockNonReceiver {
    IVaultLike private immutable vault;

    constructor(address vault_) {
        vault = IVaultLike(vault_);
    }

    function request() external {
        vault.requestRandomRedeem();
    }

    function claim() external returns (uint256) {
        return vault.claimRandomRedeem();
    }
}
