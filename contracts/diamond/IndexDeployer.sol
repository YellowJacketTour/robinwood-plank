// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Diamond} from "./Diamond.sol";
import {IDiamondCut, IDiamondFinalize, IDiamondLoupe, IDiamondFinalizeView} from "./IDiamond.sol";
import {DiamondCutFacet} from "./facets/DiamondCutFacet.sol";

/**
 * ============================================================================
 *  IndexDeployer — deploy, cut, initialise and FREEZE, in one transaction.
 *
 *  NOT FOR DEPLOYMENT to any network from this repo; there is no deploy script
 *  and hardhat.config.ts has no default network. This contract exists so that
 *  the property it creates can be TESTED, not so that it can be run.
 *
 *  WHY THIS CONTRACT IS THE WHOLE ARGUMENT
 *  ---------------------------------------
 *  Design doc section 6. A diamond whose `diamondCut` is callable is a diamond
 *  whose cutter is a withdrawal path over every pooled reserve — because a cut
 *  can install a facet that transfers them. That is not a timelock problem: a
 *  timelock bounds when a change lands, never what the change may be.
 *
 *  The obvious mitigation, "deploy cuttable and renounce in a later
 *  transaction", does not close it. It leaves a window — short, but real, and
 *  observable, and raceable — during which the anchor rule is FALSE and the
 *  deployer key is equivalent to full custody. If the index is seeded inside
 *  that window, the window has assets in it.
 *
 *  So the cut capability is created and destroyed inside ONE transaction: this
 *  constructor. The cutter is `address(this)` DURING construction, which is an
 *  address that has no deployed code to call it from afterwards and whose
 *  authority ends when the constructor returns — and by then `finalize` has
 *  already removed every cut selector anyway.
 *
 *  THE UNREACHABILITY, STATED PRECISELY
 *  ------------------------------------
 *  There is no "between deploy and finalize" to attack, and the reason is
 *  structural rather than lucky. The EVM has no concurrency: a transaction runs
 *  to completion before any other transaction or call can observe any state it
 *  wrote. Every intermediate state of this constructor — diamond deployed, cut
 *  facet installed, other facets cut in, not yet finalized — exists only inside
 *  this call frame. No external account can send a transaction into the middle
 *  of it, and no contract can call in either, because the diamond's address is
 *  not known to anyone until CREATE returns and nothing is told about it here.
 *  `Diamond.finalize.test.ts` proves this directly rather than asserting it.
 *
 *  WHAT `finalize` CHECKS, AND WHY EACH CHECK IS NOT DECORATIVE
 *  -----------------------------------------------------------
 *   - the facet-set hash, so the deployment matches the published manifest and
 *     an extra facet cannot be slipped in;
 *   - `indexOpen == false`, so that even a botched deployment cannot leave a
 *     cuttable diamond holding public deposits;
 *   - and then it removes every cut selector, so the capability is gone rather
 *     than merely guarded.
 * ============================================================================
 */
