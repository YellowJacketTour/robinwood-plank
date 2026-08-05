// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IEligibilitySource} from "../IEligibilitySource.sol";

/**
 * @notice Test-only constituent that DOES implement IEligibilitySource, so the
 * fee/time eligibility bar can be driven from both sides in a test. Wears the
 * same ERC-20 surface MockIndexToken does, so it can be listed as a real
 * constituent. Never deployed anywhere real.
 */
contract MockEligibilitySource is ERC20, IEligibilitySource {
    uint256 public totalFeesCollectedWei;
    uint256 public firstActivityBlock;

    constructor(string memory n, string memory s) ERC20(n, s) {
        firstActivityBlock = block.number;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setFees(uint256 feesWei) external {
        totalFeesCollectedWei = feesWei;
    }

    function setFirstActivityBlock(uint256 b) external {
        firstActivityBlock = b;
    }
}

/**
 * @notice A constituent whose eligibility getters REVERT. Proves the vault's
 * read fails closed (not eligible) rather than propagating the revert.
 */
contract RevertingEligibilitySource is ERC20 {
    constructor() ERC20("rev", "rev") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function totalFeesCollectedWei() external pure returns (uint256) {
        revert("nope");
    }

    function firstActivityBlock() external pure returns (uint256) {
        revert("nope");
    }
}

/**
 * @notice A constituent whose eligibility getter burns unbounded gas. Proves
 * the vault's gas-capped staticcall cannot be griefed into an out-of-gas by a
 * hostile constituent during a whole-basket eligibility recount.
 */
contract GasBombEligibilitySource is ERC20 {
    uint256 private sink;

    constructor() ERC20("bomb", "bomb") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function totalFeesCollectedWei() external view returns (uint256) {
        uint256 acc = sink;
        // Deliberately unbounded relative to the vault's 50k gas cap.
        for (uint256 i = 0; i < 100_000; i++) acc = acc + i;
        return acc;
    }

    function firstActivityBlock() external pure returns (uint256) {
        return 1;
    }
}
