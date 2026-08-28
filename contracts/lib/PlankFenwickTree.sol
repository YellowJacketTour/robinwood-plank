// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @notice Bounded prefix-sum accumulator for objective crash settlement.
/// @dev Indices are zero-based externally and one-based internally.
library PlankFenwickTree {
    error AlreadyInitialized();
    error Uninitialized();
    error IndexOutOfRange();
    error TreeUnderflow();

    struct Tree {
        uint32 size;
        mapping(uint256 => uint256) nodes;
    }

    function initialize(Tree storage self, uint32 size_) internal {
        if (self.size != 0) revert AlreadyInitialized();
        if (size_ == 0) revert IndexOutOfRange();
        self.size = size_;
    }

    function add(Tree storage self, uint32 index, uint256 amount) internal {
        uint256 size_ = self.size;
        if (size_ == 0) revert Uninitialized();
        if (index >= size_) revert IndexOutOfRange();
        uint256 cursor = uint256(index) + 1;
        while (cursor <= size_) {
            self.nodes[cursor] += amount;
            cursor += cursor & (~cursor + 1); // cursor += lowbit(cursor)
        }
    }

    function subtract(Tree storage self, uint32 index, uint256 amount) internal {
        uint256 size_ = self.size;
        if (size_ == 0) revert Uninitialized();
        if (index >= size_) revert IndexOutOfRange();
        uint256 cursor = uint256(index) + 1;
        while (cursor <= size_) {
            uint256 value = self.nodes[cursor];
            if (value < amount) revert TreeUnderflow();
            self.nodes[cursor] = value - amount;
            cursor += cursor & (~cursor + 1);
        }
    }

    /// @notice Inclusive prefix sum through zero-based `index`.
    function prefix(Tree storage self, uint32 index) internal view returns (uint256 sum) {
        uint256 size_ = self.size;
        if (size_ == 0) revert Uninitialized();
        if (index >= size_) revert IndexOutOfRange();
        uint256 cursor = uint256(index) + 1;
        while (cursor != 0) {
            sum += self.nodes[cursor];
            cursor -= cursor & (~cursor + 1);
        }
    }

    function at(Tree storage self, uint32 index) internal view returns (uint256) {
        uint256 through = prefix(self, index);
        if (index == 0) return through;
        return through - prefix(self, index - 1);
    }
}
