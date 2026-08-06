// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * ============================================================================
 *  IndexStorage — every namespaced storage region in the Index diamond.
 *
 *  NOT FOR DEPLOYMENT. Pure `internal` libraries; no deployed bytecode of
 *  their own, and therefore no DELEGATECALL target (which matters: the facet
 *  bytecode scan in LibBytecodeScan rejects opcode 0xf4 outright, so an
 *  external `public` library would be un-installable by construction).
 *
 *  WHY ONE FILE
 *  ------------
 *  Design doc section 3.3 rule: *one namespace per concern, not per facet*, with
 *  exactly one declaration site per struct. Keeping every derivation in one
 *  file makes the "are these thirteen slots actually distinct?" review a
 *  single-screen read rather than a thirteen-file scavenger hunt, and makes it
 *  impossible to add a fourteenth namespace without seeing the other thirteen.
 *
 *  THE DERIVATION
 *  --------------
 *      keccak256(abi.encode(uint256(keccak256(id)) - 1)) & ~bytes32(uint256(0xff))
 *
 *  This is ERC-7201. Both halves earn their place:
 *
 *   - the `- 1` means the slot is not the image of any string under keccak,
 *     so no attacker-chosen mapping key or array index can be made to land on
 *     a namespace root by finding a preimage;
 *   - the `& ~0xff` mask aligns each root to a 256-slot boundary, so appending
 *     a member to a Layout struct can never walk out of its own region into a
 *     different namespace's root. The trailing `__gap` in each Layout makes
 *     that headroom explicit rather than implicit.
 *
 *  THE RULE THIS FILE EXISTS TO ENFORCE
 *  ------------------------------------
 *  No facet may declare a state variable in its own contract body — not one,
 *  not ever. A facet body holds `constant`s, `immutable`s, functions, events
 *  and errors and nothing else. A facet that inherits OpenZeppelin's ERC20,
 *  ReentrancyGuard or Ownable lands storage at slot 0, which under DELEGATECALL
 *  is the diamond's own slot 0. `Diamond.bytecode.test.ts` reads every facet's
 *  compiler-emitted `storageLayout` and fails the build on any non-constant
 *  entry, so this is a checked rule and not an aspiration.
 * ============================================================================
 */

/**
 * @notice The EIP-2535 selector table, plus this deployment's freeze flags.
 *
 * @dev Deliberately kept at the CANONICAL `diamond.standard.diamond.storage`
 * slot rather than a marketplank-namespaced one, so that third-party loupe
 * tooling that reads the table directly by slot still works. This is the one
 * namespace in the file that does NOT use the ERC-7201 derivation, and the
 * reason is interoperability, not oversight.
 */
library DiamondStorage {
    bytes32 internal constant SLOT = keccak256("diamond.standard.diamond.storage");

    struct FacetAddressAndPosition {
        address facetAddress;
        uint96 functionSelectorPosition; // index into facetFunctionSelectors[facet]
    }

    struct FacetFunctionSelectors {
        bytes4[] functionSelectors;
        uint256 facetAddressPosition; // index into facetAddresses
    }

    struct Layout {
        mapping(bytes4 => FacetAddressAndPosition) selectorToFacetAndPosition;
        mapping(address => FacetFunctionSelectors) facetFunctionSelectors;
        address[] facetAddresses;
        mapping(bytes4 => bool) supportedInterfaces;
        /// @notice The address permitted to cut. Set once, in the diamond's
        /// constructor, to the deployer contract. Never settable afterwards —
        /// there is no `transferCutter`, by design.
        address cutter;
        /// @notice Set by `finalize` and never cleared. There is no code path
        /// anywhere in the diamond that writes `false` here.
        bool finalized;
        /// @notice True only under the `contracts/test` rehearsal deployer.
        bool devMode;
        /// @notice The manifest hash `finalize` verified the facet set against.
        bytes32 facetSetHash;
        uint256[16] __gap;
    }

    function layout() internal pure returns (Layout storage l) {
        bytes32 s = SLOT;
        assembly {
            l.slot := s
        }
    }
}

