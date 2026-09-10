// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @notice Exact target-indexed clearing for stakes divisible by 10,000 wei.
/// A Fenwick index stores stake units and full-X liabilities. Cost depends on
/// the bounded target domain, not the number of positions. No off-chain root
/// or trusted clearing operator is involved.
library PlankStakeIndex {
    uint256 internal constant MAX_TARGET = 100_000_000;
    uint256 internal constant QUANTUM = 10_000;
    struct Node { uint128 units; uint128 caps; }
    struct Index { mapping(uint256 => Node) nodes; }
    struct Clearing {
        uint256 crash;
        uint256 capThrough;
        uint256 survivorUnits;
        uint256 numerator;
        uint256 denominator;
        uint256 allocated;
    }
    error InvalidIndexInput();
    function insert(Index storage self, uint256 target, uint256 units) internal {
        if(target < 10100 || target > MAX_TARGET || units == 0 || units > 1e29) revert InvalidIndexInput();
        uint256 caps = units * target;
        for(uint256 i = target; i <= MAX_TARGET; i += i & (~i + 1)) {
            Node storage node = self.nodes[i];
            // The integrating contract bounds TOTAL units to 1e29, so both
            // packed accumulators fit uint128, including units * 1e8.
            uint256 nextUnits = uint256(node.units) + units;
            uint256 nextCaps = uint256(node.caps) + caps;
            if(nextUnits > 1e29 || nextCaps > 1e37) revert InvalidIndexInput();
            node.units = uint128(nextUnits); node.caps = uint128(nextCaps);
        }
    }
    function prefix(Index storage self, uint256 target) internal view returns(uint256 units, uint256 caps) {
        if(target > MAX_TARGET) revert InvalidIndexInput();
        for(uint256 i = target; i != 0; i -= i & (~i + 1)) {
            Node storage node = self.nodes[i]; units += node.units; caps += node.caps;
        }
    }
    function clear(Index storage self, uint256 budget, uint256 crash, uint256 floorBps)
        internal view returns(Clearing memory c)
    {
        if(crash < 10000 || crash > MAX_TARGET || floorBps > 10000 || budget > 2e33) revert InvalidIndexInput();
        c.crash = crash;
        uint256 caps;
        (c.survivorUnits, caps) = prefix(self, crash);
        if(budget < c.survivorUnits * floorBps) revert InvalidIndexInput();
        if(budget >= caps) { c.capThrough = crash; c.allocated = caps; return c; }
        // Highest integer clearing multiplier whose cost fits. At most 27
        // prefix queries, each at most 26 packed storage reads.
        uint256 low = floorBps; uint256 high = crash;
        while(low < high) {
            uint256 mid = (low + high + 1) / 2;
            (uint256 u, uint256 p) = prefix(self, mid);
            if(p + mid * (c.survivorUnits - u) <= budget) low = mid;
            else high = mid - 1;
        }
        (uint256 cappedUnits, uint256 cappedWei) = prefix(self, low);
        c.capThrough = low; c.numerator = budget - cappedWei;
        c.denominator = c.survivorUnits - cappedUnits; c.allocated = budget;
    }
    function payout(Clearing memory c, uint256 stake, uint256 target) internal pure returns(uint256) {
        if(stake == 0 || target > c.crash) return 0;
        uint256 units = stake / QUANTUM;
        if(target <= c.capThrough) return units * target;
        return units * c.numerator / c.denominator;
    }
}
