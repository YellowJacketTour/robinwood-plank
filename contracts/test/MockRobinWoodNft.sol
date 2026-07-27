// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";

/// @notice Test-only mock of the RobinWood NFT contract — mints freely, no sale logic.
/// Never deployed anywhere real; exists solely for MarketplankVault.test.ts.
contract MockRobinWoodNft is ERC721 {
    constructor() ERC721("Mock RobinWood", "mROBIN") {}

    function mint(address to, uint256 tokenId) external {
        _mint(to, tokenId);
    }
}
