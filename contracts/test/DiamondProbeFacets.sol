// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {
    CoreStorage,
    ERC20Storage,
    ParamsStorage,
    GovernanceStorage,
    RolesStorage,
    AllocationStorage,
    EcosystemStorage,
    DividendStorage,
    StreamStorage,
    HooksStorage,
    ReentrancyStorage,
    DiamondStorage
} from "../diamond/storage/IndexStorage.sol";

/**
 * ============================================================================
 *  TEST ONLY. Two independent facets that read the SAME namespaces.
 *
 *  These exist to prove the property that has no analogue in the pre-diamond
 *  design and therefore no existing test: that two separately-compiled facets,
 *  each with its own bytecode and its own `immutable` region, agree byte for
 *  byte about the diamond's storage.
 *
 *  Design doc section 12 item 1 names this the highest-probability silent bug in
 *  the whole conversion. The failure it guards against is subtle and quiet: an
 *  `immutable` under DELEGATECALL resolves to the value baked into whichever
 *  FACET is executing, so had `timelockDelay` been left `immutable`, ProbeA and
 *  ProbeB would each have returned their own constructor's value and the
 *  governance timelock would have had two different lengths depending on which
 *  facet you asked. The two facets below carry DELIBERATELY DIFFERENT
 *  `immutable` values so that a regression to that shape fails loudly instead
 *  of accidentally agreeing.
 * ============================================================================
 */

contract CoreProbeFacetA {
    /// @dev Deliberately different from ProbeB's. If any value that must be
    /// diamond-wide is ever read from an `immutable` again, these disagree.
    uint256 internal immutable facetLocalMarker = 0xAAAA;

    function probeA_timelockDelay() external view returns (uint256) {
        return CoreStorage.layout().timelockDelay;
    }

    function probeA_seeder() external view returns (address) {
        return CoreStorage.layout().seeder;
    }

    function probeA_dividendAsset() external view returns (address) {
        return CoreStorage.layout().dividendAsset;
    }

    function probeA_indexOpen() external view returns (bool) {
        return CoreStorage.layout().indexOpen;
    }

    function probeA_marker() external view returns (uint256) {
        return facetLocalMarker;
    }

    /// @notice Write into three namespaces at once, so ProbeB can be asked
    /// whether it sees exactly these values and nothing bled sideways.
    function probeA_write(uint256 supply, bytes32 role, address holder, uint256 reentrancy) external {
        ERC20Storage.layout().totalSupply = supply;
        RolesStorage.layout().roleHolder[role] = holder;
        ReentrancyStorage.layout().status = reentrancy;
    }
}

contract CoreProbeFacetB {
    uint256 internal immutable facetLocalMarker = 0xBBBB;

    function probeB_timelockDelay() external view returns (uint256) {
        return CoreStorage.layout().timelockDelay;
    }

    function probeB_seeder() external view returns (address) {
        return CoreStorage.layout().seeder;
    }

    function probeB_dividendAsset() external view returns (address) {
        return CoreStorage.layout().dividendAsset;
    }

    function probeB_marker() external view returns (uint256) {
        return facetLocalMarker;
    }

    function probeB_totalSupply() external view returns (uint256) {
        return ERC20Storage.layout().totalSupply;
    }

    function probeB_roleHolder(bytes32 role) external view returns (address) {
        return RolesStorage.layout().roleHolder[role];
    }

    function probeB_reentrancy() external view returns (uint256) {
        return ReentrancyStorage.layout().status;
    }

    /// @notice Read the diamond's own selector table through a namespace
    /// accessor, so a test can confirm that writing every OTHER namespace left
    /// the routing table untouched — the collision that would brick the
    /// diamond outright.
    function probeB_facetCount() external view returns (uint256) {
        return DiamondStorage.layout().facetAddresses.length;
    }

    function probeB_finalized() external view returns (bool) {
        return DiamondStorage.layout().finalized;
    }

    /// @notice Raw slot read, so a test can assert a namespace root holds what
    /// the Layout says it holds and that neighbouring roots are untouched.
    function probeB_rawSlot(bytes32 slot) external view returns (bytes32 v) {
        assembly {
            v := sload(slot)
        }
    }
}

/**
 * @notice Every namespace root, as the CONTRACT computes it.
 *
 * @dev The distinctness test reads the roots from HERE rather than
 * re-deriving them in TypeScript. A TypeScript re-derivation would be a
 * second implementation of the ERC-7201 formula, and the failure mode that
 * matters — two namespaces that actually collide on-chain — is exactly the
 * one a matching pair of independent bugs would hide.
 *
 * If a namespace is ever added to IndexStorage.sol and not added here, the
 * count assertion in Diamond.storage.test.ts fails.
 */
contract StorageSlotProbe {
    function names() external pure returns (string[13] memory n) {
        n[0] = "diamond";
        n[1] = "erc20";
        n[2] = "core";
        n[3] = "params";
        n[4] = "governance";
        n[5] = "roles";
        n[6] = "allocation";
        n[7] = "ecosystem";
        n[8] = "dividend";
        n[9] = "stream";
        n[10] = "hooks";
        n[11] = "reentrancy";
        // Slot 0 of the diamond, included on purpose: it is not a namespace,
        // it is the thing every namespace must stay away from. A facet that
        // declares a state variable lands here.
        n[12] = "SLOT_ZERO(not a namespace)";
    }

    function slots() external pure returns (bytes32[13] memory s) {
        s[0] = DiamondStorage.SLOT;
        s[1] = ERC20Storage.SLOT;
        s[2] = CoreStorage.SLOT;
        s[3] = ParamsStorage.SLOT;
        s[4] = GovernanceStorage.SLOT;
        s[5] = RolesStorage.SLOT;
        s[6] = AllocationStorage.SLOT;
        s[7] = EcosystemStorage.SLOT;
        s[8] = DividendStorage.SLOT;
        s[9] = StreamStorage.SLOT;
        s[10] = HooksStorage.SLOT;
        s[11] = ReentrancyStorage.SLOT;
        s[12] = bytes32(0);
    }
}
