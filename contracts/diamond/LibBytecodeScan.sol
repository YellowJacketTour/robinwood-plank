// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * ============================================================================
 *  LibBytecodeScan — the always-on facet opcode guard.
 *
 *  NOT FOR DEPLOYMENT. `internal` library, inlined into DiamondCutFacet.
 *
 *  WHAT IT REFUSES, AND WHY EACH ONE IS FATAL UNDER DELEGATECALL
 *  -------------------------------------------------------------
 *  SELFDESTRUCT (0xff). Executed under DELEGATECALL, SELFDESTRUCT destroys the
 *  CALLER — that is, the diamond itself, with every constituent reserve inside
 *  it. This is the single highest-severity mechanical risk the diamond
 *  introduces and the one that has no analogue in the pre-diamond design. A
 *  `paris` compile target does not emit it, but "the compiler does not emit it"
 *  is a statement about a compiler flag and this needs to be a statement about
 *  the bytes.
 *
 *  DELEGATECALL (0xf4). A facet that itself delegatecalls is a pivot: whatever
 *  it delegatecalls into is running in the DIAMOND's storage with the diamond's
 *  full authority, and the facet set no longer bounds what code can touch the
 *  namespaces. Design doc section 2.4's conversion of the five `public`
 *  libraries back to `internal` and this scan are ONE decision, not two — an
 *  external library call site emits 0xf4 and would (correctly) fail here.
 *
 *  WHY A LINEAR SWEEP IS EXACT, NOT APPROXIMATE
 *  --------------------------------------------
 *  The sweep skips PUSH immediates: at a PUSH1..PUSH32 it advances past the
 *  operand rather than parsing it as code. This is precisely the EVM's own
 *  jumpdest-analysis algorithm. That makes the guard sound in BOTH directions:
 *
 *   - no false positive, because a 0xff/0xf4 byte sitting inside PUSH data is
 *     skipped rather than reported;
 *   - and, more importantly, no false negative, because a byte inside PUSH data
 *     is by that same analysis not a valid JUMPDEST and therefore cannot be
 *     jumped to and executed. There is no way to smuggle a reachable
 *     SELFDESTRUCT past a correct sweep.
 *
 *  THE METADATA TRAILER
 *  --------------------
 *  solc appends a CBOR metadata blob, whose last two bytes are its own
 *  big-endian length. That blob is DATA — it holds hashes, so it will contain
 *  0xff and 0xf4 bytes routinely, and sweeping it as code would fail every
 *  facet. It is stripped by that length suffix before the sweep, with the
 *  strip bounded and sanity-checked; if the suffix is implausible the whole
 *  code is swept (fail-closed, never fail-open).
 * ============================================================================
 */
library LibBytecodeScan {
    /// @notice A facet contains SELFDESTRUCT at `offset` of its runtime code.
    error FacetContainsSelfdestruct(address facet, uint256 offset);
    /// @notice A facet contains DELEGATECALL at `offset` of its runtime code.
    error FacetContainsDelegatecall(address facet, uint256 offset);
    /// @notice A cut named an address with no deployed code.
    error FacetHasNoCode(address facet);

    uint8 private constant OP_DELEGATECALL = 0xf4;
    uint8 private constant OP_SELFDESTRUCT = 0xff;
    uint8 private constant OP_PUSH1 = 0x60;
    uint8 private constant OP_PUSH32 = 0x7f;

    /**
     * @notice Revert unless `facet`'s deployed code is free of SELFDESTRUCT and
     * DELEGATECALL. Called by DiamondCutFacet on every Add and Replace, so it
     * runs on every facet that is ever installed — including in the atomic
     * deployment transaction, which is the only cut that ever happens on a
     * production diamond.
     */
    function assertNoDangerousOpcodes(address facet) internal view {
        bytes memory code = facet.code;
        uint256 len = code.length;
        if (len == 0) revert FacetHasNoCode(facet);

        uint256 scanLen = _stripMetadata(code, len);

        // 0 = clean; 1 = selfdestruct; 2 = delegatecall.
        uint256 found;
        uint256 at;
        assembly ("memory-safe") {
            let p := add(code, 32)
            let end := add(p, scanLen)
            for {} lt(p, end) {} {
                let op := byte(0, mload(p))
                if eq(op, OP_SELFDESTRUCT) {
                    found := 1
                    at := sub(p, add(code, 32))
                    break
                }
                if eq(op, OP_DELEGATECALL) {
                    found := 2
                    at := sub(p, add(code, 32))
                    break
                }
                switch and(gt(op, 0x5f), lt(op, 0x80))
                // PUSHn: 1 opcode byte + (op - 0x5f) immediate bytes.
                case 1 { p := add(p, sub(op, 0x5e)) }
                default { p := add(p, 1) }
            }
        }

        if (found == 1) revert FacetContainsSelfdestruct(facet, at);
        if (found == 2) revert FacetContainsDelegatecall(facet, at);
    }

    /**
     * @dev Length of `code` with solc's CBOR metadata trailer removed.
     *
     * Fails CLOSED: any implausible suffix (longer than the code, or leaving
     * nothing to scan) returns the FULL length, so a facet with a mangled
     * trailer gets swept in its entirety and is rejected if that sweep trips.
     * The alternative — trusting the suffix — would let a facet declare an
     * enormous fake trailer and hide its whole body from the scan.
     */
    function _stripMetadata(bytes memory code, uint256 len) private pure returns (uint256) {
        if (len < 3) return len;
        uint256 metaLen = (uint256(uint8(code[len - 2])) << 8) | uint256(uint8(code[len - 1]));
        uint256 total = metaLen + 2;
        if (total >= len) return len;
        // solc's blob always starts with a CBOR map header (0xa1..0xa9). If the
        // byte at the computed start is not one, the suffix is not a metadata
        // length and must not be trusted.
        uint8 head = uint8(code[len - total]);
        if (head < 0xa1 || head > 0xa9) return len;
        return len - total;
    }
}
