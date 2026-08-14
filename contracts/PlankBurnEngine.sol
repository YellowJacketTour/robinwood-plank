// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ReentrancyGuard} from "@openzeppelin/contracts/security/ReentrancyGuard.sol";

interface IERC20Burnable {
    function balanceOf(address account) external view returns (uint256);
    function approve(address spender, uint256 amount) external returns (bool);
    function burn(uint256 amount) external;
}

interface IWETH {
    function deposit() external payable;
    function approve(address spender, uint256 amount) external returns (bool);
}

/// The minimal, CONSTRAINED swap surface this contract calls -- the
/// Uniswap V3 SwapRouter(02) `exactInput` shape. Critically this is NOT
/// the general Universal Router: it takes a typed swap with an
/// engine-chosen `recipient`, not an arbitrary caller-supplied command
/// program. That single difference is what makes redirection impossible
/// -- see the header.
interface ISwapRouter {
    struct ExactInputParams {
        bytes path;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
    }

    function exactInput(ExactInputParams calldata params) external payable returns (uint256 amountOut);
}

/**
 * PlankBurnEngine -- accumulates ETH earmarked for buyback-and-burn (fed
 * by PlankRakeDistributor) and permissionlessly converts it to real,
 * on-chain-burned $PLANK.
 *
 * SECURITY REWRITE (a real CRITICAL found in audit). The previous version
 * forwarded native ETH into the Uniswap UNIVERSAL ROUTER with a
 * caller-supplied command program and only checked the PLANK balance
 * delta. That was exploitable: the Universal Router's own SWEEP / TRANSFER
 * commands can pay the forwarded ETH to an arbitrary recipient, so an
 * attacker could swap dust to >= minPlankOut PLANK (satisfying the delta
 * check), SWEEP the rest of the ETH to themselves, and burn ~nothing --
 * draining the engine maxEthPerCall at a time. The balance-delta trick
 * cannot fix that, because the vulnerability is that a caller-controlled
 * command interpreter had CUSTODY of the engine's ETH.
 *
 * THE FIX -- the engine, never the caller, controls the destination:
 *   1. The engine wraps its OWN ETH into WETH.
 *   2. It approves the swap router for exactly that amount.
 *   3. It calls a CONSTRAINED exactInput swap with `recipient =
 *      address(this)` hardcoded -- the caller supplies ONLY the pool
 *      `path` and a `minPlankOut`, never a command program and never a
 *      recipient. The router pulls exactly the approved WETH and sends the
 *      output PLANK back to the engine; there is no SWEEP/TRANSFER lever,
 *      so the ETH cannot be redirected.
 *   4. The approval is reset to 0, the real received PLANK is measured,
 *      required to be >= minPlankOut, and 100% of it is burned.
 * The path is additionally validated to start at WETH and end at PLANK, so
 * a caller can't route the input somewhere else or receive a different
 * token. The worst a caller can now do is pick a bad pool (a poor price,
 * bounded by minPlankOut) -- they can never take custody of the ETH.
 *
 * DEPLOY REQUIREMENT, DISCLOSED HONESTLY: `swapRouter` MUST be a real,
 * confirmed exactInput-capable V3-style SwapRouter on the target chain
 * (NOT the general Universal Router -- that reintroduces the hole). This
 * was not independently confirmed as deployed on Robinhood Chain as part
 * of writing this, exactly like the VRF/Entropy contracts' own disclosed
 * deploy checks. Confirm it before mainnet.
 *
 * RESIDUAL (MEDIUM, disclosed): executeBurn pays keeperRewardBps of the
 * ETH spent to whoever calls it. A griefer can still repeatedly burn at a
 * self-set-low minPlankOut / poor price purely to farm that reward,
 * bleeding the queue at bad prices (though every call still burns real
 * PLANK). It is bounded by maxEthPerCall and by keeperRewardBps being
 * small; without a reliable on-chain PLANK price oracle (liquidity is
 * fragmented across many pools) a tighter on-chain fairness floor isn't
 * available. Keep keeperRewardBps small and maxEthPerCall modest.
 */
