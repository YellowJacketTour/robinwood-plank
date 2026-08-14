// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

interface IUniswapV2Pair {
    function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast);
    function price0CumulativeLast() external view returns (uint256);
    function price1CumulativeLast() external view returns (uint256);
    function token0() external view returns (address);
    function token1() external view returns (address);
}

/**
 * PlankV2TwapOracle -- a manipulation-resistant time-weighted average
 * price (TWAP) over a canonical Uniswap V2 pair, used by PlankBurnEngine
 * to enforce a FAIR minimum output on every buyback so no caller can
 * force the community's ETH to buy $PLANK at a rigged (e.g. sandwiched)
 * rate.
 *
 * WHY A TWAP AND NOT SPOT: the whole attack this defends against is a
 * momentary price move -- a sandwich front-runs the burn to push the pool
 * price against it, then back-runs to profit. Spot reserves are moved by
 * that single-block manipulation, so a spot-price floor can be gamed. A
 * TWAP is the AVERAGE price over a window (e.g. 30 min); one block of
 * manipulation barely moves it, and holding the pool off-market for a
 * meaningful fraction of the window costs real capital and is arbitraged
 * away. This is the exact "price checker" pattern CoW Protocol's Milkman
 * uses for trustless DAO treasury swaps.
 *
 * THIS IS THE CANONICAL, WELL-TROD UNISWAP V2 FIXED-WINDOW ORACLE (the
 * ExampleOracleSimple / UniswapV2OracleLibrary design), ported to 0.8 with
 * explicit unchecked arithmetic where the V2 accumulators are DESIGNED to
 * overflow (that overflow is load-bearing, not a bug -- the cumulative
 * price and the uint32 timestamp both wrap, and the subtraction of two
 * snapshots is correct modulo 2**256 / 2**32 respectively).
 *
 * LIVENESS: update() must be called at least once per window to keep a
 * fresh average available; consult() reverts if the oracle was never
 * primed or has gone stale. The casino keeper calls update() in its loop.
 */
contract PlankV2TwapOracle {
    IUniswapV2Pair public immutable pair;
    address public immutable token0;
    address public immutable token1;
    /// The averaging window. A new average is only produced once at least
    /// this much time has elapsed since the last observation, so the
    /// reported price is genuinely averaged over >= windowSize seconds.
    uint256 public immutable windowSize;
    /// consult() reverts if the last update is older than this, so a burn
    /// can never price against a stale average. Must be >= windowSize.
    uint256 public immutable maxStaleness;

    // Last observation.
    uint256 public price0CumulativeLast;
    uint256 public price1CumulativeLast;
    uint32 public blockTimestampLast;
    // Time-averaged prices as UQ112x112 (token1-per-token0 and
    // token0-per-token1). Zero until the first update() a full window
    // after deployment.
    uint224 public price0Average;
    uint224 public price1Average;
    uint256 public lastUpdate;

    error BadConfig();
    error PeriodNotElapsed();
    error NotInitialized();
    error StaleOracle();
    error UnknownToken();
    error NoReserves();

    constructor(address pair_, uint256 windowSize_, uint256 maxStaleness_) {
        if (pair_ == address(0) || windowSize_ == 0 || maxStaleness_ < windowSize_) revert BadConfig();
        IUniswapV2Pair p = IUniswapV2Pair(pair_);
        pair = p;
        token0 = p.token0();
        token1 = p.token1();
        windowSize = windowSize_;
        maxStaleness = maxStaleness_;

        // Prime the first observation from the pair's live accumulators.
        (uint256 p0, uint256 p1, uint32 ts) = _currentCumulativePrices();
        price0CumulativeLast = p0;
        price1CumulativeLast = p1;
        blockTimestampLast = ts;
        // price{0,1}Average stay 0 until the first update() >= windowSize
        // later; consult() reverts NotInitialized until then.
    }

    /// Permissionless. Records a new observation and, if a full window has
    /// elapsed since the last one, updates the time-averaged price. Anyone
    /// may call it; there is no privilege and no way to bias the result --
    /// the numbers come entirely from the pair's own accumulators.
    function update() external {
        (uint256 p0, uint256 p1, uint32 ts) = _currentCumulativePrices();
        uint32 timeElapsed;
        unchecked {
            // uint32 subtraction wraps by design (matches Uniswap V2).
            timeElapsed = ts - blockTimestampLast;
        }
        if (timeElapsed < windowSize) revert PeriodNotElapsed();

        unchecked {
            // Cumulative-price subtraction is correct modulo 2**256 even
            // across the accumulator's intended overflow.
            price0Average = uint224((p0 - price0CumulativeLast) / timeElapsed);
            price1Average = uint224((p1 - price1CumulativeLast) / timeElapsed);
        }
        price0CumulativeLast = p0;
        price1CumulativeLast = p1;
        blockTimestampLast = ts;
        lastUpdate = block.timestamp;
    }

    /// The fair (time-averaged) amount of the OTHER token you should
    /// receive for `amountIn` of `tokenIn`, priced over the last window.
    /// Reverts if the oracle was never primed or has gone stale, so a
    /// consumer can never accidentally price against no data or old data.
    function consult(address tokenIn, uint256 amountIn) external view returns (uint256 amountOut) {
        if (lastUpdate == 0) revert NotInitialized();
        if (block.timestamp - lastUpdate > maxStaleness) revert StaleOracle();
        if (tokenIn == token0) {
            amountOut = _decodeMul(price0Average, amountIn); // token1 out
        } else if (tokenIn == token1) {
            amountOut = _decodeMul(price1Average, amountIn); // token0 out
        } else {
            revert UnknownToken();
        }
    }

    /// amountOut = averagePrice (UQ112x112) * amountIn, decoded from fixed
    /// point (>> 112). averagePrice <= 2**224 and amountIn is a realistic
    /// token amount, so the intermediate cannot overflow uint256 for any
    /// sane input; a pathological amountIn that would overflow simply
    /// reverts, which is safe (the burn just can't run at that size).
    function _decodeMul(uint224 averagePrice, uint256 amountIn) private pure returns (uint256) {
        return (uint256(averagePrice) * amountIn) >> 112;
    }

    /// Reads the pair's cumulative prices, extrapolated to the current
    /// block if the pair hasn't been touched this block -- the standard
    /// UniswapV2OracleLibrary.currentCumulativePrices logic.
    function _currentCumulativePrices() private view returns (uint256 p0Cum, uint256 p1Cum, uint32 blockTimestamp) {
        blockTimestamp = uint32(block.timestamp % 2 ** 32);
        p0Cum = pair.price0CumulativeLast();
        p1Cum = pair.price1CumulativeLast();
        (uint112 reserve0, uint112 reserve1, uint32 tsLast) = pair.getReserves();
        if (reserve0 == 0 || reserve1 == 0) revert NoReserves();
        if (tsLast != blockTimestamp) {
            uint32 timeElapsed;
            unchecked {
                timeElapsed = blockTimestamp - tsLast;
            }
            // Extrapolate: cumulative += instantaneous UQ112x112 price * dt.
            unchecked {
                p0Cum += uint256(_fraction(reserve1, reserve0)) * timeElapsed;
                p1Cum += uint256(_fraction(reserve0, reserve1)) * timeElapsed;
            }
        }
    }

    /// UQ112x112 fraction numerator/denominator = (numerator << 112) /
    /// denominator. Reserves are uint112, so numerator << 112 < 2**224 --
    /// no overflow.
    function _fraction(uint112 numerator, uint112 denominator) private pure returns (uint224) {
        return uint224((uint256(numerator) << 112) / denominator);
    }
}
