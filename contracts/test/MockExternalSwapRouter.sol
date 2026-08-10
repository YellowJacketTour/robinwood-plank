// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IExternalSwapRouter} from "../IExternalSwapRouter.sol";

/**
 * @notice Test-only stand-in for the real PLANK venue behind
 * `IExternalSwapRouter` (§7.11, design doc DESIGN-N-VAULT-FACTORY-AND-
 * VALUE-ACCRUAL-2026-08-06.md §7.11). Mints its own PLANK-shaped ERC-20 at a
 * fixed rate against whatever `tokenIn` it is handed, so `IndexDevFundFacet.
 * test.ts` can exercise a real end-to-end swap without depending on any
 * cross-repo liquidity.
 *
 * A `Mode` switch lets the suite exercise the "the router fails" side of the
 * task brief's doctrine (§7.11 point 4: a broken PLANK-buy step must never
 * block or revert the underlying mint) without a second contract.
 */
contract MockExternalSwapRouter is IExternalSwapRouter {
    using SafeERC20 for IERC20;

    enum Mode {
        OK, // pulls amountIn, mints plankOut = amountIn * rate / 1e18 to `to`
        REVERT, // always reverts
        SHORT_MINT, // pulls amountIn, mints nothing — leaves the standing approval unspent by THIS call, but never actually consumes it either, which is exactly the "short delivery" shape `_routeDevFundBuy` must catch
        NO_PULL // returns a nonzero amount WITHOUT ever calling transferFrom — simulates a router that lies about output while leaving the caller's approval untouched (also caught by the leftover-allowance check)
    }

    ERC20 public immutable plank;
    Mode public mode;
    uint256 public rate; // plankOut = amountIn * rate / 1e18

    event Bought(address indexed tokenIn, uint256 amountIn, uint256 plankOut, address indexed to);

    constructor(uint256 rate_) {
        plank = new MockPlank();
        rate = rate_ == 0 ? 1e18 : rate_;
    }

    function setMode(Mode m) external {
        mode = m;
    }

    function setRate(uint256 r) external {
        rate = r;
    }

    function buyPlank(
        address tokenIn,
        uint256 amountIn,
        uint256 minPlankOut,
        address to
    ) external override returns (uint256 plankOut) {
        if (mode == Mode.REVERT) revert("MockExternalSwapRouter: reverting");
        if (mode == Mode.NO_PULL) {
            // Never pulls tokenIn, never spends the approval — the leftover-
            // allowance check in `_routeDevFundBuy` is what has to catch this.
            plankOut = (amountIn * rate) / 1e18;
            require(plankOut >= minPlankOut, "slippage");
            return plankOut;
        }

        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);

        if (mode == Mode.SHORT_MINT) {
            // Pulled the input, minted nothing back — a genuinely bad trade,
            // not a caller-side bug. `_routeDevFundBuy` does not price-check
            // the output (§7.11 sets no such guarantee at this layer, the
            // caller passes `minPlankOut = 0`), so this "succeeds" from the
            // interface's point of view; it exists to document that a
            // dev-fund buy is NOT price-protected per-call today (the
            // governed ceiling and treasury discipline are the safeguards,
            // not a per-trade slippage floor the mint path enforces).
            return 0;
        }

        plankOut = (amountIn * rate) / 1e18;
        require(plankOut >= minPlankOut, "slippage");
        MockPlank(address(plank)).mint(to, plankOut);
        emit Bought(tokenIn, amountIn, plankOut, to);
    }
}

contract MockPlank is ERC20 {
    constructor() ERC20("Mock PLANK", "mPLANK") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
