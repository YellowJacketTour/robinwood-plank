// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * ============================================================================
 *  EIP-2535 interfaces, plus this deployment's two additions.
 *
 *  NOT FOR DEPLOYMENT by itself. See contracts/diamond/Diamond.sol.
 *
 *  The cut/loupe interfaces are the standard ones verbatim so third-party
 *  loupe tooling (louper.dev, block explorers) reads this diamond without a
 *  custom adapter. The two additions are `finalize` and `isFinalized`, which
 *  exist because this diamond is deliberately NOT upgradeable — see
 *  docs/DESIGN-DIAMOND-UNIFIED-ARCHITECTURE.md section 6.
 * ============================================================================
 */

interface IDiamondCut {
    enum FacetCutAction {
        Add,
        Replace,
        Remove
    }

    struct FacetCut {
        address facetAddress;
        FacetCutAction action;
        bytes4[] functionSelectors;
    }

    event DiamondCut(FacetCut[] _diamondCut, address _init, bytes _calldata);

    /**
     * @notice Add/replace/remove functions. Reverts once the diamond is
     * finalized — and after finalization there is no selector routing here at
     * all, so this function is doubly unreachable (section 6.2's two locks).
     *
     * @dev `_init`/`_calldata` are present for interface compatibility with
     * EIP-2535 tooling and MUST be `address(0)` / empty. This diamond runs no
     * initialisation delegatecall, ever: an `initialize` reachable post-cut is
     * a well-known way to overwrite an owner, and refusing the parameter
     * outright is cheaper to prove than constraining it.
     */
    function diamondCut(FacetCut[] calldata _diamondCut, address _init, bytes calldata _calldata) external;
}

interface IDiamondLoupe {
    struct Facet {
        address facetAddress;
        bytes4[] functionSelectors;
    }

    function facets() external view returns (Facet[] memory facets_);

    function facetFunctionSelectors(address _facet) external view returns (bytes4[] memory);

    function facetAddresses() external view returns (address[] memory);

    function facetAddress(bytes4 _functionSelector) external view returns (address);
}

interface IERC165 {
    function supportsInterface(bytes4 interfaceId) external view returns (bool);
}

/// @notice The non-standard half: the freeze.
interface IDiamondFinalize {
    /**
     * @notice The last cut that ever happens. Verifies the installed facet set
     * against a hash committed in the deployment calldata, requires that no
     * user funds are present, sets the permanent frozen flag, and removes
     * every DiamondCutFacet selector — including this one.
     */
    function finalize(bytes32 expectedFacetSetHash) external;
}

interface IDiamondFinalizeView {
    function isFinalized() external view returns (bool);

    /// @notice True only for the `contracts/test`-scoped rehearsal deployer.
    /// Every audit fixture asserts this is false.
    function isDevMode() external view returns (bool);

    /// @notice The manifest hash `finalize` verified against.
    function facetSetHash() external view returns (bytes32);
}
