// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC721Enumerable} from "@openzeppelin/contracts/token/ERC721/extensions/ERC721Enumerable.sol";
import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";

/// @notice LOCAL-DEV-ONLY mock of the RobinWood NFT. Identical to
/// MockRobinWoodNft but ERC721Enumerable, so the frontend's on-chain inventory
/// walk (tokenOfOwnerByIndex) can list what a wallet — and the vault — holds
/// without an indexer. Never deployed anywhere real. The unit-test suites keep
/// using the plain MockRobinWoodNft; this exists purely for scripts/local-v3-setup.
contract MockRobinWoodNftEnumerable is ERC721Enumerable {
    constructor() ERC721("Mock RobinWood", "mROBIN") {}

    function mint(address to, uint256 tokenId) external {
        _mint(to, tokenId);
    }
}
