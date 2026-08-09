// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

import {IExternalPlankLpRouter} from "../energy/adapters/PlankLpRenounceAdapter.sol";

/**
 * @notice Test-only stand-in for the real external PLANK/WETH liquidity
 * venue behind `IExternalPlankLpRouter` (PR7). Pulls `plankIn`/`wethIn` from
 * the caller, mints its own LP-shaped ERC-20 1:1 with `plankIn + wethIn`
 * (arbitrary but deterministic — the exact ratio is not load-bearing for
 * `PlankLpRenounceAdapter`'s own tests, only that a nonzero LP position
 * genuinely lands at `to`), and delivers it straight to `to`, mirroring
 * `MockExternalSwapRouter`'s own "mint the real thing to the real
 * destination" shape.
 *
 * A `Mode` switch lets the suite exercise the "the pool fails" side of the
 * doctrine (revert, deliver zero LP, or lie about output while leaving the
 * caller's approvals unspent) without a second contract.
 */
contract MockExternalPlankLpRouter is IExternalPlankLpRouter {
    using SafeERC20 for IERC20;

    enum Mode {
        OK, // pulls both legs, mints lpOut = plankIn + wethIn to `to`
        REVERT, // always reverts
        ZERO_LP, // pulls both legs, mints nothing
        NO_PULL // returns a nonzero amount WITHOUT ever pulling either leg
    }

    IERC20 public immutable plank;
    IERC20 public immutable weth;
    MockPlankLp public immutable lp;
    Mode public mode;

    event LiquidityAdded(uint256 plankIn, uint256 wethIn, uint256 lpOut, address indexed to);

    constructor(address plank_, address weth_) {
        plank = IERC20(plank_);
        weth = IERC20(weth_);
        lp = new MockPlankLp();
    }

    function setMode(Mode m) external {
        mode = m;
    }

    function addPlankLiquidity(
        uint256 plankIn,
        uint256 wethIn,
        uint256 minLpOut,
        address to
    ) external override returns (uint256 lpOut) {
        if (mode == Mode.REVERT) revert("MockExternalPlankLpRouter: reverting");

        if (mode == Mode.NO_PULL) {
            lpOut = plankIn + wethIn;
            require(lpOut >= minLpOut, "slippage");
            return lpOut;
        }

        plank.safeTransferFrom(msg.sender, address(this), plankIn);
        weth.safeTransferFrom(msg.sender, address(this), wethIn);

        if (mode == Mode.ZERO_LP) {
            return 0;
        }

        lpOut = plankIn + wethIn;
        require(lpOut >= minLpOut, "slippage");
        lp.mint(to, lpOut);
        emit LiquidityAdded(plankIn, wethIn, lpOut, to);
    }
}

contract MockPlankLp is ERC20 {
    constructor() ERC20("Mock PLANK/WETH LP", "mPLP") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
