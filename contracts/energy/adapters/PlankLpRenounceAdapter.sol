// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {IEnergyAdapter} from "../IEnergyAdapter.sol";
import {IExternalSwapRouter} from "../../IExternalSwapRouter.sol";

/// @dev Same finalize-read this directory's other governed pointer
/// (`PlankBurnAdapter.router`) uses — see that contract's header.
interface IBusFinalized {
    function finalized() external view returns (bool);
}

/**
 * @notice §7's own residual-risk note (`DESIGN-AUDIT-AXIOM-1-2026-08-08.md`
 * P5 row: "P5 PLANK LP renounce | Pipe R | Canonical pool address |
 * Construct-time immutable" — extended here to timelock-settable per this
 * PR's own brief) is explicit: this repo has no PLANK/WETH pool of its own,
 * PLANK's real liquidity venue lives in the external `robinwood-plank`
 * product, and the exact venue may not exist yet at genesis. This interface
 * is therefore deliberately the smallest shape a real PLANK/WETH liquidity
 * venue needs to satisfy — mirrored on `IExternalSwapRouter.buyPlank`'s own
 * shape rather than invented fresh — so the mechanism is real and
 * end-to-end testable in THIS repo's suite against a mock, without a live
 * cross-repo integration.
 *
 * Unlike a generic AMM router's `addLiquidity`, this never returns LP tokens
 * to the caller to forward on: the pool mints/transfers the resulting LP
 * position DIRECTLY to `to`, the same "deliver straight to the final
 * destination, never round-trip through the caller" shape `buyPlank`
 * already uses for the dev-fund buy and `PlankBurnAdapter` reuses for the
 * burn destination — here, `to` is always `LP_LOCK_ADDR`, so the LP position
 * is permanently, unwithdrawably locked in the exact same call that creates
 * it; no intermediate step ever holds it on this adapter's own balance.
 */
interface IExternalPlankLpRouter {
    /**
     * @notice Add `plankIn` PLANK + `wethIn` WETH (both already approved to
     * this pool by the caller, for exactly these amounts) as balanced
     * liquidity to the canonical PLANK/WETH venue, delivering the resulting
     * LP position directly to `to`.
     * @param minLpOut the caller's own slippage floor.
     * @return lpOut the amount of LP position actually delivered to `to`.
     */
    function addPlankLiquidity(
        uint256 plankIn,
        uint256 wethIn,
        uint256 minLpOut,
        address to
    ) external returns (uint256 lpOut);
}

/**
 * ============================================================================
 *  PlankLpRenounceAdapter — Pipe R of the AXIOM-1 Energy Bus (ONESHOT §4.1
 *  `PLANK_LP_BPS = 1000`; ONESHOT §7 PR7 row: "POL; harvest → more PLANK
 *  burn + Bus"; SPEC §2.7).
 *
 *  PLANK IS EXTERNAL, same doctrine as `PlankBurnAdapter` — see that
 *  contract's header and `IExternalSwapRouter.sol`. There is no PLANK token
 *  and no PLANK/WETH pool deployed by this repo; both the buy venue
 *  (`swapRouter`) and the liquidity venue (`lpPool`), plus the external
 *  PLANK token address itself (`plankToken`, needed only so this adapter can
 *  `approve` it — the interface never needs to know it beyond that), are
 *  GOVERNED, TIMELOCK-SETTABLE pointers, bundled into one queue/execute pair
 *  (`ONESHOT`'s own instruction: "configurable, timelock-settable ...
 *  governed, same queue/execute pattern as everywhere else"), gated
 *  pre-finalize only, exactly like `PlankBurnAdapter.router`.
 *
 *  THE MECHANISM, one call: split `amountIn` WETH in half, buy PLANK with
 *  one half through `swapRouter` (`IExternalSwapRouter.buyPlank`, the SAME
 *  call shape `PlankBurnAdapter`/`IndexFacetBase._routeDevFundBuy` already
 *  use), then add the bought PLANK plus the other WETH half as balanced
 *  liquidity to `lpPool`, with the resulting LP position delivered STRAIGHT
 *  to `LP_LOCK_ADDR` — the SAME dead address `CollectionVault.LP_LOCK_ADDR`
 *  / `IndexFacetBase.SEED_LOCK_ADDR` already prove permanently
 *  unwithdrawable: nobody, including this adapter or governance, ever holds
 *  a private key for it, so an LP position minted there is locked by the
 *  exact same mechanism the genesis LP floor already uses, not a new or
 *  weaker one. "Harvest → more PLANK burn + Bus" (ONESHOT §7's own words for
 *  this pipe) describes what happens to swap fees the LOCKED LP position
 *  keeps earning over time on the external venue — this adapter has nothing
 *  further to do about that per-call; the position itself is where those
 *  fees accrue, exactly like `CollectionVault`'s own genesis LP floor.
 *
 *  UNCONFIGURED POOL -> GRACEFUL SKIP, NEVER A FORCED FAKE INTERACTION (this
 *  PR's own explicit instruction). If `swapRouter`, `plankToken` or `lpPool`
 *  is still `address(0)` (the genesis default, and the realistic pre-launch
 *  state SPEC §0 itself calls out), `execute()` returns the WHOLE `amountIn`
 *  to the Bus untouched, which routes it to Pipe D like any other skip — no
 *  swap is attempted, no pool is probed, nothing is faked.
 *
 *  ATOMIC PER-CALL UNWIND (same `try this.selfCall(...)` shape
 *  `InventoryBuyAdapter.buyLeg` already proves). The buy-then-LP sequence
 *  lives in `_addPlankLiquidity`, invoked via `try this._addPlankLiquidity`
 *  so ANY failure anywhere in the sequence — the swap reverting, delivering
 *  zero PLANK, the LP pool reverting, delivering zero LP — unwinds the
 *  ENTIRE attempt atomically (Solidity's own external-call revert
 *  semantics), guaranteeing the WETH this adapter received is refunded to
 *  the Bus WHOLE, never partially spent, never stranded mid-sequence.
 *
 *  NEVER REVERTS (critical constraint, this PR's own brief, same doctrine as
 *  every other adapter in this directory). `execute()` itself only ever
 *  reverts for the genuine programming-invariant violation of being called
 *  by something other than the Bus.
 * ============================================================================
 */
