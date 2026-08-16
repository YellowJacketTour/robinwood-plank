// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// Minimal ERC20Burnable stand-in matching the real $PLANK token's real
/// interface (balanceOf + burn) -- just enough for PlankBurnEngine.test.ts
/// to exercise the swap-and-burn flow without needing a full ERC20.
contract MockERC20Burnable {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    uint256 public totalSupply;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        totalSupply += amount;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function burn(uint256 amount) external {
        balanceOf[msg.sender] -= amount;
        totalSupply -= amount;
    }

    /// Matches real OZ ERC20Burnable.burnFrom semantics: spend the caller's
    /// allowance from `account`, then burn from `account`'s balance.
    function burnFrom(address account, uint256 amount) external {
        allowance[account][msg.sender] -= amount;
        balanceOf[account] -= amount;
        totalSupply -= amount;
    }
}
