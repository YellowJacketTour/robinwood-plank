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
 * @notice TEST ONLY. Writes a distinct, recognisable value into EVERY member of
 * EVERY namespace, then reads them all back.
 *
 * @dev The Layout structs are no longer empty, and that changes the risk: a
 * namespace with one member occupies one slot and cannot plausibly reach a
 * neighbour, whereas a namespace with dynamic arrays and nested mappings
 * derives slots by hashing and writes all over the address space. This facet
 * exists so the collision proof is run against the REAL, fully-populated
 * layouts rather than against placeholders.
 *
 * Each field gets a value derived from a unique tag, so a collision shows up as
 * a field reading back some OTHER field's tag rather than as a zero — which is
 * the failure mode that would otherwise pass a "is it non-zero?" check.
 */
contract NamespaceStressFacet {
    function stressWrite(uint256 tag) external {
        ERC20Storage.Layout storage e = ERC20Storage.layout();
        e.balances[address(uint160(tag + 1))] = tag + 1;
        e.allowances[address(uint160(tag + 2))][address(uint160(tag + 3))] = tag + 2;
        e.totalSupply = tag + 3;
        e.name = "n";
        e.symbol = "s";

        CoreStorage.Layout storage c = CoreStorage.layout();
        // NOT indexOpen, and NOT the three migrated immutables: those are the
        // values Diamond.noWriteToImmutables.test.ts proves nothing writes.
        c.constituentList.push(address(uint160(tag + 10)));
        c.constituents[address(uint160(tag + 11))].reserve = tag + 11;
        c.constituents[address(uint160(tag + 11))].obs[7].price = uint192(tag + 12);
        c.pendingClaim[address(uint160(tag + 13))][address(uint160(tag + 14))] = tag + 13;
        c.reservedClaims[address(uint160(tag + 15))] = tag + 15;
        c.eligibleConstituentCount = tag + 16;

        ParamsStorage.Layout storage p = ParamsStorage.layout();
        p.params.concentrationCapBps = tag + 20;
        p.params.rampDuration = tag + 21;
        p.minEligibilityFeesWei = tag + 22;
        p.minEligibilityBlocks = tag + 23;
        p.targetHhiBps = tag + 24;

        GovernanceStorage.Layout storage g = GovernanceStorage.layout();
        g.queuedParams[bytes32(tag + 30)] = GovernanceStorage.QueuedParam(tag + 30, uint64(tag + 31), true);
        g.queuedListings[address(uint160(tag + 32))] =
            GovernanceStorage.QueuedListing(address(uint160(tag + 33)), tag + 34, uint64(tag + 35), true, false);
        g.queuedPlatformTreasury = GovernanceStorage.QueuedParam(tag + 36, uint64(tag + 37), true);

        RolesStorage.Layout storage r = RolesStorage.layout();
        r.roleHolder[bytes32(tag + 40)] = address(uint160(tag + 40));
        r.queuedRoles[bytes32(tag + 41)] = RolesStorage.QueuedRole(address(uint160(tag + 41)), uint64(tag + 42), true);

        AllocationStorage.Layout storage a = AllocationStorage.layout();
        a.platformTreasury = address(uint160(tag + 50));
        a.platformAllocationBps = tag + 51;

        EcosystemStorage.Layout storage ec = EcosystemStorage.layout();
        ec.ecosystemFeesWei[address(uint160(tag + 60))] = tag + 60;
        ec.ecosystemSink = address(uint160(tag + 61));
        ec.ecosystemAsset = address(uint160(tag + 62));
        ec.ecosystemFeeSplitBps = tag + 63;

        DividendStorage.Layout storage d = DividendStorage.layout();
        d.magnifiedDividendPerShare = tag + 70;
        d.magnifiedDividendCorrections[address(uint160(tag + 71))] = -int256(tag + 71);
        d.withdrawnDividends[address(uint160(tag + 72))] = tag + 72;
        d.totalDividendsReceived = tag + 73;
        d.totalDividendsWithdrawn = tag + 74;
        d.undistributedDividends = tag + 75;

        StreamStorage.Layout storage st = StreamStorage.layout();
        st.streamList.push(address(uint160(tag + 80)));
        st.tracked[address(uint160(tag + 81))] = true;
        st.isStream[address(uint160(tag + 82))] = true;
        st.queuedStreams[address(uint160(tag + 83))] = StreamStorage.QueuedStream(uint64(tag + 83), true);
        st.carry[address(uint160(tag + 84))] = tag + 84;
        st.carryUnlockBlock = tag + 85;
        st.vest[address(uint160(tag + 86))] =
            StreamStorage.StreamVest(tag + 86, uint64(tag + 87), uint64(tag + 88));

        HooksStorage.Layout storage h = HooksStorage.layout();
        h.hooks[bytes32(tag + 90)] = address(uint160(tag + 90));
        h.hookPermissions[address(uint160(tag + 91))] = uint16(tag % 65_535);

        ReentrancyStorage.layout().status = tag + 100;
    }

    /// @notice Read every written field back. A collision anywhere shows up as
    /// one of these returning a value that belongs to a different field.
    function stressRead(uint256 tag) external view returns (uint256[32] memory v) {
        ERC20Storage.Layout storage e = ERC20Storage.layout();
        v[0] = e.balances[address(uint160(tag + 1))];
        v[1] = e.allowances[address(uint160(tag + 2))][address(uint160(tag + 3))];
        v[2] = e.totalSupply;

        CoreStorage.Layout storage c = CoreStorage.layout();
        v[3] = uint256(uint160(c.constituentList[c.constituentList.length - 1]));
        v[4] = c.constituents[address(uint160(tag + 11))].reserve;
        v[5] = c.constituents[address(uint160(tag + 11))].obs[7].price;
        v[6] = c.pendingClaim[address(uint160(tag + 13))][address(uint160(tag + 14))];
        v[7] = c.reservedClaims[address(uint160(tag + 15))];
        v[8] = c.eligibleConstituentCount;

        ParamsStorage.Layout storage p = ParamsStorage.layout();
        v[9] = p.params.concentrationCapBps;
        v[10] = p.params.rampDuration;
        v[11] = p.minEligibilityFeesWei;
        v[12] = p.minEligibilityBlocks;
        v[13] = p.targetHhiBps;

        GovernanceStorage.Layout storage g = GovernanceStorage.layout();
        v[14] = g.queuedParams[bytes32(tag + 30)].value;
        v[15] = g.queuedListings[address(uint160(tag + 32))].rawTargetWeightBps;
        v[16] = g.queuedPlatformTreasury.value;

        RolesStorage.Layout storage r = RolesStorage.layout();
        v[17] = uint256(uint160(r.roleHolder[bytes32(tag + 40)]));
        v[18] = uint256(uint160(r.queuedRoles[bytes32(tag + 41)].holder));

        AllocationStorage.Layout storage a = AllocationStorage.layout();
        v[19] = uint256(uint160(a.platformTreasury));
        v[20] = a.platformAllocationBps;

        EcosystemStorage.Layout storage ec = EcosystemStorage.layout();
        v[21] = ec.ecosystemFeesWei[address(uint160(tag + 60))];
        v[22] = uint256(uint160(ec.ecosystemSink));
        v[23] = ec.ecosystemFeeSplitBps;

        DividendStorage.Layout storage d = DividendStorage.layout();
        v[24] = d.magnifiedDividendPerShare;
        v[25] = uint256(-d.magnifiedDividendCorrections[address(uint160(tag + 71))]);
        v[26] = d.totalDividendsReceived;
        v[27] = d.undistributedDividends;

        StreamStorage.Layout storage st = StreamStorage.layout();
        v[28] = uint256(uint160(st.streamList[st.streamList.length - 1]));
        v[29] = st.carry[address(uint160(tag + 84))];
        v[30] = st.vest[address(uint160(tag + 86))].unvested;

        v[31] = uint256(uint160(HooksStorage.layout().hooks[bytes32(tag + 90)]));
    }

    /// @notice The migrated immutables and the open latch, so a stress write can
    /// be shown not to have disturbed them.
    function stressCoreInvariants() external view returns (uint256, address, address, bool) {
        CoreStorage.Layout storage c = CoreStorage.layout();
        return (c.timelockDelay, c.seeder, c.dividendAsset, c.indexOpen);
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
