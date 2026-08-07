// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Diamond} from "../diamond/Diamond.sol";
import {IDiamondCut} from "../diamond/IDiamond.sol";
import {DiamondCutFacet} from "../diamond/facets/DiamondCutFacet.sol";
import {DiamondStorage} from "../diamond/storage/IndexStorage.sol";

/**
 * ============================================================================
 *  DevIndexDeployer — TIER B. Rehearsal only. NEVER a production path.
 *
 *  Design doc section 6.2 Tier B. This deployer leaves the cut facet INSTALLED
 *  so a local iteration loop can replace a facet without redeploying the world.
 *  That is a diamond in exactly the state the entire design exists to make
 *  unobservable: its cutter is a live address holding, in effect, custody of
 *  anything the diamond holds.
 *
 *  THREE THINGS MAKE IT IMPOSSIBLE TO CONFUSE WITH TIER A
 *  ------------------------------------------------------
 *   1. It lives under `contracts/test/`, which no deploy path reads.
 *   2. It writes `ds.devMode = true`, permanently, before any facet is cut in
 *      — so the flag is set even if the rest of the deployment reverts.
 *   3. Every audit fixture asserts `isDevMode() == false`, so any suite that
 *      claims to prove a production property against a Tier B diamond fails
 *      rather than silently proving it about the wrong object.
 *
 *  There is no way to clear `devMode`. A diamond that was ever cuttable stays
 *  marked as such forever, which is the honest thing for the flag to mean.
 * ============================================================================
 */
contract DevIndexDeployer {
    address public immutable diamond;

    struct FacetManifest {
        address facet;
        bytes4[] selectors;
    }

    error NoFacets();

    constructor(
        address cutFacet,
        address markerFacet,
        FacetManifest[] memory manifest,
        Diamond.CoreInit memory init
    ) {
        if (manifest.length == 0) revert NoFacets();

        bytes4[] memory cutSelectors = new bytes4[](4);
        cutSelectors[0] = IDiamondCut.diamondCut.selector;
        cutSelectors[1] = bytes4(keccak256("finalize(bytes32)"));
        cutSelectors[2] = DiamondCutFacet.pendingFacetSetHash.selector;
        cutSelectors[3] = DiamondCutFacet.registerInterfaces.selector;

        // The cutter is THIS CONTRACT, which — unlike IndexDeployer — still
        // exists after construction and can therefore still cut. That is the
        // whole difference, and it is why this is rehearsal-only.
        Diamond d = new Diamond(cutFacet, cutSelectors, address(this), init);
        diamond = address(d);

        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](manifest.length + 1);
        for (uint256 i; i < manifest.length; i++) {
            cuts[i] = IDiamondCut.FacetCut({
                facetAddress: manifest[i].facet,
                action: IDiamondCut.FacetCutAction.Add,
                functionSelectors: manifest[i].selectors
            });
        }
        bytes4[] memory markerSel = new bytes4[](1);
        markerSel[0] = IDevMark.markDevMode.selector;
        cuts[manifest.length] = IDiamondCut.FacetCut({
            facetAddress: markerFacet,
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: markerSel
        });
        IDiamondCut(diamond).diamondCut(cuts, address(0), "");

        // Mark it, permanently and unconditionally. Done through the cut facet
        // so it uses the same authority path as everything else here.
        IDevMark(diamond).markDevMode();
    }

    /// @notice Still cuttable. That is the point, and it is why this contract
    /// must never appear outside `contracts/test/`.
    function cut(IDiamondCut.FacetCut[] calldata cuts) external {
        IDiamondCut(diamond).diamondCut(cuts, address(0), "");
    }

    /// @notice Passthrough that lets a test drive the `_init`/`_calldata`
    /// parameters, so the refusal of an initialisation delegatecall can be
    /// exercised through the real cutter rather than bounced earlier on the
    /// cutter check. There is no production analogue: IndexDeployer never
    /// passes anything but `(address(0), "")`.
    function cutWithInit(IDiamondCut.FacetCut[] calldata cuts, address init, bytes calldata data)
        external
    {
        IDiamondCut(diamond).diamondCut(cuts, init, data);
    }
}

interface IDevMark {
    function markDevMode() external;
}

/**
 * @notice The dev-mode marker, on its own facet so that it is not part of the
 * production cut facet's ABI at all. Tier A's manifest never names this
 * contract, so `devMode` has no writer whatsoever in a production diamond —
 * which is stronger than "has a writer that is gated".
 */
contract DevModeMarkerFacet is IDevMark {
    function markDevMode() external override {
        DiamondStorage.layout().devMode = true;
    }
}
