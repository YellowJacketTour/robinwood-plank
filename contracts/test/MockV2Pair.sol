// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// Faithful-enough Uniswap V2 pair for exercising PlankV2TwapOracle: it
/// tracks reserves and the two cumulative-price accumulators using the
/// SAME math the real pair's _update does (UQ112x112 encode, uint32
/// timestamp wrap), so the oracle's TWAP logic is tested against real
/// accumulator behavior, not a simplification. setReserves() stands in for
/// a swap/sync that moves the price.
contract MockV2Pair {
    address public immutable token0;
    address public immutable token1;

    uint112 private reserve0;
    uint112 private reserve1;
    uint32 public blockTimestampLast;
    uint256 public price0CumulativeLast;
    uint256 public price1CumulativeLast;

    constructor(address token0_, address token1_, uint112 reserve0_, uint112 reserve1_) {
        token0 = token0_;
        token1 = token1_;
        reserve0 = reserve0_;
        reserve1 = reserve1_;
        blockTimestampLast = uint32(block.timestamp % 2 ** 32);
    }

    function getReserves() external view returns (uint112, uint112, uint32) {
        return (reserve0, reserve1, blockTimestampLast);
    }

    /// Accrue the accumulators over the elapsed time at the OLD reserves
    /// (exactly like the real _update), then move to the new reserves.
    function setReserves(uint112 newReserve0, uint112 newReserve1) external {
        uint32 blockTimestamp = uint32(block.timestamp % 2 ** 32);
        uint32 timeElapsed;
        unchecked {
            timeElapsed = blockTimestamp - blockTimestampLast;
        }
        if (timeElapsed > 0 && reserve0 != 0 && reserve1 != 0) {
            unchecked {
                price0CumulativeLast += ((uint256(reserve1) << 112) / reserve0) * timeElapsed;
                price1CumulativeLast += ((uint256(reserve0) << 112) / reserve1) * timeElapsed;
            }
        }
        reserve0 = newReserve0;
        reserve1 = newReserve1;
        blockTimestampLast = blockTimestamp;
    }
}
