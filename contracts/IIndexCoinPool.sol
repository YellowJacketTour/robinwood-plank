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

    /// @notice §7.7: the buyback's ONE spend path — the identical permissionless
    /// swap any other trader on this pool uses, never a second, favorable
    /// pricing route.
    function swap(
        bool paymentIn,
        uint256 amountIn,
        uint256 minAmountOut,
        address to
    ) external returns (uint256 amountOut);

    function paymentToken() external view returns (address);

    function indexCoin() external view returns (address);
}
