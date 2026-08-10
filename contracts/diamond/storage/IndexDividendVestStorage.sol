// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/**
 * ============================================================================
 *  DividendVestStorage — the dividend leg's maturity vest (audit H-2/H-3).
 *
 *  NOT FOR DEPLOYMENT. A diamond-storage namespace plus the pure arithmetic
 *  that operates on it. It declares its own slot and touches nothing else, so
 *  it can be added without editing `IndexStorage.sol`.
 *
 *  WHY THIS EXISTS
 *  ---------------
 *  `IndexFacetBase._creditRoutedValue` split routed value three ways and
 *  treated the three legs inconsistently:
 *
 *      reserveShare  -> c.reserve, AND `_addReserveVest` (300-block vest)
 *      buybackShare  -> an earmark nobody can claim pro-rata
 *      dividendShare -> `_creditDividends`, INSTANTLY, UNVESTED
 *
 *  The dividend leg is the one that credits per-share to whoever holds shares
 *  AT THE MOMENT OF THE CREDIT. And `IndexCoreFacet.mintProRata` fires
 *  `_attemptOpportunisticReconcile` AFTER it mints — so an attacker's own
 *  mint triggers the credit that accrues to the shares that mint just
 *  created. The whole sequence is atomic:
 *
 *      mint -> (opportunistic reconcile) -> credit accrues to the new shares
 *           -> redeemProRata (the free, deliberately unblockable exit door)
 *           -> claimDividend
 *
 *  The redeemer keeps their accrued dividend by design (the correction term
 *  moves with the burn — see `IndexDividendFacet`'s header), so the exit does
 *  not surrender it. Profitability is one inequality: the attacker captures
 *  `dividendBps` of the routed value in proportion to the supply they briefly
 *  owned, and pays back only their pro-rata slice of `reserveShare`. It clears
 *  whenever `dividendBps > BPS - dividendBps - buybackBps`, and
 *  `dividendBps = 10000` was legal, at which point the entire routed value is
 *  snipeable with a flash-minted position.
 *
 *  THE FIX IS THE ONE THIS CODEBASE ALREADY OWNS. Structurally the same
 *  `unvested`/`last`/`end` linear release as `_addVest` (streams) and
 *  `_addReserveVest` (constituent reserves), applied to the dividend leg —
 *  the third and last unvested value inlet. Freshly-routed dividend value is
 *  HELD (it never enters the accumulator, so it accrues to nobody) and
 *  matures linearly over `STREAM_VEST_BLOCKS`. An attacker who mints, routes
 *  and redeems inside one transaction sees `releasable() == 0` exactly,
 *  because zero blocks have elapsed, and captures nothing. Holding the
 *  position long enough to capture the vest is no longer an atomic snipe —
 *  it is being a holder, which is the behaviour dividends are FOR.
 *
 *  CONSERVATION. The held value is never lost, never refused and never
 *  reverted: `pending` only ever falls by exactly what `take` returns, and
 *  `take` returns exactly what has matured. It is a delay, not a haircut.
 *
 *  THE ACCOUNTING OBLIGATION THIS CREATES. Value sitting in `pending` is in
 *  the diamond's ERC-20 balance but NOT yet in `DividendStorage`'s
 *  received/withdrawn ledger, so `IndexFacetBase._reconcileCore`'s `accounted`
 *  subtotal MUST include `DividendVestStorage.pending()` or the very next
 *  `_sync` would observe it as fresh surplus and route it a second time,
 *  forever. That one line is the invariant this file depends on; see
 *  `IndexDividendFacet`'s header for the exact required text.
 * ============================================================================
 */
library DividendVestStorage {
    /// @dev Its own namespace, derived the same way every other layout in
    /// this diamond derives one. Collides with nothing because nothing else
    /// hashes this string.
    bytes32 internal constant SLOT = keccak256("marketplank.index.dividendvest.v1");

    struct Layout {
        /// @dev Total routed dividend value HELD here and not yet pushed into
        /// the accumulator. Always >= `unvestedNow()`.
        uint256 pending;
        /// @dev The displaced principal of the current window.
        uint256 unvested;
        /// @dev Window start / end, in BLOCKS — blocks, not timestamps, for
        /// the same reason `_addVest` uses them: a validator can nudge a
        /// timestamp, and cannot mint blocks.
        uint64 last;
        uint64 end;
    }

    function layout() internal pure returns (Layout storage l) {
        bytes32 s = SLOT;
        assembly {
            l.slot := s
        }
    }

    /// @dev Byte-for-byte the shape of `IndexFacetBase._reserveUnvestedOf`.
    /// `last < end` always holds because `add` writes them together as
    /// `(n, n + vestBlocks)` with `vestBlocks > 0`.
    function unvestedNow() internal view returns (uint256) {
        Layout storage l = layout();
        uint256 u = l.unvested;
        if (u == 0) return 0;
        uint256 end_ = l.end;
        if (block.number >= end_) return 0;
        return Math.mulDiv(u, end_ - block.number, end_ - l.last);
    }

    /// @notice Everything held, matured or not. This is the figure
    /// `_reconcileCore` must treat as already accounted for.
    function pending() internal view returns (uint256) {
        return layout().pending;
    }

    /// @notice What has matured and may be pushed into the accumulator now.
    /// Zero in the same block as the credit, which is the whole point.
    function releasable() internal view returns (uint256) {
        uint256 p = layout().pending;
        uint256 u = unvestedNow();
        return p > u ? p - u : 0;
    }

    /// @dev Displace `amount` and re-arm the window. Commits the release so
    /// far implicitly: `unvested` is re-based on `unvestedNow()`, so value
    /// already matured but not yet taken stays matured (it is `pending` in
    /// excess of the new `unvested`) rather than being re-locked by a later
    /// credit. A late credit therefore cannot retroactively freeze an earlier
    /// one — that would be a griefing vector, and it is closed by
    /// construction here rather than by a check.
    function add(uint256 amount, uint256 vestBlocks) internal {
        if (amount == 0) return;
        Layout storage l = layout();
        l.unvested = unvestedNow() + amount;
        l.last = uint64(block.number);
        l.end = uint64(block.number + vestBlocks);
        l.pending += amount;
    }

    /// @dev Draw down the matured portion. The ONE writer that reduces
    /// `pending`, and it can never take more than has matured.
    function take() internal returns (uint256 amount) {
        amount = releasable();
        if (amount == 0) return 0;
        layout().pending -= amount;
    }
}