contract IndexDeployer {
    /// @notice One facet to install: its address and the selectors it owns.
    struct FacetManifest {
        address facet;
        bytes4[] selectors;
    }

    /// @notice The finalized diamond. Set once, in the constructor.
    address public immutable diamond;

    /// @notice The manifest hash committed in the deployment calldata and
    /// verified on-chain against the loupe's actual state.
    bytes32 public immutable committedFacetSetHash;

    error SelfCheckFailedNotFinalized();
    error SelfCheckFailedCutSelectorStillRouted(bytes4 selector);
    error SelfCheckFailedSelectorMisrouted(bytes4 selector, address expected, address actual);
    error SelfCheckFailedDevModeSet();
    error SelfCheckFailedHashMismatch(bytes32 expected, bytes32 actual);
    error NoFacets();

    event IndexDiamondDeployed(address indexed diamond, bytes32 facetSetHash, uint256 facetCount);

    /**
     * @param cutFacet    a pre-deployed DiamondCutFacet
     * @param manifest    every other facet, pre-deployed, with its selectors.
     *                    Facets are deployed in EARLIER transactions on
     *                    purpose: thirteen 24KB code deposits at 200 gas/byte
     *                    is ~64M gas and would not fit in a block, so folding
     *                    them into this transaction would make the atomic
     *                    deploy-and-finalize physically impossible. Design doc
     *                    section 12 item 2 flags exactly this as the thing to
     *                    check; passing addresses is the answer, and it costs
     *                    nothing, because a facet sitting deployed and
     *                    un-installed has no authority over anything.
     * @param interfaceIds ERC-165 ids to advertise
     * @param init        the three migrated `immutable`s
     * @param expectedFacetSetHash the pre-committed manifest hash
     */
    constructor(
        address cutFacet,
        FacetManifest[] memory manifest,
        bytes4[] memory interfaceIds,
        Diamond.CoreInit memory init,
        bytes32 expectedFacetSetHash
    ) {
        if (manifest.length == 0) revert NoFacets();

        bytes4[] memory cutSelectors = new bytes4[](4);
        cutSelectors[0] = IDiamondCut.diamondCut.selector;
        cutSelectors[1] = IDiamondFinalize.finalize.selector;
        cutSelectors[2] = DiamondCutFacet.pendingFacetSetHash.selector;
        cutSelectors[3] = DiamondCutFacet.registerInterfaces.selector;

        // 1. Deploy the diamond with the cut facet as its only facet and THIS
        //    CONSTRUCTOR as the sole cutter.
        Diamond d = new Diamond(cutFacet, cutSelectors, address(this), init);
        address dAddr = address(d);
        diamond = dAddr;

        // 2. Cut in every other facet. Each Add runs LibBytecodeScan, so a
        //    facet containing SELFDESTRUCT or DELEGATECALL reverts this whole
        //    transaction and no diamond is created at all.
        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](manifest.length);
        for (uint256 i; i < manifest.length; i++) {
            cuts[i] = IDiamondCut.FacetCut({
                facetAddress: manifest[i].facet,
                action: IDiamondCut.FacetCutAction.Add,
                functionSelectors: manifest[i].selectors
            });
        }
        IDiamondCut(dAddr).diamondCut(cuts, address(0), "");

        // 3. Advertise ERC-165 ids. This lives on the CUT facet, not on the
        //    loupe, precisely so that it disappears at finalization along with
        //    everything else that can write. A `registerInterfaces` surviving
        //    into the finalized set would be a permanent, ungoverned write —
        //    harmless in what it touches, but it is exactly the shape of the
        //    "an `initialize` is still callable" bug and it costs nothing to
        //    not have it.
        if (interfaceIds.length != 0) {
            DiamondCutFacet(dAddr).registerInterfaces(interfaceIds);
        }

        // 4. Freeze. This removes all three cut selectors, `finalize` included.
        committedFacetSetHash = expectedFacetSetHash;
        IDiamondFinalize(dAddr).finalize(expectedFacetSetHash);

        // 5. Self-check the loupe and revert the entire transaction on any
        //    disagreement. Design doc section 10: the new failure mode a diamond
        //    introduces is a botched deployment that is live, broken and
        //    unfixable. These checks turn that into an atomic revert.
        if (!IDiamondFinalizeView(dAddr).isFinalized()) revert SelfCheckFailedNotFinalized();
        if (IDiamondFinalizeView(dAddr).isDevMode()) revert SelfCheckFailedDevModeSet();
        for (uint256 i; i < cutSelectors.length; i++) {
            if (IDiamondLoupe(dAddr).facetAddress(cutSelectors[i]) != address(0)) {
                revert SelfCheckFailedCutSelectorStillRouted(cutSelectors[i]);
            }
        }
        for (uint256 i; i < manifest.length; i++) {
            for (uint256 j; j < manifest[i].selectors.length; j++) {
                address got = IDiamondLoupe(dAddr).facetAddress(manifest[i].selectors[j]);
                if (got != manifest[i].facet) {
                    revert SelfCheckFailedSelectorMisrouted(manifest[i].selectors[j], manifest[i].facet, got);
                }
            }
        }
        bytes32 stored = IDiamondFinalizeView(dAddr).facetSetHash();
        if (stored != expectedFacetSetHash) revert SelfCheckFailedHashMismatch(expectedFacetSetHash, stored);

        emit IndexDiamondDeployed(dAddr, expectedFacetSetHash, manifest.length);
    }
}
