// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @notice Test-only constituent that exposes a REALIZABLE CURVE, i.e. the
 * `quoteSellShares`/`quoteBuyShares` pair `CollectionVault` exposes, backed by
 * a settable virtual constant-product pool.
 *
 * WHY THIS MOCK EXISTS RATHER THAN REUSING `MockIndexToken`. The point of
 * design §1.2 is the GAP between the spot mark `s·x/y` and the realizable
 * integral `x·s/(y+s)`. `MockIndexToken` has no pool, so it exposes no curve
 * and prices exactly as it always did — which is what keeps the pre-existing
 * suites meaningful, but also means they cannot exercise the new behaviour at
 * all. This one can be given a deliberately THIN pool, where realizable is a
 * small fraction of the mark, so a test can prove the cap actually binds.
 *
 * `lieMultiplier` exists for the one adversarial claim that matters most:
 * `IndexRealizable` asks an UNTRUSTED address about itself, and the safety
 * argument is that every caller uses the answer as a `min` cap. Setting a
 * multiplier of 1000x lets a test prove that a constituent lying UPWARD about
 * its own realizable depth gains exactly nothing.
 *
 * LOCAL HARDHAT ONLY. Never deployed anywhere real.
 */
contract MockRealizableIndexToken is ERC20 {
    /// @notice Payment-token side of the virtual pool, in wei.
    uint256 public paymentReserve;
    /// @notice Share side of the virtual pool, in base units.
    uint256 public shareReserve;
    /// @notice Multiplies every quote. 1 = honest. >1 = lying upward.
    uint256 public lieMultiplier = 1;
    /// @notice When true, both quote functions revert — the "constituent
    /// exposes a curve but it is broken" case, which must degrade to the
    /// band pricing rather than bricking a mint.
    bool public quotesRevert;

    constructor(string memory n, string memory s) ERC20(n, s) {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setPool(uint256 payment_, uint256 share_) external {
        paymentReserve = payment_;
        shareReserve = share_;
    }

    function setLieMultiplier(uint256 m) external {
        lieMultiplier = m;
    }

    function setQuotesRevert(bool v) external {
        quotesRevert = v;
    }

    /// @notice `x·s / (y + s)` — the constant-product output, exactly what
    /// `CollectionVault.quoteSellShares` computes (fee omitted; the gap this
    /// mock exists to exercise is the IMPACT term, not the fee term).
    function quoteSellShares(uint256 sharesIn) public view returns (uint256) {
        require(!quotesRevert, "quotes off");
        if (shareReserve == 0 || paymentReserve == 0 || sharesIn == 0) return 0;
        return (paymentReserve * sharesIn * lieMultiplier) / (shareReserve + sharesIn);
    }

    /// @notice `y·a / (x + a)` — the other direction.
    function quoteBuyShares(uint256 amountIn) public view returns (uint256) {
        require(!quotesRevert, "quotes off");
        if (shareReserve == 0 || paymentReserve == 0 || amountIn == 0) return 0;
        return (shareReserve * amountIn * lieMultiplier) / (paymentReserve + amountIn);
    }
}
