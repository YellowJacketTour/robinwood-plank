// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Constituent} from "../../lib/IndexTypes.sol";
import {IndexParamSet} from "../../lib/IndexParams.sol";

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
        // --- basket custody ---
        /// @dev The one-way latch. False until `openIndex`; there is no path
        /// that sets it back, which is what makes `finalize`'s
        /// `indexOpen == false` precondition meaningful.
        bool indexOpen;
        address[] constituentList;
        /// @dev `Constituent` is a MAPPING VALUE, not a dynamic-array element,
        /// so appending a member to it is layout-safe: each key hashes to its
        /// own region. (Appending to a struct used as an ARRAY element would
        /// change the stride and shift every element.) It embeds
        /// `Observation obs[OBS_SLOTS]` — a fixed array inside a struct inside
        /// a mapping — which is layout-stable and unchanged from the monolith.
        mapping(address => Constituent) constituents;
        // --- the deferred-claim ledger ---
        /// @dev holder => token => owed. Under the unified token this ledger
        /// carries BOTH constituent legs that deferred during redemption and
        /// stream legs credited during it, which is what keeps the exit door's
        /// external-call count independent of the stream count.
        mapping(address => mapping(address => uint256)) pendingClaim;
        /// @dev token => total owed across all holders. Subtracted from every
        /// backing read, so a reserved slice cannot be redeemed a second time.
        mapping(address => uint256) reservedClaims;
        uint256 eligibleConstituentCount;
        /// @dev ERC-7575: asset => the registered per-asset entry point (Pipe).
        /// Reads as `address(0)` for every asset with no pipe registered, which
        /// `IndexShareFacet.vault()` reports as the diamond itself rather than
        /// as "unsupported". A pipe holds nothing and is not privileged — it can
        /// only call functions the diamond already exposes permissionlessly —
        /// so this map is a directory, never an authorisation.
        mapping(address => address) assetPipe;
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
        /// @dev Field order tracks `IndexParamSet` in lib/IndexParams.sol,
        /// which is the canonical declaration. Reordering it there silently
        /// reinterprets this region.
        IndexParamSet params;
        uint256 minEligibilityFeesWei;
        uint256 minEligibilityBlocks;
        uint256 targetHhiBps;
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

    struct QueuedParam {
        uint256 value;
        uint64 eta;
        bool pending;
    }

    struct QueuedListing {
        address source;
        uint256 rawTargetWeightBps;
        uint64 eta;
        bool pending;
        bool isRemoval;
    }

    struct Layout {
        /// @dev The shared queue mapping. `ScopedRoles.isolation` proves it is
        /// not a back door between roles; under the diamond that proof has to
        /// hold ACROSS FACETS too, since several facets now reach this one map.
        mapping(bytes32 => QueuedParam) queuedParams;
        mapping(address => QueuedListing) queuedListings;
        QueuedParam queuedPlatformTreasury;
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
        address platformTreasury;
        uint256 platformAllocationBps;
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
        /// @dev token => fees accrued, in that token's own units.
        mapping(address => uint256) ecosystemFeesWei;
        address ecosystemSink;
        address ecosystemAsset;
        uint256 ecosystemFeeSplitBps;
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
        uint256 magnifiedDividendPerShare;
        /// @dev The EIP-2222 correction term. SIGNED, deliberately: a mint adds
        /// a negative correction so a holder who arrives after a push earns
        /// exactly zero from it, and a burn adds a positive one so value
        /// already accrued is not destroyed.
        mapping(address => int256) magnifiedDividendCorrections;
        mapping(address => uint256) withdrawnDividends;
        uint256 totalDividendsReceived;
        uint256 totalDividendsWithdrawn;
        /// @dev The self-healing carry: a push with no eligible holder is
        /// PARKED here rather than lost or reverted.
        uint256 undistributedDividends;
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

    struct QueuedStream {
        uint64 eta;
        bool pending;
    }

    /// @dev The round-9f re-vest schedule, ported verbatim from
    /// WrappedIndexShare. `unvested` degrades linearly to zero between `last`
    /// and `end`; `unvestedOf` is a pure function of these three fields and
    /// `block.number`, with no setter anywhere and no role that can reach it.
    struct StreamVest {
        uint256 unvested;
        uint64 last;
        uint64 end;
    }

    struct Layout {
        address[] streamList;
        mapping(address => bool) tracked;
        mapping(address => bool) isStream;
        mapping(address => QueuedStream) queuedStreams;
        /// @dev The zero-denominator carry: value pushed while there is nobody
        /// to credit, held until there is.
        mapping(address => uint256) carry;
        uint256 carryUnlockBlock;
        mapping(address => StreamVest) vest;
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

    /// @dev A queued (not-yet-effective) hook registration, timelocked exactly
    /// like every other `ROLE_RISK_PARAM_`-gated risk-surface change (see
    /// `IndexGovernanceFacet.queueParam`/`executeParam`).
    struct QueuedHook {
        address hook;
        uint16 permissions;
        uint64 eta;
        bool pending;
    }

    struct Layout {
        /// @dev point => hook contract. `point` is drawn from a COMPILE-TIME
        /// enumerated set, so governance chooses who, never where — and that
        /// set contains no point on `redeemProRata`, `claimPending` or
        /// `claimPendingMany`.
        mapping(bytes32 => address) hooks;
        mapping(address => uint16) hookPermissions;
        /// @dev point => the queued registration awaiting `executeHook`.
        mapping(bytes32 => QueuedHook) queuedHooks;
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
