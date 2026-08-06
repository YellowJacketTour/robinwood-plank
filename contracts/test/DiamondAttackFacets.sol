// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * ============================================================================
 *  TEST ONLY. Facets that are exactly as dangerous as the design doc says, so
 *  the guards can be proven to FIRE rather than merely to exist.
 *
 *  A guard that has never been observed rejecting anything is indistinguishable
 *  from a comment. Each contract here is the minimal real instance of one of
 *  the failure modes in design doc section 6.4.
 * ============================================================================
 */

/**
 * @notice Contains SELFDESTRUCT. Installed as a facet and called, this would
 * destroy the DIAMOND — not itself — taking every constituent reserve with it.
 * The single highest-severity mechanical risk the diamond introduces.
 *
 * @dev `paris` still assembles SELFDESTRUCT; EIP-6780 changes its semantics on
 * Cancun+, not its opcode. The scan is on the byte, so it is indifferent to
 * which of those is true on the target chain — which is the point of scanning
 * bytes rather than trusting an evmVersion flag.
 */
contract SelfdestructFacet {
    function boom(address payable to) external {
        selfdestruct(to);
    }
}

/**
 * @notice Contains DELEGATECALL. Installed as a facet, this is a pivot: it runs
 * ARBITRARY caller-supplied code in the diamond's storage with the diamond's
 * authority, and the finalized facet set stops bounding what can touch the
 * namespaces.
 */
contract DelegatecallFacet {
    function pivot(address target, bytes calldata data) external returns (bool ok) {
        (ok,) = target.delegatecall(data);
    }
}

/**
 * @notice Contains an external `public` library call — which the compiler emits
 * as DELEGATECALL. This is the case design doc section 2.4 calls out: the
 * opcode scan and the "convert the five libraries back to `internal`" decision
 * are ONE decision, and this facet is the proof that they are coupled rather
 * than merely adjacent.
 */
library ExternalPublicLibrary {
    function double(uint256 x) public pure returns (uint256) {
        return x * 2;
    }
}

contract ExternalLibraryFacet {
    function doubled(uint256 x) external pure returns (uint256) {
        return ExternalPublicLibrary.double(x);
    }
}

/**
 * @notice Declares a state variable in its own body — the storage-collision
 * failure mode. Under DELEGATECALL `slot0` IS the diamond's slot 0, which is
 * where the EIP-2535 selector table's first mapping lives.
 *
 * @dev This one is NOT caught by the opcode scan (there is no opcode for "I
 * declared a variable") and is not meant to be. It is caught by
 * Diamond.bytecode.test.ts reading the compiler's `storageLayout` output. It
 * lives here so that test has something real to reject.
 */
contract StateVariableFacet {
    uint256 public slot0;
    mapping(address => uint256) public slot1;

    function clobber(uint256 v) external {
        slot0 = v;
    }
}

/**
 * @notice Clean: no SELFDESTRUCT, no DELEGATECALL, no state variables. The
 * negative control, so a passing scan is known to be a real pass and not a
 * scanner that rejects everything.
 */
contract CleanFacet {
    function ok() external pure returns (uint256) {
        return 42;
    }

    function alsoOk(bytes calldata data) external pure returns (bytes32) {
        return keccak256(data);
    }
}

/**
 * @notice Clean, but its code contains the BYTES 0xff and 0xf4 inside PUSH
 * immediates. This is the false-positive control: a naive byte-frequency scan
 * rejects this contract, and a correct PUSH-skipping sweep accepts it.
 *
 * @dev Without this control, "the scan rejects the evil facets" would be
 * equally consistent with a scanner that rejects every contract, and the guard
 * would be useless in the only way that matters — it would make the real
 * facets un-installable.
 */
contract PushDataFacet {
    function constants() external pure returns (uint256 a, uint256 b, bytes32 c) {
        a = 0xff;
        b = 0xf4;
        c = bytes32(uint256(0xfffff4f4fffff4f4fffff4f4fffff4f4fffff4f4fffff4f4fffff4f4fffff4f4));
    }
}
