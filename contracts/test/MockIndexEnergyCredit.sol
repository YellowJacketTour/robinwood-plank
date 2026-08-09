// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @notice Test-only stand-in for `IndexEnergyFacet.creditInventory`, used to
 * drive `InventoryBuyAdapter.buyLeg` against a real contract (not an EOA —
 * an EOA target makes the try/catch'd `IIndexEnergyCredit` call's ABI-decode
 * of an empty return revert the WHOLE transaction rather than being caught,
 * a Solidity try/catch quirk unrelated to the feature under test). Just
 * records the args it was called with and returns a fixed credited amount.
 */
contract MockIndexEnergyCredit {
    address public lastToken;
    uint256 public lastMinAmount;
    uint256 public callCount;

    function creditInventory(address token, uint256 minAmount) external returns (uint256 credited) {
        lastToken = token;
        lastMinAmount = minAmount;
        callCount += 1;
        return 0;
    }
}
