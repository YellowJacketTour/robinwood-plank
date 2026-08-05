// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @notice Test-only WETH9-shaped wrapper, so IndexDividendDistributor's
 * auto-compound path can be driven end to end against a real payable
 * `deposit()`. Same "mint freely, never deployed anywhere real" pattern as
 * MockWeth.sol — this one just adds the wrap/unwrap surface MockWeth lacks.
 */
contract MockWrappedEth is ERC20 {
    constructor() ERC20("Wrapped Ether", "WETH") {}

    function deposit() external payable {
        _mint(msg.sender, msg.value);
    }

    function withdraw(uint256 amount) external {
        _burn(msg.sender, amount);
        (bool ok, ) = payable(msg.sender).call{value: amount}("");
        require(ok, "eth");
    }

    /// @dev Test convenience so a wrapped-ETH constituent can be seeded
    /// without the seeder having to hold the ETH first.
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
