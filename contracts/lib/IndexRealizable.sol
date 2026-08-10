// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * ============================================================================
 *  IndexRealizable — the realizable-integral price, read off the constituent's
 *  OWN curve. Design §1.2/§1.3.
 *
 *  THE ONE IDEA. If the index holds `s` shares of a constituent whose pool is
 *  `(x` payment, `y` shares`)`, the SPOT MARK is `s·x/y` and the amount the
 *  index could actually receive is
 *
 *      realizable(s) = x·s / (y + s)
 *
 *  The two are equal only in the limit `s → 0`. Hold shares equal to the pool's
 *  own reserve and realizable is exactly HALF the mark. That gap is the D2
 *  illusion NFTX shipped and then killed, quantified in one line, computed by
 *  the same constant-product formula the AMM itself uses. No oracle, no new
 *  trust assumption, no parameter.
 *
 *  WHY WE ASK THE TOKEN RATHER THAN RE-DERIVING IT. `CollectionVault` already
 *  exposes `quoteSellShares`/`quoteBuyShares`, which are the vault's own
 *  `sellShares`/`buyShares` bodies run as views — fee-inclusive, impact-
 *  inclusive, and guaranteed to agree with what an actual swap would pay,
 *  because they ARE that code. Re-deriving the curve here would introduce a
 *  second definition that could drift from the first, which is exactly the
 *  failure mode audit C-2 was (a "no-impact reference" that was in fact the
 *  constant-product output, so the guard could never fire at any size).
 *
 *  WHY IT IS SAFE TO ASK AN UNTRUSTED ADDRESS. Every caller uses these quotes
 *  as a CAP — `min(conservative band value, realizable)` — never as the value
 *  itself. A hostile token can therefore only ever make its own deposit credit
 *  LESS, or its own exit pay LESS. Lying upward buys nothing; lying downward is
 *  self-harm. That is what makes this input trust-free, and it is why the
 *  provenance registry (`IndexProvenanceStorage`) guards ADMISSION rather than
 *  pricing: the two mechanisms answer different questions and neither is
 *  load-bearing for the other.
 *
 *  MECHANICAL SAFETY. `staticcall` (never `call`, never `delegatecall`) at
 *  bounded gas, return data length-checked before decoding, failure reported as
 *  `ok == false` and never as a revert. A constituent that does not implement
 *  the interface, reverts, returns junk, or burns its stipend is indistinguish-
 *  able from "no curve available", and every caller falls back to the band
 *  pricing it already used. Nothing here can revert a mint, a redeem, or —
 *  most importantly — anything on the free exit door, which does not reach
 *  this file at all.
 * ============================================================================
 */
library IndexRealizable {
    /// @dev Generous enough for a real `CollectionVault` view (a handful of
    /// SLOADs and some mulDiv), small enough that a hostile constituent
    /// cannot starve the caller: EIP-150's 63/64 rule leaves the caller at
    /// least 1/64 of its gas regardless, and this cap makes the absolute loss
    /// bounded too.
    uint256 internal constant QUOTE_GAS = 120_000;

    // Selectors are built with `abi.encodeWithSignature` at each call site
    // rather than hard-coded as `bytes4` constants. A mistyped constant would
    // fail SILENTLY here — every quote would come back `ok == false` and the
    // whole realizable-cap layer would quietly stop binding while every test
    // still passed. Letting the compiler hash the signature makes that class
    // of failure impossible.

    /**
     * @notice Payment-token amount `token` would ACTUALLY pay right now for
     * `amount` of itself — impact- and fee-inclusive.
     * @return out the realizable amount; meaningless unless `ok`.
     * @return ok false when `token` exposes no realizable curve at all (not a
     * `CollectionVault`, or an EOA, or reverting). Callers MUST treat
     * `ok == false` as "no information" and fall back, never as "worth zero" —
     * the payment token itself is the obvious member of that set and is worth
     * exactly its face value.
     */
    function sellQuote(address token, uint256 amount) internal view returns (uint256 out, bool ok) {
        if (amount == 0) return (0, false);
        return _ask(token, abi.encodeWithSignature("quoteSellShares(uint256)", amount));
    }

    /**
     * @notice Shares `amount` of payment token would ACTUALLY buy right now.
     * Used to convert an exit's non-target legs into target units at a price
     * the index could genuinely transact at, rather than at a mark.
     */
    function buyQuote(address token, uint256 amount) internal view returns (uint256 out, bool ok) {
        if (amount == 0) return (0, false);
        return _ask(token, abi.encodeWithSignature("quoteBuyShares(uint256)", amount));
    }

    /// @dev The one call site. `token.code.length == 0` is checked first
    /// because a staticcall to an address with no code SUCCEEDS with empty
    /// return data, and an unchecked `abi.decode` of empty data reverts —
    /// which would turn "constituent is an EOA" into a bricked mint.
    function _ask(address token, bytes memory payload) private view returns (uint256 out, bool ok) {
        if (token.code.length == 0) return (0, false);
        (bool success, bytes memory data) = token.staticcall{gas: QUOTE_GAS}(payload);
        if (!success || data.length < 32) return (0, false);
        out = abi.decode(data, (uint256));
        ok = true;
    }

    /**
     * @notice `value` capped at what is realizable, when a curve exists.
     * @dev THE canonical combinator, so no caller re-implements the direction
     * of the `min` and gets it backwards. There is exactly one honest
     * direction: a settlement price may only ever be revised DOWN toward what
     * is payable.
     */
    function capBySell(address token, uint256 amount, uint256 value) internal view returns (uint256) {
        (uint256 real, bool ok) = sellQuote(token, amount);
        if (!ok) return value;
        return real < value ? real : value;
    }

    /// @notice `units` capped at what `payment` of payment token could
    /// actually BUY of `token`. Same direction rule as `capBySell`.
    function capByBuy(address token, uint256 payment, uint256 units) internal view returns (uint256) {
        (uint256 real, bool ok) = buyQuote(token, payment);
        if (!ok) return units;
        return real < units ? real : units;
    }
}
