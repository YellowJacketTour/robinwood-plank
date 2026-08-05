// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @notice RED-TEAM test-only constituent token modelling a USDC-shaped issuer
 * blacklist: a perfectly normal ERC-20 that reverts on transfer to (or from) a
 * specific address, at the issuer's sole discretion, at any time after listing.
 *
 * This is not an exotic token. It is the single most widely-held stablecoin
 * design in production. LOCAL HARDHAT ONLY.
 */
contract MockBlacklistIndexToken is ERC20 {
    mapping(address => bool) public blocked;

    constructor(string memory n, string memory s) ERC20(n, s) {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    /// @notice The issuer freezes an address. No permission needed here — the
    /// point is that the index vault has no say in it whatsoever.
    function setBlocked(address who, bool v) external {
        blocked[who] = v;
    }

    function _transfer(address from, address to, uint256 amount) internal override {
        require(!blocked[from] && !blocked[to], "Blacklistable: account is blocked");
        super._transfer(from, to, amount);
    }
}
