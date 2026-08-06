// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {DiamondStorage, CoreStorage, ReentrancyStorage} from "./storage/IndexStorage.sol";

/**
 * ============================================================================
 *  Diamond — the EIP-2535 proxy for the Global Index Vault.
 *
 *  NOT FOR DEPLOYMENT except through IndexDeployer. Deploying this directly
 *  gives you a diamond with exactly one facet (the cut facet) and a cutter that
 *  is whoever passed the constructor argument — which is a cuttable diamond,
 *  i.e. the thing design doc section 6 exists to make unobservable. IndexDeployer's
 *  constructor is the only supported path, because it is the only path in which
 *  the cut capability is created and destroyed inside one transaction.
 *
 *  WHAT IS DELIBERATELY ABSENT
 *  ---------------------------
 *  There is NO `receive()` and NO payable fallback. The vault "cannot hold ETH
 *  at all" is a property asserted twice in the existing suite, and under a
 *  diamond it has to be asserted against THIS contract's fallback rather than
 *  against any facet's ABI — a facet could be payable and it would not matter,
 *  because value can never reach it: a non-payable fallback rejects the call
 *  before dispatch. Diamond.fallback.test.ts pins that.
 *
 *  There is also no owner, no admin, no `upgradeTo`, no implementation setter,
 *  and no way to change `cutter` after construction.
 * ============================================================================
 */
contract Diamond {
    error FunctionNotFound(bytes4 selector);
    error CutterCannotBeZeroAddress();
    error BadSeeder();
    error TimelockDelayBelowFloor(uint256 given, uint256 floor);

    /**
     * @notice The floor under `timelockDelay`, enforced at construction.
     *
     * @dev Carried over verbatim from GlobalIndexVault's constructor check. The
     * existing property is "a below-floor delay cannot be DEPLOYED AT ALL" —
     * not "cannot be set", which is a weaker claim. Keeping the check in the
     * diamond's constructor keeps it a deployment-time impossibility rather
     * than a runtime revert, which is what the original proof asserts.
     */
    uint256 internal constant MIN_TIMELOCK_DELAY = 24 hours;

    /**
     * @notice The values that used to be `immutable` on GlobalIndexVault.
     *
     * @dev Design doc section 3.3 rule 2 and section 12 item 1: under
     * DELEGATECALL an `immutable` resolves to the constant baked into whichever
     * FACET is running, so leaving these as `immutable` would let two facets
     * disagree about the timelock delay. They are written here — in the
     * DIAMOND's own constructor, in the diamond's own storage, before any facet
     * exists to be called — and nothing in the finalized facet set writes them
     * again. `Diamond.noWriteToImmutables.test.ts` is the replacement proof.
     *
     * These are exactly three. Audited against GlobalIndexVault's declaration
     * list: `timelockDelay`, `seeder` and `dividendAsset` are the only
     * `immutable` state on the contract; `SEED_LOCK`, `INDEX_VERSION`,
     * `MAX_CONSTITUENTS`, `VIRTUAL_SHARES`, `PAYOUT_GAS`, `PROBE_GAS` and the
     * role keys are `constant`, which is baked into every facet identically and
     * is therefore safe to leave exactly where it is.
     */
    struct CoreInit {
        uint256 timelockDelay;
        address seeder;
        address dividendAsset;
    }

    /**
     * @param cutFacet     the DiamondCutFacet, the diamond's only facet at birth
     * @param cutSelectors that facet's selectors (`diamondCut`, `finalize`, …)
     * @param cutter       the sole address permitted to cut — IndexDeployer,
     *                     which is `address(this)` inside its own constructor
     *                     and therefore an address that will never again
     *                     execute this call after the transaction ends
     * @param init         the three migrated `immutable`s
     */
    constructor(address cutFacet, bytes4[] memory cutSelectors, address cutter, CoreInit memory init) {
        if (cutter == address(0)) revert CutterCannotBeZeroAddress();
        if (init.seeder == address(0)) revert BadSeeder();
        if (init.timelockDelay < MIN_TIMELOCK_DELAY) {
            revert TimelockDelayBelowFloor(init.timelockDelay, MIN_TIMELOCK_DELAY);
        }

        CoreStorage.Layout storage cs = CoreStorage.layout();
        cs.timelockDelay = init.timelockDelay;
        cs.seeder = init.seeder;
        cs.dividendAsset = init.dividendAsset;
        cs.indexOpen = false;

        // One shared reentrancy word for the whole diamond, primed here so no
        // facet ever pays the cold-zero-to-nonzero SSTORE on a user path.
        ReentrancyStorage.layout().status = ReentrancyStorage.NOT_ENTERED;

        DiamondStorage.Layout storage ds = DiamondStorage.layout();
        ds.cutter = cutter;
        ds.facetFunctionSelectors[cutFacet].facetAddressPosition = ds.facetAddresses.length;
        ds.facetAddresses.push(cutFacet);
        for (uint256 i; i < cutSelectors.length; i++) {
            ds.facetFunctionSelectors[cutFacet].functionSelectors.push(cutSelectors[i]);
            ds.selectorToFacetAndPosition[cutSelectors[i]] =
                DiamondStorage.FacetAddressAndPosition(cutFacet, uint96(i));
        }
    }

    /**
     * @dev Route by selector. An unknown selector REVERTS with
     * `FunctionNotFound` — it does not silently succeed, which matters because
     * a silently-succeeding fallback would make every removed selector look
     * like a no-op success to an integrator rather than an error.
     *
     * On the "does this forward arbitrary calldata?" objection: it does, but
     * only to an address the FINALIZED selector table names, and after
     * finalization that table cannot change and contains no settable pointer.
     * The existing property "no entrypoint forwards arbitrary calldata or names
     * an external venue" is re-expressed against that fact rather than deleted.
     */
    fallback() external {
        DiamondStorage.Layout storage ds = DiamondStorage.layout();
        address facet = ds.selectorToFacetAndPosition[msg.sig].facetAddress;
        if (facet == address(0)) revert FunctionNotFound(msg.sig);
        assembly {
            calldatacopy(0, 0, calldatasize())
            let ok := delegatecall(gas(), facet, 0, calldatasize(), 0, 0)
            returndatacopy(0, 0, returndatasize())
            switch ok
            case 0 { revert(0, returndatasize()) }
            default { return(0, returndatasize()) }
        }
    }

    // NO receive(). NO payable anything. See the header.
}