contract PlankLpRenounceAdapter is IEnergyAdapter {
    using SafeERC20 for IERC20;

    /// @notice Same dead address `CollectionVault.LP_LOCK_ADDR` /
    /// `IndexFacetBase.SEED_LOCK_ADDR` already use for a permanently
    /// unwithdrawable LP/lock destination — see header.
    address public constant LP_LOCK_ADDR = 0x000000000000000000000000000000000000dEaD;

    /// @notice WETH — the sole payment token this pipe ever receives.
    IERC20 public immutable weth;
    /// @notice The one EnergyBus this adapter will ever accept `execute` from.
    address public immutable bus;
    /// @notice The sole address ever allowed to queue a new config. Never
    /// changeable itself — see header.
    address public immutable governance;
    /// @notice Fixed delay between `queueConfig` and `executeConfig`.
    uint256 public immutable timelockDelay;

    /// @notice Governed external PLANK-buy venue (same interface
    /// `PlankBurnAdapter.router` uses). `address(0)` = not configured.
    address public swapRouter;
    /// @notice Governed external PLANK ERC-20 address (needed only so this
    /// adapter can `approve` it to `lpPool`). `address(0)` = not configured.
    address public plankToken;
    /// @notice Governed external PLANK/WETH liquidity venue. `address(0)` =
    /// not configured — the realistic pre-launch state (see header).
    address public lpPool;

    struct QueuedConfig {
        address swapRouter;
        address plankToken;
        address lpPool;
        uint64 eta;
        bool pending;
    }

    QueuedConfig public queuedConfig;

    event ConfigQueued(address indexed swapRouter, address indexed plankToken, address indexed lpPool, uint64 eta);
    event ConfigSet(address indexed swapRouter, address indexed plankToken, address indexed lpPool);
    event PlankLpAdded(uint256 wethIn, uint256 plankBought, uint256 lpOut);
    event PlankLpSkipped(uint256 wethIn);

    error ZeroAddress();
    error NotBus();
    error NotSelf();
    error NotGovernance();
    error NothingQueued();
    error TimelockNotElapsed();
    error BusAlreadyFinalized();
    error NoPlankBought();
    error NoLpMinted();

    constructor(address weth_, address bus_, address governance_, uint256 timelockDelay_) {
        if (weth_ == address(0) || bus_ == address(0) || governance_ == address(0)) revert ZeroAddress();
        weth = IERC20(weth_);
        bus = bus_;
        governance = governance_;
        timelockDelay = timelockDelay_;
    }

    modifier onlyBus() {
        if (msg.sender != bus) revert NotBus();
        _;
    }

    modifier onlyGovernance() {
        if (msg.sender != governance) revert NotGovernance();
        _;
    }

    modifier preFinalizeOnly() {
        if (IBusFinalized(bus).finalized()) revert BusAlreadyFinalized();
        _;
    }

    // ── Governed config, timelocked, pre-finalize only (see header) ────────
    // Bundled into one struct — `swapRouter`/`plankToken`/`lpPool` are only
    // ever meaningful together (the venue and the token it trades are one
    // deployment decision), so one queue/execute pair rather than three
    // avoids a window where only some of the three are set.

    function queueConfig(address swapRouter_, address plankToken_, address lpPool_)
        external
        onlyGovernance
        preFinalizeOnly
    {
        uint64 eta = uint64(block.timestamp + timelockDelay);
        queuedConfig = QueuedConfig({
            swapRouter: swapRouter_,
            plankToken: plankToken_,
            lpPool: lpPool_,
            eta: eta,
            pending: true
        });
        emit ConfigQueued(swapRouter_, plankToken_, lpPool_, eta);
    }

    function executeConfig() external preFinalizeOnly {
        QueuedConfig memory q = queuedConfig;
        if (!q.pending) revert NothingQueued();
        if (block.timestamp < q.eta) revert TimelockNotElapsed();
        delete queuedConfig;
        swapRouter = q.swapRouter;
        plankToken = q.plankToken;
        lpPool = q.lpPool;
        emit ConfigSet(q.swapRouter, q.plankToken, q.lpPool);
    }

    // ── Pipe R ───────────────────────────────────────────────────────────

    function execute(uint256 amountIn) external override onlyBus returns (uint256 used, bool skipped) {
        if (amountIn == 0) return (0, false);

        if (swapRouter == address(0) || plankToken == address(0) || lpPool == address(0)) {
            // No PLANK/WETH venue configured yet (realistic pre-launch
            // state) — graceful skip, whole slice back to the Bus, which
            // routes it to Pipe D. Never a forced fake pool interaction.
            weth.safeTransfer(msg.sender, amountIn);
            emit PlankLpSkipped(amountIn);
            return (0, true);
        }

        try this._addPlankLiquidity(amountIn) returns (uint256 plankBought, uint256 lpOut) {
            emit PlankLpAdded(amountIn, plankBought, lpOut);
            used = amountIn;
            skipped = false;
        } catch {
            // Whole attempt unwound atomically — `amountIn` still sits in
            // this adapter's own WETH balance, refunded to the Bus below.
            emit PlankLpSkipped(amountIn);
            used = 0;
            skipped = true;
        }

        // Balance-based, not self-report-based: refund whatever this
        // adapter is NOT holding zero of after the attempt above, matching
        // `IEnergyAdapter`'s own contract and the Bus's own "trust only
        // observed deltas" doctrine.
        uint256 leftover = weth.balanceOf(address(this));
        if (leftover > 0) {
            weth.safeTransfer(msg.sender, leftover);
            if (used >= leftover) {
                used -= leftover;
            } else {
                used = 0;
            }
        }
    }

    /**
     * @notice One atomic buy-then-LP attempt. `external`, callable only by
     * this contract itself (`try this._addPlankLiquidity(...)` from
     * `execute`), the same self-call shape `InventoryBuyAdapter.buyLeg`
     * already proves — never a genuine external entry point despite the
     * visibility.
     */
    function _addPlankLiquidity(uint256 amountIn) external returns (uint256 plankBought, uint256 lpOut) {
        if (msg.sender != address(this)) revert NotSelf();

        uint256 wethForBuy = amountIn / 2;
        uint256 wethForLp = amountIn - wethForBuy;

        weth.forceApprove(swapRouter, wethForBuy);
        plankBought = IExternalSwapRouter(swapRouter).buyPlank(address(weth), wethForBuy, 0, address(this));
        weth.forceApprove(swapRouter, 0);
        if (plankBought == 0) revert NoPlankBought();

        IERC20(plankToken).forceApprove(lpPool, plankBought);
        weth.forceApprove(lpPool, wethForLp);
        lpOut = IExternalPlankLpRouter(lpPool).addPlankLiquidity(plankBought, wethForLp, 0, LP_LOCK_ADDR);
        IERC20(plankToken).forceApprove(lpPool, 0);
        weth.forceApprove(lpPool, 0);
        if (lpOut == 0) revert NoLpMinted();
    }
}
