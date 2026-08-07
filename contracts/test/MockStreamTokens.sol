// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @notice Test-only stand-in for a REAL-WORLD-ASSET token whose issuer
 * enforces transfer restrictions nobody in this repo controls — a KYC
 * allowlist, a jurisdiction block, a USDC-shaped blacklist.
 *
 * `setBlocked(who, true)` makes every transfer TO that address revert, which
 * is the exact failure `WrappedIndexShare.withdraw` must survive without
 * trapping the withdrawer's OTHER, unrestricted assets.
 */
contract MockRestrictedToken is ERC20 {
    mapping(address => bool) public blocked;

    constructor(string memory n, string memory s) ERC20(n, s) {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setBlocked(address who, bool v) external {
        blocked[who] = v;
    }

    function _transfer(address from, address to, uint256 amount) internal override {
        require(!blocked[to], "RWA: recipient not permitted");
        super._transfer(from, to, amount);
    }
}

/**
 * @notice Test-only maximally hostile stream token. Independently switchable:
 * revert on `transfer`, revert on `balanceOf`, return `false` from `transfer`
 * instead of reverting, or burn unbounded gas in either. Everything a listed
 * stream could turn into after it was listed.
 */
contract MockHostileStream is ERC20 {
    bool public revertTransfer;
    bool public revertBalance;
    bool public lieOnTransfer;
    bool public burnGas;
    /// @notice Accept a `transferFrom` and move nothing — the pathological
    /// inbound case `depositStream`'s measured-delta credit must catch.
    bool public swallowFrom;

    constructor(string memory n, string memory s) ERC20(n, s) {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setModes(bool rt, bool rb, bool lie, bool gas_) external {
        revertTransfer = rt;
        revertBalance = rb;
        lieOnTransfer = lie;
        burnGas = gas_;
    }

    function setSwallowFrom(bool v) external {
        swallowFrom = v;
    }

    function transferFrom(address from, address to, uint256 amount)
        public
        override
        returns (bool)
    {
        if (swallowFrom) return true;
        return super.transferFrom(from, to, amount);
    }

    function _burn9() private view {
        // Consume everything the caller was willing to forward.
        uint256 x = 1;
        while (gasleft() > 5_000) {
            x = uint256(keccak256(abi.encode(x)));
        }
    }

    function balanceOf(address who) public view override returns (uint256) {
        if (burnGas) _burn9();
        require(!revertBalance, "hostile: balanceOf");
        return super.balanceOf(who);
    }

    function transfer(address to, uint256 amount) public override returns (bool) {
        if (burnGas) _burn9();
        require(!revertTransfer, "hostile: transfer");
        if (lieOnTransfer) return false;
        return super.transfer(to, amount);
    }
}
