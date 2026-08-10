// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title IEligibilitySource
 * @notice The ONE shape a Global Index constituent must expose to be
 * ELIGIBILITY-checked, mirroring IIndexPriceSource's discipline exactly:
 * deliberately minimal, and every number on it is state the constituent
 * ALREADY tracks for its own accounting.
 *
 * WHY THIS IS NOT AN ORACLE
 * -------------------------
 * `IIndexPriceSource` prices a constituent by reading the constituent's own
 * real reserves — "math over other vaults' math, all the way down", never a
 * number a human enters. This interface is the same move applied to
 * eligibility. `totalFeesCollectedWei()` is a getter over fee revenue the
 * constituent vault has ALREADY accrued on-chain in the course of its own
 * swaps; `firstActivityBlock()` is the block its own first real interaction
 * landed in. Neither is submitted, attested, signed, or relayed. There is no
 * new trust assumption: a constituent that lies here is a constituent that has
 * lied about its own internal accounting, which is exactly the same trust
 * boundary the index already crosses when it reads that vault's reserves to
 * price it.
 *
 * WHY FEE REVENUE, AND WHY NO WALLET COUNT
 * ----------------------------------------
 * An earlier draft of the eligibility signal paired fee revenue with a
 * "distinct holder/wallet count" bar. That signal is DELIBERATELY DROPPED and
 * must not be reintroduced. There is no production-proven, sybil-resistant,
 * identity-free method of counting distinct humans by counting distinct
 * addresses on a permissionless EVM chain — the cost of manufacturing an extra
 * "wallet" is one `CREATE` and a dust transfer, so a wallet-count bar is a bar
 * an attacker sets for themselves. It is the same finding PlankGauge.sol
 * already documents for sqrt burn-splitting, and the honest conclusion is the
 * same: without an identity layer, address-cardinality is not a signal.
 *
 * Fee revenue is the correct proxy precisely because faking it is not free.
 * To manufacture fee revenue a constituent must route real volume through its
 * own pool and pay its own fee on both legs — i.e. wash trading with a
 * strictly negative expected value, repeated over `minEligibilityBlocks`
 * worth of chain time. That does not make it unfakeable; it makes it
 * EXPENSIVE and CONTINUOUS, which is the most an oracle-free on-chain
 * eligibility signal can honestly claim. Stated plainly rather than
 * overclaimed: this raises the price of a fake constituent, it does not make
 * one impossible.
 *
 * FAIL-CLOSED IS THE CONSUMER'S JOB
 * ---------------------------------
 * A constituent that does not implement this interface at all is NOT
 * eligible, and asking it must never revert the caller. GlobalIndexVault's
 * `checkEligibility` therefore reads this interface through a gas-capped
 * low-level `staticcall` and treats every failure mode — no code, wrong
 * selector, revert, short returndata — as "not eligible", never as an error.
 */
interface IEligibilitySource {
    /// @notice Lifetime fee revenue this constituent has itself collected, in
    /// ETH wei. Monotone non-decreasing in an honest implementation.
    function totalFeesCollectedWei() external view returns (uint256);

    /// @notice The block number of this constituent's first real activity.
    /// Zero means "never active", which reads as not eligible.
    function firstActivityBlock() external view returns (uint256);
}