/// @notice The unified share token (design doc section 4: the diamond IS the share).
library ERC20Storage {
    bytes32 internal constant SLOT =
        keccak256(abi.encode(uint256(keccak256("marketplank.index.storage.erc20.v1")) - 1)) & ~bytes32(uint256(0xff));

    struct Layout {
        mapping(address => uint256) balances;
        mapping(address => mapping(address => uint256)) allowances;
        uint256 totalSupply;
        string name;
        string symbol;
        uint256[16] __gap;
    }

    function layout() internal pure returns (Layout storage l) {
        bytes32 s = SLOT;
        assembly {
            l.slot := s
        }
    }
}

/**
 * @notice Basket custody, the deferred-claim ledger, and the three values that
 * used to be `immutable`.
 *
 * @dev THE MIGRATED IMMUTABLES — `timelockDelay`, `seeder`, `dividendAsset`.
 * Under DELEGATECALL an `immutable` resolves to the value baked into whichever
 * FACET is executing, not the diamond, so two facets would silently disagree
 * about the timelock. They live here, are written exactly once by IndexDeployer
 * inside the deployment transaction, and no function in the finalized facet set
 * writes them again — which is what `Diamond.noWriteToImmutables.test.ts`
 * proves, and it is the replacement for the guarantee `immutable` used to give.
 */
library CoreStorage {
    bytes32 internal constant SLOT =
        keccak256(abi.encode(uint256(keccak256("marketplank.index.storage.core.v1")) - 1)) & ~bytes32(uint256(0xff));

    struct Layout {
        // --- migrated from `immutable`; written once by IndexDeployer ---
        uint256 timelockDelay;
        address seeder;
        address dividendAsset;
        // --- basket state (populated in Stage 2) ---
        bool indexOpen;
        uint256[16] __gap;
    }

    function layout() internal pure returns (Layout storage l) {
        bytes32 s = SLOT;
        assembly {
            l.slot := s
        }
    }
}

/// @notice The risk/fee parameter set and the eligibility bars.
library ParamsStorage {
    bytes32 internal constant SLOT =
        keccak256(abi.encode(uint256(keccak256("marketplank.index.storage.params.v1")) - 1)) & ~bytes32(uint256(0xff));

    struct Layout {
        uint256[16] __gap;
    }

    function layout() internal pure returns (Layout storage l) {
        bytes32 s = SLOT;
        assembly {
            l.slot := s
        }
    }
}

/// @notice Timelock queues for parameters, listings and the platform treasury.
library GovernanceStorage {
    bytes32 internal constant SLOT =
        keccak256(abi.encode(uint256(keccak256("marketplank.index.storage.governance.v1")) - 1))
            & ~bytes32(uint256(0xff));

    struct Layout {
        uint256[16] __gap;
    }

    function layout() internal pure returns (Layout storage l) {
        bytes32 s = SLOT;
        assembly {
            l.slot := s
        }
    }
}

/// @notice `roleHolder` / `queuedRoles` — the ScopedRoles registry, namespaced.
library RolesStorage {
    bytes32 internal constant SLOT =
        keccak256(abi.encode(uint256(keccak256("marketplank.index.storage.roles.v1")) - 1)) & ~bytes32(uint256(0xff));

    struct QueuedRole {
        address holder;
        uint64 eta;
        bool pending;
    }

    struct Layout {
        mapping(bytes32 => address) roleHolder;
        mapping(bytes32 => QueuedRole) queuedRoles;
        uint256[16] __gap;
    }

    function layout() internal pure returns (Layout storage l) {
        bytes32 s = SLOT;
        assembly {
            l.slot := s
        }
    }
}

/// @notice `platformTreasury` / `platformAllocationBps`.
library AllocationStorage {
    bytes32 internal constant SLOT =
        keccak256(abi.encode(uint256(keccak256("marketplank.index.storage.allocation.v1")) - 1))
            & ~bytes32(uint256(0xff));

    struct Layout {
        uint256[16] __gap;
    }

    function layout() internal pure returns (Layout storage l) {
        bytes32 s = SLOT;
        assembly {
            l.slot := s
        }
    }
}

