// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IDiamondLoupe, IERC165, IDiamondFinalizeView} from "../IDiamond.sol";
import {DiamondStorage} from "../storage/IndexStorage.sol";
import {LibDiamond} from "../LibDiamond.sol";

/**
 * ============================================================================
 *  DiamondLoupeFacet — the permanent, read-only window onto the facet set.
 *
 *  This facet is how the anchor rule is checked under the diamond. Design doc
 *  section 6.1: "no privileged function can reach reserves already pooled" used
 *  to be provable by enumerating one contract's ABI. Under a diamond the ABI is
 *  not the code, so the proof becomes ABI enumeration over the loupe's reported
 *  facet set PLUS the assertion that the set can no longer change. Both halves
 *  are read from here.
 *
 *  Declares no state variable; reads the canonical diamond namespace only.
 * ============================================================================
 */
contract DiamondLoupeFacet is IDiamondLoupe, IERC165, IDiamondFinalizeView {
    function facets() external view override returns (Facet[] memory out) {
        DiamondStorage.Layout storage ds = DiamondStorage.layout();
        uint256 n = ds.facetAddresses.length;
        out = new Facet[](n);
        for (uint256 i; i < n; i++) {
            address f = ds.facetAddresses[i];
            out[i].facetAddress = f;
            out[i].functionSelectors = ds.facetFunctionSelectors[f].functionSelectors;
        }
    }

    function facetFunctionSelectors(address _facet) external view override returns (bytes4[] memory) {
        return DiamondStorage.layout().facetFunctionSelectors[_facet].functionSelectors;
    }

    function facetAddresses() external view override returns (address[] memory) {
        return DiamondStorage.layout().facetAddresses;
    }

    function facetAddress(bytes4 _functionSelector) external view override returns (address) {
        return DiamondStorage.layout().selectorToFacetAndPosition[_functionSelector].facetAddress;
    }

    function supportsInterface(bytes4 interfaceId) external view override returns (bool) {
        return DiamondStorage.layout().supportedInterfaces[interfaceId];
    }

    /// @inheritdoc IDiamondFinalizeView
    function isFinalized() external view override returns (bool) {
        return DiamondStorage.layout().finalized;
    }

    /// @inheritdoc IDiamondFinalizeView
    function isDevMode() external view override returns (bool) {
        return DiamondStorage.layout().devMode;
    }

    /// @inheritdoc IDiamondFinalizeView
    function facetSetHash() external view override returns (bytes32) {
        return DiamondStorage.layout().facetSetHash;
    }

    /// @notice Re-derive the facet-set hash from the CURRENT table, so anyone
    /// can check the frozen diamond against the manifest published with the
    /// source rather than trusting the stored value.
    function currentFacetSetHash() external view returns (bytes32) {
        return LibDiamond.facetSetHash();
    }

    /// @notice The address that was permitted to cut. Kept readable so a
    /// reviewer can confirm it is a contract that no longer exists as a caller
    /// (IndexDeployer's constructor) rather than a live EOA.
    function cutter() external view returns (address) {
        return DiamondStorage.layout().cutter;
    }
}