contract PlankBurnEngine is ReentrancyGuard {
    IERC20Burnable public immutable plank;
    ISwapRouter public immutable swapRouter;
    IWETH public immutable weth;

    uint256 public immutable maxEthPerCall;
    uint256 public immutable keeperRewardBps;

    uint256 public totalEthSpent;
    uint256 public totalPlankBurned;

    event BurnExecuted(address indexed caller, uint256 ethSpent, uint256 plankBurned, uint256 keeperReward);
    event Received(uint256 amount);

    error ZeroAddress();
    error NothingToBurn();
    error ExceedsRateLimit();
    error NoSwapOutput();
    error SlippageExceeded();
    error BadPath();
    error EthTransferFailed();

    constructor(
        address plank_,
        address swapRouter_,
        address weth_,
        uint256 maxEthPerCall_,
        uint256 keeperRewardBps_
    ) {
        if (plank_ == address(0) || swapRouter_ == address(0) || weth_ == address(0)) revert ZeroAddress();
        plank = IERC20Burnable(plank_);
        swapRouter = ISwapRouter(swapRouter_);
        weth = IWETH(weth_);
        maxEthPerCall = maxEthPerCall_;
        keeperRewardBps = keeperRewardBps_;
    }

    receive() external payable {
        emit Received(msg.value);
    }

    /**
     * Permissionless. Wraps `ethAmount` of the engine's own balance and
     * swaps it to $PLANK along the caller-supplied `path`, then burns 100%
     * of what comes back. The caller controls WHICH pools (`path`) and the
     * minimum acceptable output (`minPlankOut`); it can never control the
     * recipient (always this contract) -- see the header for why that's the
     * whole security model.
     *
     * @param path       a V3 swap path, WETH-in .. PLANK-out (validated).
     * @param ethAmount  how much of the engine's ETH to convert this call.
     * @param minPlankOut slippage floor; the swap must yield at least this.
     */
    function executeBurn(bytes calldata path, uint256 ethAmount, uint256 minPlankOut) external nonReentrant {
        if (ethAmount == 0 || ethAmount > address(this).balance) revert NothingToBurn();
        if (ethAmount > maxEthPerCall) revert ExceedsRateLimit();
        _validatePath(path);

        // 1. Wrap our own ETH and approve exactly what the swap will pull.
        weth.deposit{value: ethAmount}();
        weth.approve(address(swapRouter), ethAmount);

        // 2. Constrained swap: recipient is US, not the caller. The caller
        //    cannot express "send the ETH/output anywhere else".
        uint256 plankBefore = plank.balanceOf(address(this));
        swapRouter.exactInput(
            ISwapRouter.ExactInputParams({
                path: path,
                recipient: address(this),
                amountIn: ethAmount,
                amountOutMinimum: minPlankOut
            })
        );
        // 3. Belt-and-suspenders: drop any residual allowance, and trust
        //    the measured balance delta over the router's return value.
        weth.approve(address(swapRouter), 0);
        uint256 received = plank.balanceOf(address(this)) - plankBefore;
        if (received == 0) revert NoSwapOutput();
        if (received < minPlankOut) revert SlippageExceeded();

        // 4. Burn everything received.
        plank.burn(received);
        totalEthSpent += ethAmount;
        totalPlankBurned += received;

        uint256 keeperReward = (ethAmount * keeperRewardBps) / 10000;
        if (keeperReward > address(this).balance) keeperReward = address(this).balance;
        if (keeperReward > 0) {
            (bool ok, ) = msg.sender.call{value: keeperReward}("");
            if (!ok) revert EthTransferFailed();
        }

        emit BurnExecuted(msg.sender, ethAmount, received, keeperReward);
    }

    /// A V3 path is token(20) fee(3) token(20) [fee(3) token(20)]... . We
    /// require the input token to be WETH and the output token to be PLANK,
    /// so the caller can neither spend a different input nor receive a
    /// different output than the burn intends.
    function _validatePath(bytes calldata path) private view {
        // Smallest valid single-hop path: 20 + 3 + 20 = 43 bytes.
        if (path.length < 43 || (path.length - 20) % 23 != 0) revert BadPath();
        address first = address(bytes20(path[0:20]));
        address last = address(bytes20(path[path.length - 20:path.length]));
        if (first != address(weth) || last != address(plank)) revert BadPath();
    }
}
