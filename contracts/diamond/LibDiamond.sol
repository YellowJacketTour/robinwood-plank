// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IDiamondCut, IDiamondFinalize} from "./IDiamond.sol";
import {DiamondStorage} from "./storage/IndexStorage.sol";
import {LibBytecodeScan} from "./LibBytecodeScan.sol";
import {CoreStorage} from "./storage/IndexStorage.sol";

/**
 * ============================================================================
 *  LibDiamond — the selector table, the cut, and the freeze.
 *
 *  NOT FOR DEPLOYMENT. `internal` library; no bytecode, no delegatecall target.
 *
 *  THE ONE THING TO UNDERSTAND ABOUT THIS FILE
 *  -------------------------------------------
 *  Design doc section 1.3 quotes ScopedRoles.sol's header, which refuses proxies
 *  and delegatecall on the grounds that they are "the canonical path to 'the
 *  admin bricked or rugged the vault'". That objection is correct and a diamond
 *  contradicts it head-on: while `diamondCut` is callable, whoever can call it
 *  IS a withdrawal path over pooled reserves, because a cut can install a facet
 *  that does literally anything. A timelock bounds WHEN, never WHAT.
 *
 *  The closure is not "we promise to renounce later". A later renouncement
 *  means there was a window during which the anchor rule was false. The closure
 *  is that the cut capability is created and destroyed inside the SAME
 *  transaction that creates the diamond (see IndexDeployer), so no external
 *  party ever observes, and no attacker can ever race, a cuttable diamond.
 *
 *  TWO INDEPENDENT LOCKS, BOTH OF WHICH MUST FAIL FOR A CUT TO OCCUR
 *  -----------------------------------------------------------------
 *   1. After `finalize`, NO SELECTOR routes to `diamondCut` or to `finalize`.
 *      The fallback reverts `FunctionNotFound`. There is nothing to call.
 *   2. Even if a selector were somehow reachable, `ds.finalized` makes both
 *      revert unconditionally.
 *
 *  And a third, upstream of both: `cutter` is written once in the diamond's
 *  constructor and there is no function anywhere that rewrites it.
 * ============================================================================
 */
