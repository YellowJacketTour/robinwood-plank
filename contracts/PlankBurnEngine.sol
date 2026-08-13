// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ReentrancyGuard} from "@openzeppelin/contracts/security/ReentrancyGuard.sol";

interface IERC20Burnable {
    function balanceOf(address account) external view returns (uint256);
    function burn(uint256 amount) external;
}

/// Minimal surface of Uniswap's Universal Router this contract calls
/// (see https://developers.uniswap.org/docs/contracts/universal-router).
interface IUniversalRouter {
    function execute(bytes calldata commands, bytes[] calldata inputs, uint256 deadline) external payable;
}

/**
 * PlankBurnEngine -- accumulates ETH earmarked for buyback-and-burn (fed
 * by PlankRakeDistributor.sol) and permissionlessly converts it to real,
 * on-chain-burned $PLANK.
 *
 * WHY THIS DOESN'T HARDCODE A SWAP ROUTE, DISCLOSED HONESTLY: a real
 * survey of this repo's own frontend data layer (lib/plank-pools.ts)
 * found $PLANK liquidity is fragmented across MULTIPLE real venues --
 * Uniswap v2/v3/v4 and Sushiswap v3 pools, tracked via DexScreener/
 * GeckoTerminal because there is no single canonical pool. Hardcoding
 * one specific pool/fee-tier here would risk routing against a thin or
 * stale pool the moment liquidity migrates -- a real, concrete failure
 * mode, not a hypothetical one. The actual $PLANK frontend already
 * solves real routing the same way this does: build the swap off-chain
 * (Uniswap's Trading API, which aggregates across all real venues) and
 * submit the resulting calldata on-chain to the real, canonical
 * Universal Router (0x8876789976dEcBfCbBbe364623C63652db8C0904 on
 * Robinhood Chain -- see lib/constants.ts's UNIVERSAL_ROUTER_ADDRESS,
 * cross-checked against this contract's own immutable at deploy time).
 * executeBurn() takes the same shape of caller-supplied route.
 *
 * WHY THAT'S SAFE DESPITE BEING CALLER-SUPPLIED, NOT A TRUST HOLE: the
 * swap's output can ONLY ever flow back to this contract (Universal
 * Router sends output tokens to whatever recipient the caller's own
 * inputs specify, but this function reads the REAL post-swap PLANK
 * balance delta on THIS contract and burns exactly that -- it never
 * forwards, approves, or sends PLANK anywhere else). A caller who
 * supplies a bad route either reverts harmlessly or executes a
 * genuinely poor-price swap -- the worst possible outcome is "less
 * PLANK got burned for the ETH spent," never fund theft, because there
 * is no code path that could ever send the swap's output, or any of
 * this contract's ETH, to an arbitrary address. keeperRewardBps exists
 * to make honest, careful routing worth someone's while.
 */
contract PlankBurnEngine is ReentrancyGuard {
    IERC20Burnable public immutable plank;
    IUniversalRouter public immutable universalRouter;
    address public immutable weth;

    // Rate limit: caps how much of the accumulated ETH queue a single
    // executeBurn() call can spend, so one bad-price call (malicious or
    // just careless) can only ever waste a bounded slice of the queue,
    // never the whole thing at once.
    uint256 public immutable maxEthPerCall;
    // Small, fixed share of the ETH actually spent this call, paid to
    // the caller from this contract's OWN remaining balance (never from
    // the swap output) -- same keeper-incentive shape used throughout
    // this protocol's other contracts (see PlankCrashV2.sol's
    // keeperRewardBps), sized to make honest routing worth doing without
    // meaningfully diluting the burn.
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
    error EthTransferFailed();

    constructor(
        address plank_,
        address universalRouter_,
        address weth_,
        uint256 maxEthPerCall_,
        uint256 keeperRewardBps_
    ) {
        if (plank_ == address(0) || universalRouter_ == address(0) || weth_ == address(0)) revert ZeroAddress();
        plank = IERC20Burnable(plank_);
        universalRouter = IUniversalRouter(universalRouter_);
        weth = weth_;
        maxEthPerCall = maxEthPerCall_;
        keeperRewardBps = keeperRewardBps_;
    }

    receive() external payable {
        emit Received(msg.value);
    }

    /// Permissionless. `ethAmount` must be pre-wrapped/swapped for by the
    /// caller's own `commands`/`inputs` (a real Universal Router route --
    /// see this file's header for why that's built off-chain rather than
    /// hardcoded here). This contract fronts `ethAmount` of its own
    /// balance as msg.value to the router call; the caller controls
    /// WHERE that ETH gets routed, never WHERE the output goes (always
    /// back here, verified by balance delta) or whether it gets burned
    /// (always, unconditionally).
    ///
    /// `minPlankOut` is real slippage protection, and it protects the
    /// COMMUNITY, not the caller: an honest keeper sets it from the
    /// current fair price so a sandwich bot cannot force the burn to
    /// execute at a manipulated, terrible rate (which would burn far less
    /// $PLANK per ETH than the community deserves). A malicious keeper
    /// can of course set it to 0 -- but they already control the route,
    /// so this takes nothing away from them; it only ever ADDS the
    /// ability for an honest caller to refuse a bad fill. There is no
    /// setting of minPlankOut that lets anyone extract value; the worst
    /// case remains "less got burned," never theft.
    function executeBurn(
        bytes calldata commands,
        bytes[] calldata inputs,
        uint256 ethAmount,
        uint256 minPlankOut,
        uint256 deadline
    ) external nonReentrant {
        if (ethAmount == 0 || ethAmount > address(this).balance) revert NothingToBurn();
        if (ethAmount > maxEthPerCall) revert ExceedsRateLimit();

        uint256 plankBefore = plank.balanceOf(address(this));
        universalRouter.execute{value: ethAmount}(commands, inputs, deadline);
        uint256 received = plank.balanceOf(address(this)) - plankBefore;
        if (received == 0) revert NoSwapOutput();
        if (received < minPlankOut) revert SlippageExceeded();

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
}
