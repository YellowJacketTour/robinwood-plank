// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IEligibilitySource} from "../IEligibilitySource.sol";

/**
 * ============================================================================
 *  IndexEligibility — the gas-capped, fail-closed constituent read
 *
 *  Extracted from GlobalIndexVault.sol under the rule IndexParams.sol's header
 *  states: a body large relative to (call sites x stub). This one is a
 *  hand-rolled `staticcall` with its own encode, its own returndata-length
 *  guard and its own decode, done twice, reached from two places.
 *
 *  A NARROWER SAFETY CLAIM THAN THE OTHER TWO LIBRARIES, STATED HONESTLY.
 *  IndexMath and IndexParams are `pure`, so the delegatecall the compiler
 *  emits provably cannot touch the vault's storage. These functions are
 *  `view`, not `pure`, because they make a `staticcall` — so the compiler's
 *  guarantee here is weaker: they cannot WRITE anything, cannot emit, and
 *  cannot make a state-changing call, but a `view` function running under
 *  delegatecall could in principle READ the caller's storage.
 *
 *  These do not, and that is checkable by reading forty lines: every input is
 *  an explicit argument, no storage variable is declared in this file, and no
 *  storage slot is named anywhere in it. The write half of the hazard — the
 *  half that actually matters for a delegatecall — is closed by the compiler;
 *  the read half is closed by inspection of a deliberately tiny surface.
 * ============================================================================
 */
library IndexEligibility {
    /**
     * @notice Is `constituent` eligible, by its OWN on-chain fee accounting?
     *
     * Reads `IEligibilitySource` directly off the constituent. That interface
     * is a getter over state the constituent vault already maintains for its
     * own purposes — it is not an oracle, not a submission, and not a number
     * any privileged caller can type in. There is no admin override and no
     * stored per-constituent eligibility flag: the answer is recomputed from
     * the constituent's books every time it is asked.
     *
     * FAILS CLOSED, ALWAYS, AND NEVER REVERTS THE CALLER. The read is a
     * gas-capped low-level `staticcall`, so every failure mode a hostile or
     * merely-old constituent can produce — no code at the address, no such
     * selector, an outright revert, short or undecodable returndata, or an
     * attempt to burn the caller's whole gas budget — resolves to
     * `(false, 0, 0)`. A constituent that does not implement the interface at
     * all is simply not eligible; it does not brick the basket, it does not
     * brick a recount, and it keeps every redemption path it already had.
     *
     * NO WALLET-COUNT SIGNAL EXISTS HERE, ON PURPOSE. See IEligibilitySource's
     * header: address-cardinality is not sybil-resistant without identity, and
     * a bar an attacker can set for themselves is not a bar. Fee revenue is
     * the harder-to-fake proxy, and the claim made for it is bounded — faking
     * it costs real wash volume, continuously, over `minBlocks`.
     */
    function checkEligibility(
        address constituent,
        uint256 minFeesWei,
        uint256 minBlocks,
        uint256 gasCap
    ) internal view returns (bool eligible, uint256 feesWei, uint256 elapsedBlocks) {
        (bool okFees, uint256 fees) = _readUint(
            constituent,
            IEligibilitySource.totalFeesCollectedWei.selector,
            gasCap
        );
        if (!okFees) return (false, 0, 0);
        feesWei = fees;

        (bool okFirst, uint256 firstBlock) = _readUint(
            constituent,
            IEligibilitySource.firstActivityBlock.selector,
            gasCap
        );
        if (!okFirst) return (false, feesWei, 0);
        if (firstBlock == 0 || firstBlock > block.number) return (false, feesWei, 0);

        elapsedBlocks = block.number - firstBlock;
        eligible = feesWei >= minFeesWei && elapsedBlocks >= minBlocks;
    }

    /**
     * @dev One gas-capped, fail-closed uint256 getter read. Returns
     * `(false, 0)` for every failure mode rather than propagating any of them.
     *
     * A low-level `staticcall` rather than `try/catch` DELIBERATELY: a `try`
     * on a call that SUCCEEDS but returns undecodable data raises in the
     * CALLING contract and is NOT caught by the `catch` clause. That is
     * precisely the fail-OPEN case this read has to rule out, so the decode is
     * guarded by hand instead.
     */
    function _readUint(address target, bytes4 selector, uint256 gasCap)
        private
        view
        returns (bool ok, uint256 value)
    {
        if (target.code.length == 0) return (false, 0);
        (bool success, bytes memory data) = target.staticcall{gas: gasCap}(
            abi.encodeWithSelector(selector)
        );
        if (!success || data.length < 32) return (false, 0);
        return (true, abi.decode(data, (uint256)));
    }
}