library LibDiamond {
    error NotCutter(address caller);
    error DiamondIsFinalized();
    error NoSelectorsInFacet();
    error IncorrectFacetCutAction(uint8 action);
    error CannotAddSelectorThatAlreadyExists(bytes4 selector, address owner);
    error CannotReplaceSelectorThatDoesNotExist(bytes4 selector);
    error CannotRemoveSelectorThatDoesNotExist(bytes4 selector);
    error AddFacetCannotBeZeroAddress();
    error RemoveFacetMustBeZeroAddress(address facet);
    error InitialisationIsNotSupported();
    error FacetSetHashMismatch(bytes32 expected, bytes32 actual);
    error IndexMustBeClosedToFinalize();
    error NothingToFinalize();

    event DiamondCut(IDiamondCut.FacetCut[] _diamondCut, address _init, bytes _calldata);
    event Finalized(bytes32 facetSetHash, uint256 blockNumber, uint256 facetCount);

    // ---------------------------------------------------------------- guards

    function enforceIsCutter() internal view {
        DiamondStorage.Layout storage ds = DiamondStorage.layout();
        if (ds.finalized) revert DiamondIsFinalized();
        if (msg.sender != ds.cutter) revert NotCutter(msg.sender);
    }

    // ------------------------------------------------------------------- cut

    function diamondCut(IDiamondCut.FacetCut[] memory cuts, address _init, bytes memory _calldata) internal {
        // No initialisation delegatecall, ever. Design doc section 6.4: an
        // `initialize` reachable post-cut is the standard way an owner or a
        // parameter set gets silently overwritten. Every value this diamond
        // needs is written by IndexDeployer with a direct storage write, in the
        // same transaction, through a normal (non-delegatecall) facet call.
        if (_init != address(0) || _calldata.length != 0) revert InitialisationIsNotSupported();

        for (uint256 i; i < cuts.length; i++) {
            IDiamondCut.FacetCut memory cut = cuts[i];
            if (cut.functionSelectors.length == 0) revert NoSelectorsInFacet();
            if (cut.action == IDiamondCut.FacetCutAction.Add) {
                _addFunctions(cut.facetAddress, cut.functionSelectors);
            } else if (cut.action == IDiamondCut.FacetCutAction.Replace) {
                _replaceFunctions(cut.facetAddress, cut.functionSelectors);
            } else if (cut.action == IDiamondCut.FacetCutAction.Remove) {
                _removeFunctions(cut.facetAddress, cut.functionSelectors);
            } else {
                revert IncorrectFacetCutAction(uint8(cut.action));
            }
        }
        emit DiamondCut(cuts, _init, _calldata);
    }

    function _addFunctions(address facet, bytes4[] memory selectors) private {
        if (facet == address(0)) revert AddFacetCannotBeZeroAddress();
        // ALWAYS-ON, not a deploy-script convention: every facet that is ever
        // installed is swept for SELFDESTRUCT and DELEGATECALL first.
        LibBytecodeScan.assertNoDangerousOpcodes(facet);

        DiamondStorage.Layout storage ds = DiamondStorage.layout();
        uint96 pos = uint96(ds.facetFunctionSelectors[facet].functionSelectors.length);
        if (pos == 0) _addFacetAddress(ds, facet);

        for (uint256 i; i < selectors.length; i++) {
            bytes4 sel = selectors[i];
            address owner = ds.selectorToFacetAndPosition[sel].facetAddress;
            // Selector collision is rejected here, at cut time, unconditionally
            // — including the case where two DIFFERENT signatures hash to the
            // same 4 bytes. Diamond.selectors.test.ts additionally asserts the
            // union of every facet ABI is 4-byte-unique before a cut is even
            // attempted, so this is the second of two independent checks.
            if (owner != address(0)) revert CannotAddSelectorThatAlreadyExists(sel, owner);
            ds.facetFunctionSelectors[facet].functionSelectors.push(sel);
            ds.selectorToFacetAndPosition[sel] = DiamondStorage.FacetAddressAndPosition(facet, pos);
            pos++;
        }
    }

    function _replaceFunctions(address facet, bytes4[] memory selectors) private {
        if (facet == address(0)) revert AddFacetCannotBeZeroAddress();
        LibBytecodeScan.assertNoDangerousOpcodes(facet);

        DiamondStorage.Layout storage ds = DiamondStorage.layout();
        for (uint256 i; i < selectors.length; i++) {
            bytes4 sel = selectors[i];
            address old = ds.selectorToFacetAndPosition[sel].facetAddress;
            if (old == address(0)) revert CannotReplaceSelectorThatDoesNotExist(sel);
            _removeOne(ds, old, sel);
            uint96 pos = uint96(ds.facetFunctionSelectors[facet].functionSelectors.length);
            if (pos == 0) _addFacetAddress(ds, facet);
            ds.facetFunctionSelectors[facet].functionSelectors.push(sel);
            ds.selectorToFacetAndPosition[sel] = DiamondStorage.FacetAddressAndPosition(facet, pos);
        }
    }

    function _removeFunctions(address facet, bytes4[] memory selectors) private {
        if (facet != address(0)) revert RemoveFacetMustBeZeroAddress(facet);
        DiamondStorage.Layout storage ds = DiamondStorage.layout();
        for (uint256 i; i < selectors.length; i++) {
            bytes4 sel = selectors[i];
            address old = ds.selectorToFacetAndPosition[sel].facetAddress;
            if (old == address(0)) revert CannotRemoveSelectorThatDoesNotExist(sel);
            _removeOne(ds, old, sel);
        }
    }

    function _addFacetAddress(DiamondStorage.Layout storage ds, address facet) private {
        ds.facetFunctionSelectors[facet].facetAddressPosition = ds.facetAddresses.length;
        ds.facetAddresses.push(facet);
    }

    /// @dev Swap-and-pop out of both the per-facet selector list and, if that
    /// empties the facet, the facet address list.
    function _removeOne(DiamondStorage.Layout storage ds, address facet, bytes4 sel) private {
        uint256 pos = ds.selectorToFacetAndPosition[sel].functionSelectorPosition;
        uint256 last = ds.facetFunctionSelectors[facet].functionSelectors.length - 1;
        if (pos != last) {
            bytes4 moved = ds.facetFunctionSelectors[facet].functionSelectors[last];
            ds.facetFunctionSelectors[facet].functionSelectors[pos] = moved;
            ds.selectorToFacetAndPosition[moved].functionSelectorPosition = uint96(pos);
        }
        ds.facetFunctionSelectors[facet].functionSelectors.pop();
        delete ds.selectorToFacetAndPosition[sel];

        if (last == 0) {
            uint256 lastFacet = ds.facetAddresses.length - 1;
            uint256 facetPos = ds.facetFunctionSelectors[facet].facetAddressPosition;
            if (facetPos != lastFacet) {
                address movedFacet = ds.facetAddresses[lastFacet];
                ds.facetAddresses[facetPos] = movedFacet;
                ds.facetFunctionSelectors[movedFacet].facetAddressPosition = facetPos;
            }
            ds.facetAddresses.pop();
            delete ds.facetFunctionSelectors[facet].facetAddressPosition;
        }
    }

    // -------------------------------------------------------------- finalize

    /**
     * @notice The last cut that ever happens on this diamond.
     *
     * Order of operations matters and is deliberate:
     *  1. verify the installed set against the hash committed in the deployment
     *     calldata, so the deployer cannot quietly install a facet the published
     *     manifest does not name;
     *  2. require `indexOpen == false`, so that even a botched deployment
     *     cannot leave a cuttable diamond holding public deposits — belt and
     *     braces on top of the atomicity, not a substitute for it;
     *  3. set the frozen flag BEFORE removing selectors, so that even a
     *     hypothetical reentrant path sees a finalized diamond;
     *  4. remove every selector owned by the cut facet, `finalize` included.
     */
    function finalize(bytes32 expectedFacetSetHash) internal {
        DiamondStorage.Layout storage ds = DiamondStorage.layout();
        if (ds.finalized) revert DiamondIsFinalized();
        if (msg.sender != ds.cutter) revert NotCutter(msg.sender);

        bytes32 actual = facetSetHash();
        if (actual != expectedFacetSetHash) revert FacetSetHashMismatch(expectedFacetSetHash, actual);
        if (CoreStorage.layout().indexOpen) revert IndexMustBeClosedToFinalize();

        // Every selector owned by the cut facet goes, including the one
        // executing right now. The cut facet is identified by which facet owns
        // `finalize` — NOT by "whichever facet is serving this call", which
        // would give a different (wrong) answer when `facetSetHash` is read
        // through the loupe.
        address cutFacet = _cutFacet(ds);
        bytes4[] memory doomed = ds.facetFunctionSelectors[cutFacet].functionSelectors;
        if (doomed.length == 0) revert NothingToFinalize();

        ds.finalized = true;
        ds.facetSetHash = expectedFacetSetHash;

        for (uint256 i; i < doomed.length; i++) {
            _removeOne(ds, cutFacet, doomed[i]);
        }

        emit Finalized(expectedFacetSetHash, block.number, ds.facetAddresses.length);
    }

    /**
     * @notice Canonical hash of the installed facet set, re-derived from the
     * loupe's ACTUAL state rather than from the calldata that produced it.
     *
     * @dev The encoding is ORDER-INDEPENDENT: the XOR of `keccak256(facet ++
     * selector)` over every (facet, selector) pair in the table, excluding the
     * cut facet's own pairs.
     *
     * ORDER-INDEPENDENCE IS NOT A STYLE CHOICE — IT IS REQUIRED FOR CORRECTNESS.
     * `facetAddresses` is maintained by swap-and-pop. Removing the cut facet at
     * finalization therefore MOVES the last facet into index 0, so the array's
     * order after finalization is not the order it had when the hash was
     * committed. An order-sensitive hash would be re-derivable only from the
     * pre-finalize diamond — the one state nobody outside the deployment
     * transaction can ever observe — which would make the commitment
     * unverifiable in practice and therefore worthless. (This was found by
     * `Diamond.finalize.test.ts`'s "independently re-derivable from the FROZEN
     * diamond" case, which is exactly the check a reviewer performs.)
     *
     * WHY XOR IS SOUND HERE, given that XOR usually is not. XOR cancels equal
     * terms, so a commutative XOR digest is only safe when no term can repeat.
     * Here a term is `keccak256(facet ++ selector)` and a selector maps to
     * EXACTLY ONE facet — the table is a function from selector to facet, and
     * `_addFunctions` rejects any selector that is already owned. So no pair can
     * appear twice and nothing can be made to cancel. Adding, removing or
     * re-pointing any selector changes the digest.
     *
     * It is also NOT `keccak256(abi.encodePacked(facet, selectors))`: packing a
     * `bytes4[]` pads each element to 32 bytes, so the obvious off-chain
     * re-derivation silently disagrees with the on-chain one. For a hash whose
     * whole job is to be independently re-derivable, that ambiguity is a defect.
     *
     * Post-finalize, `_cutFacet` is `address(0)`, nothing is excluded, and this
     * re-derives exactly the committed value from the frozen table.
     */
    function facetSetHash() internal view returns (bytes32) {
        DiamondStorage.Layout storage ds = DiamondStorage.layout();
        address cutFacet = _cutFacet(ds);

        bytes32 acc;
        uint256 n = ds.facetAddresses.length;
        for (uint256 i; i < n; i++) {
            address f = ds.facetAddresses[i];
            if (f == cutFacet) continue;
            bytes4[] storage sels = ds.facetFunctionSelectors[f].functionSelectors;
            for (uint256 j; j < sels.length; j++) {
                acc ^= keccak256(abi.encodePacked(f, sels[j]));
            }
        }
        return acc;
    }

    /// @dev Whoever owns `finalize` is the cut facet. Post-finalization this is
    /// `address(0)` and nothing is excluded, so the hash re-derived from a
    /// FROZEN diamond equals the hash that was committed at deploy time — which
    /// is what makes the committed hash independently checkable forever.
    function _cutFacet(DiamondStorage.Layout storage ds) private view returns (address) {
        return ds.selectorToFacetAndPosition[IDiamondFinalize.finalize.selector].facetAddress;
    }
}
