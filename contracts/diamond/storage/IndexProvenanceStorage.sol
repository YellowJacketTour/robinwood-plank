// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * ============================================================================
 *  IndexProvenanceStorage — the ONE trusted root this diamond has.
 *
 *  WHY THIS EXISTS AT ALL, STATED PLAINLY. Audit C-6 is not a bug in a formula;
 *  it is the absence of a trust root. `queueListing` accepted an arbitrary
 *  `token` and an arbitrary `IIndexPriceSource`, so the admission key could list
 *  a token it minted, priced by an oracle it wrote, and walk the proceeds out
 *  through the deliberately unblockable pro-rata door. The PoC extracted 681.66
 *  ETH from a ~3,500 ETH basket.
 *
 *  NO AMOUNT OF ARITHMETIC CLOSES THAT. A contract can lie about its price
 *  source, its reserves, and its own realizable curve with equal ease; every
 *  number an unknown address reports about itself is worth exactly nothing. The
 *  only thing that distinguishes a real constituent from a manufactured one is
 *  WHO DEPLOYED IT — provenance — and provenance requires a registry that the
 *  attacker does not control. `CollectionVaultFactory.isVault(address)` is that
 *  registry: it returns true for exactly the vaults the factory itself deployed
 *  (`CollectionVaultFactory.sol:192`), and an attacker cannot write to it
 *  without deploying a genuine vault through it.
 *
 *  FAIL-CLOSED BY DEFAULT. The default value is `address(0)`, and
 *  `IndexFacetBase._requireAdmissiblePostOpen` treats "no registry configured"
 *  as "NOTHING is admissible". A deployment that never configures a factory can
 *  therefore never admit a post-open constituent at all — which is the safe
 *  direction of the failure, and is why this is the default rather than an
 *  allow-all sentinel. Genesis seeding (`IndexBootstrapFacet.seedConstituent`,
 *  seeder-only, pre-open) is deliberately NOT gated: the seeder chooses the
 *  entire opening basket by construction, so gating them against a registry
 *  they also configure would be theatre, not security. That residual trust is
 *  disclosed rather than hidden — see the header of `IndexFacetBase._list`.
 *
 *  DELIBERATELY ITS OWN FILE AND ITS OWN NAMESPACE. Appending a member to an
 *  existing `Layout` struct is layout-safe only if nothing else appends
 *  concurrently; a fresh namespace at its own hashed slot cannot collide with
 *  anything, present or future (see `IndexStorage.sol`'s header for the
 *  spacing argument this reuses verbatim).
 * ============================================================================
 */
library IndexProvenanceStorage {
    /// @dev `keccak256("marketplank.index.provenance.storage")`, computed the
    /// same way every other namespace in this diamond is.
    bytes32 internal constant SLOT = keccak256("marketplank.index.provenance.storage");

    struct QueuedAddress {
        address value;
        uint64 eta;
        bool pending;
    }

    struct Layout {
        /// @notice The `CollectionVaultFactory` whose `isVault(address)` is the
        /// sole provenance authority for post-open constituent admission and
        /// for every zap leg. `address(0)` means "no registry" and therefore
        /// "admit nothing".
        address vaultFactory;
        /// @notice The timelocked queue slot for the above. Same
        /// queue/execute shape as every other governed address in this
        /// diamond — a timelock bounds WHEN a change lands, never how bad it
        /// can be, so the hard properties stay in the code.
        QueuedAddress queued;
    }

    function layout() internal pure returns (Layout storage l) {
        bytes32 s = SLOT;
        assembly {
            l.slot := s
        }
    }
}
