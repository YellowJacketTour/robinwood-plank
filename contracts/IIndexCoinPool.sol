// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @notice Minimal read/write surface `IndexFacetBase`/`IndexPoolFacet` need
 * against `IndexCoinPool`, kept as an INTERFACE (not an import of the
 * contract itself) so the pool's own bytecode never gets pulled into a
 * facet's compiled output.
 */
interface IIndexCoinPool {
    function getReserves() external view returns (uint256 reservePayment, uint256 reserveCoin);

    function lastActionBlock() external view returns (uint256);

    function deploy(uint256 minPaymentIn, uint256 minCoinIn) external returns (uint256 paymentIn, uint256 coinIn);

    function paymentToken() external view returns (address);

    function indexCoin() external view returns (address);
}
