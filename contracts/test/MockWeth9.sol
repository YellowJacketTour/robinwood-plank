// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Test-only mock of the REAL WETH9 contract shape (deposit/withdraw,
/// not just a mintable ERC20 like MockWeth.sol) -- needed to test
/// MarketplankAcrossReceiver's real unwrap path, which calls withdraw(uint256)
/// exactly as it would against the real wrapped-native-token contract on any
/// chain Across delivers to. Never deployed anywhere real.
contract MockWeth9 is ERC20 {
    constructor() ERC20("Mock WETH9", "mWETH9") {}

    function deposit() external payable {
        _mint(msg.sender, msg.value);
    }

    function withdraw(uint256 amount) external {
        _burn(msg.sender, amount);
        (bool ok, ) = msg.sender.call{value: amount}("");
        require(ok, "withdraw transfer failed");
    }

    receive() external payable {
        _mint(msg.sender, msg.value);
    }
}
