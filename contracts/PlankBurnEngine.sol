// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ReentrancyGuard} from "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import {PlankV2TwapOracle} from "./PlankV2TwapOracle.sol";

interface IERC20Burnable {
    function balanceOf(address account) external view returns (uint256);
    function burn(uint256 amount) external;
}

interface IUniswapV2Router {
    function swapExactETHForTokens(
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external payable returns (uint256[] memory amounts);
}

/**
 * PlankBurnEngine -- accumulates ETH earmarked for buyback-and-burn (fed
 * by PlankRakeDistributor) and permissionlessly converts it to real,
 * on-chain-burned $PLANK, at a FAIR price that no caller can rig.
 *
 * This is the Tier-2, fully-trustless design. Two independent, previously
 * separate risks are both closed here on-chain, with nothing left to the
 * caller's honesty:
 *
 *   1. REDIRECTION (was CRITICAL). The engine never hands a
 *      caller-controlled command program custody of the ETH. It swaps
 *      through the canonical Uniswap V2 router with `to = address(this)`
 *      and a fixed [WETH, PLANK] path -- the caller supplies neither a
 *      recipient nor a route, so the output can only ever come back here
 *      to be burned.
 *
 *   2. BAD-PRICE / SANDWICH (was MEDIUM). The minimum acceptable output
 *      is NOT supplied by the caller. It is computed on-chain from a
 *      manipulation-resistant TWAP of the deepest $PLANK/WETH pool
 *      (PlankV2TwapOracle) -- floor = fairOut * (1 - maxSlippage). A
 *      sandwicher can't force a rigged rate, because a single block of
 *      manipulation barely moves a time-averaged price, and the swap is
 *      rejected if it clears less than the fair floor. This is the CoW/
 *      Milkman "price checker" pattern: execution venue and price oracle
 *      are the SAME deep pool, so the two can't be played against each
 *      other.
 *
 * The caller therefore controls only ONE thing: whether to trigger a burn
 * of up to maxEthPerCall right now. Everything about where the ETH goes
 * and what price is acceptable is fixed by the contract. The permissionless
 * keeper reward makes triggering worth someone's gas.
 *
 * LIVENESS DEPENDENCY, DISCLOSED: burns require a fresh TWAP. The oracle's
 * update() must be called at least once per window (the keeper does this
 * in its loop); if the oracle is unprimed or stale, consult() reverts and
 * a burn simply can't run until it's refreshed -- ETH is never at risk,
 * the burn just waits. See PlankV2TwapOracle.
 *
 * DEPLOY REQUIREMENT: `v2Router`, `weth`, and the oracle's `pair` MUST be
 * the real, confirmed Uniswap V2 router / WETH / canonical deep
 * PLANK-WETH pair on the target chain. Confirm these on-chain before
 * mainnet (they are all immutable).
 */
contract PlankBurnEngine is ReentrancyGuard {
    IERC20Burnable public immutable plank;
    IUniswapV2Router public immutable v2Router;
    address public immutable weth;
    PlankV2TwapOracle public immutable oracle;

    uint256 public immutable maxEthPerCall;
    uint256 public immutable keeperRewardBps;
    /// How far below the TWAP the executed swap may land before it's
    /// rejected. Capped hard so it can never be set so loose that the
    /// floor becomes meaningless.
    uint256 public immutable maxSlippageBps;
    uint256 private constant MAX_SLIPPAGE_CEILING_BPS = 1000; // 10%
    // The keeper reward is a SEPARATE ETH payout from the engine's balance
    // (not the buyback proceeds), so an unbounded value would let whoever
    // wins the keeper race drain the pool. Hard-capped -- it only needs to
    // cover gas plus a small incentive.
    uint256 private constant MAX_KEEPER_REWARD_CEILING_BPS = 200; // 2%

    uint256 public totalEthSpent;
    uint256 public totalPlankBurned;

    event BurnExecuted(address indexed caller, uint256 ethSpent, uint256 plankBurned, uint256 fairFloor, uint256 keeperReward);
    event Received(uint256 amount);

    error ZeroAddress();
    error BadConfig();
    error NothingToBurn();
    error ExceedsRateLimit();
    error NoSwapOutput();
    error BelowFairFloor();
    error EthTransferFailed();

    constructor(
        address plank_,
        address v2Router_,
        address weth_,
        address oracle_,
        uint256 maxEthPerCall_,
        uint256 keeperRewardBps_,
        uint256 maxSlippageBps_
    ) {
        if (plank_ == address(0) || v2Router_ == address(0) || weth_ == address(0) || oracle_ == address(0)) {
            revert ZeroAddress();
        }
        if (maxSlippageBps_ > MAX_SLIPPAGE_CEILING_BPS || keeperRewardBps_ > MAX_KEEPER_REWARD_CEILING_BPS) {
            revert BadConfig();
        }
        plank = IERC20Burnable(plank_);
        v2Router = IUniswapV2Router(v2Router_);
        weth = weth_;
        oracle = PlankV2TwapOracle(oracle_);
        maxEthPerCall = maxEthPerCall_;
        keeperRewardBps = keeperRewardBps_;
        maxSlippageBps = maxSlippageBps_;
    }

    receive() external payable {
        emit Received(msg.value);
    }

    /**
     * Permissionless. Converts `ethAmount` of the engine's own balance to
     * $PLANK at no worse than the TWAP-derived fair floor, and burns 100%
     * of what comes back. The caller supplies ONLY the amount -- never a
     * route, a recipient, or a minimum-output -- so it can neither redirect
     * the ETH nor accept a rigged price. See the header.
     */
    function executeBurn(uint256 ethAmount) external nonReentrant {
        if (ethAmount == 0 || ethAmount > address(this).balance) revert NothingToBurn();
        if (ethAmount > maxEthPerCall) revert ExceedsRateLimit();

        // Fair floor from the manipulation-resistant TWAP. consult() reverts
        // if the oracle is unprimed or stale -- the burn then simply can't
        // run until the keeper refreshes it, and no ETH moves.
        uint256 fairOut = oracle.consult(weth, ethAmount);
        uint256 floor = (fairOut * (10000 - maxSlippageBps)) / 10000;

        address[] memory path = new address[](2);
        path[0] = weth;
        path[1] = address(plank);

        uint256 plankBefore = plank.balanceOf(address(this));
        // Engine sets recipient (this) and amountOutMin (floor). The router
        // wraps the ETH and swaps along the fixed path; nothing here is
        // caller-controlled.
        v2Router.swapExactETHForTokens{value: ethAmount}(floor, path, address(this), block.timestamp);
        uint256 received = plank.balanceOf(address(this)) - plankBefore;
        if (received == 0) revert NoSwapOutput();
        // Redundant with the router's own amountOutMin, kept as belt-and-
        // suspenders against a non-standard router.
        if (received < floor) revert BelowFairFloor();

        plank.burn(received);
        totalEthSpent += ethAmount;
        totalPlankBurned += received;

        uint256 keeperReward = (ethAmount * keeperRewardBps) / 10000;
        if (keeperReward > address(this).balance) keeperReward = address(this).balance;
        if (keeperReward > 0) {
            (bool ok, ) = msg.sender.call{value: keeperReward}("");
            if (!ok) revert EthTransferFailed();
        }

        emit BurnExecuted(msg.sender, ethAmount, received, floor, keeperReward);
    }
}
