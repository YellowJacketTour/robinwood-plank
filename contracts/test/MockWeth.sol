// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Test-only mock of the WETH offer currency — mints freely.
/// Never deployed anywhere real; exists solely for SeaportCriteriaFulfill.test.ts.
contract MockWeth is ERC20 {
    constructor() ERC20("Mock WETH", "mWETH") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
