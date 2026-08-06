// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IDiamondCut, IDiamondFinalize} from "../IDiamond.sol";
import {LibDiamond} from "../LibDiamond.sol";
import {DiamondStorage} from "../storage/IndexStorage.sol";

/**
 * ============================================================================
 *  DiamondCutFacet — installed at birth, removed before the transaction ends.
 *
 *  This facet's entire lifetime on a production diamond is the interior of one
 *  transaction: IndexDeployer's constructor. It cuts the other facets in, then
 *  calls `finalize`, which removes both of the selectors below — so by the time
 *  any external observer can see the diamond, neither function is reachable.
 *
 *  It declares NO state variable. Everything it touches is in the canonical
 *  diamond namespace, reached through LibDiamond.
 * ============================================================================
 */
contract DiamondCutFacet is IDiamondCut, IDiamondFinalize {
    /// @inheritdoc IDiamondCut
    function diamondCut(FacetCut[] calldata _diamondCut, address _init, bytes calldata _calldata) external override {
        LibDiamond.enforceIsCutter();
        LibDiamond.diamondCut(_diamondCut, _init, _calldata);
    }

    /// @inheritdoc IDiamondFinalize
    function finalize(bytes32 expectedFacetSetHash) external override {
        LibDiamond.finalize(expectedFacetSetHash);
    }

    /**
     * @notice Advertise ERC-165 interface ids. Cutter-only, and it lives on
     * THIS facet — the one that is removed at finalization — so that it cannot
     * survive into the frozen diamond as a permanent ungoverned write.
     */
    function registerInterfaces(bytes4[] calldata ids) external {
        LibDiamond.enforceIsCutter();
        DiamondStorage.Layout storage ds = DiamondStorage.layout();
        for (uint256 i; i < ids.length; i++) {
            ds.supportedInterfaces[ids[i]] = true;
        }
    }

    /// @notice The canonical hash of the currently-installed facet set,
    /// excluding this facet. Exposed so a deployer can commit to the hash it is
    /// about to be checked against, and so a reviewer can re-derive it from a
    /// live diamond. Removed along with the rest of this facet at finalization
    /// — DiamondLoupeFacet carries the permanent read.
    function pendingFacetSetHash() external view returns (bytes32) {
        return LibDiamond.facetSetHash();
    }
}
