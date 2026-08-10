// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {DividendVestStorage} from "../diamond/storage/IndexDividendVestStorage.sol";

/**
 * TEST ONLY. Never deploy, never cut into the diamond.
 *
 * Drives `DividendVestStorage` through EXACTLY the call sequence
 * `IndexFacetBase._creditRoutedValue` and `IndexDividendFacet.dripDividends`
 * will make against it, so the vest arithmetic that closes audit H-2/H-3 is
 * proven on its own terms rather than inferred from the facet that will use
 * it.
 *
 * WHY A HARNESS AND NOT AN END-TO-END SNIPE TEST: the crediting site
 * (`_creditRoutedValue`) lives in `IndexFacetBase`, which is owned by another
 * workstream in this change set. The end-to-end regression belongs with that
 * edit and is specified alongside it. What is provable HERE, and what this
 * harness proves, is the property the whole fix rests on: value credited in
 * block N is releasable in EXACTLY ZERO amount in block N. If that is true,
 * the atomic mint->credit->redeem->claim sequence captures nothing, because
 * every step of it happens in one block.
 */
contract DividendVestHarness {
    uint256 public lastTaken;

    function add(uint256 amount, uint256 vestBlocks) external {
        DividendVestStorage.add(amount, vestBlocks);
    }

    /// @dev The atomic attack, in one transaction: credit, then immediately
    /// try to draw the credit back out. Returns what the attacker got.
    function addAndTakeSameBlock(uint256 amount, uint256 vestBlocks)
        external
        returns (uint256 taken)
    {
        DividendVestStorage.add(amount, vestBlocks);
        taken = DividendVestStorage.take();
        lastTaken = taken;
    }

    function take() external returns (uint256 taken) {
        taken = DividendVestStorage.take();
        lastTaken = taken;
    }

    function pending() external view returns (uint256) {
        return DividendVestStorage.pending();
    }

    function releasable() external view returns (uint256) {
        return DividendVestStorage.releasable();
    }
}