/// @notice Ecosystem fee accrual and its sink.
library EcosystemStorage {
    bytes32 internal constant SLOT =
        keccak256(abi.encode(uint256(keccak256("marketplank.index.storage.ecosystem.v1")) - 1))
            & ~bytes32(uint256(0xff));

    struct Layout {
        uint256[16] __gap;
    }

    function layout() internal pure returns (Layout storage l) {
        bytes32 s = SLOT;
        assembly {
            l.slot := s
        }
    }
}

/**
 * @notice The EIP-2222 magnified-dividend accumulator. ONE asset, O(1).
 *
 * @dev Design doc section 5.4 rejects generalising this to a per-token map over
 * the stream set. The rejection is load-bearing here: keeping it one-asset is
 * exactly what keeps the ERC-20 transfer correction hook O(1) and unable to
 * brick a transfer.
 */
library DividendStorage {
    bytes32 internal constant SLOT =
        keccak256(abi.encode(uint256(keccak256("marketplank.index.storage.dividend.v1")) - 1)) & ~bytes32(uint256(0xff));

    struct Layout {
        uint256[16] __gap;
    }

    function layout() internal pure returns (Layout storage l) {
        bytes32 s = SLOT;
        assembly {
            l.slot := s
        }
    }
}

/**
 * @notice Reward streams and the round-9f re-vest schedule.
 *
 * @dev NO PER-HOLDER STATE, ever. WrappedIndexShare.sol's architectural rule
 * carries over verbatim, and design doc section 5.4 re-derives why: under a
 * backing-pool model an LP pool holding the share gets richer automatically,
 * whereas a per-holder accumulator makes the pool ADDRESS the accruer of record
 * and strands the value from the real holders behind it.
 */
library StreamStorage {
    bytes32 internal constant SLOT =
        keccak256(abi.encode(uint256(keccak256("marketplank.index.storage.stream.v1")) - 1)) & ~bytes32(uint256(0xff));

    struct Layout {
        uint256[16] __gap;
    }

    function layout() internal pure returns (Layout storage l) {
        bytes32 s = SLOT;
        assembly {
            l.slot := s
        }
    }
}

/// @notice Registered observe-only extension hooks (design doc section 8).
library HooksStorage {
    bytes32 internal constant SLOT =
        keccak256(abi.encode(uint256(keccak256("marketplank.index.storage.hooks.v1")) - 1)) & ~bytes32(uint256(0xff));

    struct Layout {
        uint256[16] __gap;
    }

    function layout() internal pure returns (Layout storage l) {
        bytes32 s = SLOT;
        assembly {
            l.slot := s
        }
    }
}

/**
 * @notice The single reentrancy word, shared by every facet.
 *
 * @dev This one is not a convenience. OpenZeppelin's ReentrancyGuard would put
 * a guard at slot 0 of each facet, which under DELEGATECALL all alias to the
 * SAME diamond slot 0 — colliding with the diamond's own table — and if that
 * were fixed naively by giving each facet its own namespace, `nonReentrant` on
 * facet A would no longer exclude a reentrant call into facet B. One shared
 * word makes the guard cross-facet, which is STRICTLY STRONGER than today's
 * per-contract guard, not merely equivalent.
 */
library ReentrancyStorage {
    bytes32 internal constant SLOT =
        keccak256(abi.encode(uint256(keccak256("marketplank.index.storage.reentrancy.v1")) - 1))
            & ~bytes32(uint256(0xff));

    uint256 internal constant NOT_ENTERED = 1;
    uint256 internal constant ENTERED = 2;

    struct Layout {
        uint256 status;
        uint256[16] __gap;
    }

    function layout() internal pure returns (Layout storage l) {
        bytes32 s = SLOT;
        assembly {
            l.slot := s
        }
    }
}
