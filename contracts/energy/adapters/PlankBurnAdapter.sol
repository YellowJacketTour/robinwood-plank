// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {IEnergyAdapter} from "../IEnergyAdapter.sol";
import {IExternalSwapRouter} from "../../IExternalSwapRouter.sol";

/// @dev Minimal read of `EnergyBus.finalized()` — the same one-way freeze
/// `IdxBurnAdapter`/`DividendAdapter` rely on for their own doctrine, reused
/// here to gate this adapter's own governed `router` pointer: `DESIGN-AUDIT-
/// AXIOM-1-2026-08-08.md`'s P3 row is explicit that the PLANK router is only
/// ever timelock-settable BEFORE the Bus finalizes, never after.
interface IBusFinalized {
    function finalized() external view returns (bool);
}

/**
 * ============================================================================
 *  PlankBurnAdapter — Pipe P of the AXIOM-1 Energy Bus (ONESHOT §4.1
 *  `PLANK_BURN_BPS = 1000`; ONESHOT §5.5, §7 PR7 row; SPEC §2.6).
 *
 *  PLANK IS EXTERNAL (do not reread this and go build a token). The real
 *  PLANK market lives in the live `robinwood-plank` product, not this repo —
 *  see `IExternalSwapRouter.sol`'s own header. This adapter buys it exactly
 *  the way `IndexFacetBase._routeDevFundBuy` (§7.11) already does: spend an
 *  already-held ERC-20 (here, WETH) against a governed external router,
 *  deliver the output straight to a fixed destination, never hold PLANK
 *  itself. The one difference from §7.11's dev-fund buy is the destination —
 *  `BURN_ADDRESS` here, a spendable treasury there — which is why this is a
 *  new, small adapter rather than a call into `_routeDevFundBuy`: reusing
 *  that function would require this adapter to be a Diamond facet with
 *  `DevFundStorage` access, not a standalone Bus pipe.
 *
 *  BURN_ADDRESS is the SAME literal `0x000000000000000000000000000000000000
 *  dEaD` this codebase already uses everywhere a permanent, unreachable sink
 *  is needed — `IndexFacetBase.SEED_LOCK_ADDR`, `CollectionVault.
 *  LP_LOCK_ADDR`, `PlankGauge.BURN_ADDRESS` — reused verbatim, not a new
 *  address. No receipt, no claim, no LP, no vote — PLANK routed here is
 *  simply gone from circulating supply, exactly like every other burn this
 *  codebase performs at that address.
 *
 *  GOVERNANCE. `router` starts unset (`address(0)`) — a safe default,
 *  because the real PLANK venue may not exist yet at genesis (SPEC §0's own
 *  "External PLANK router" note). It is set ONLY through a timelocked
 *  queue/execute pair (`IndexDevFundFacet`'s own shape, reused here rather
 *  than reinvented — queue by `governance`, execute by anyone once
 *  `timelockDelay` has elapsed), and ONLY before the Bus finalizes — the
 *  exact "Timelock router pre-finalize only" line `DESIGN-AUDIT-AXIOM-1-
 *  2026-08-08.md`'s P3 row asks for. `governance` itself is immutable, set
 *  once at construction, so THIS adapter's own privileged pointer can never
 *  be handed to a new address after deploy — only WHAT the router points to
 *  can move, on the same timelocked schedule as every other risk-surface
 *  change in this codebase, never instant and silent.
 *
 *  NEVER REVERTS (critical constraint, this PR's own brief, same doctrine as
 *  every other adapter in this directory). Three recoverable conditions are
 *  all treated identically — the WHOLE `amountIn` is refunded to the Bus
 *  (which routes it to Pipe D, never to any admin-controlled address, per
 *  `IEnergyAdapter`'s own contract):
 *   (1) no router configured yet (pre-launch default state);
 *   (2) the router call reverts outright;
 *   (3) the router call "succeeds" but delivers zero PLANK, or leaves a
 *       standing approval unspent — the same short-delivery detection
 *       `_routeDevFundBuy` already proves, reused verbatim here.
 *  `execute()` itself only ever reverts for the genuine programming-
 *  invariant violation of being called by something other than the Bus.
 * ============================================================================
 */
contract PlankBurnAdapter is IEnergyAdapter {
    using SafeERC20 for IERC20;

    /// @notice Same dead address this repo already uses everywhere for a
    /// permanent, unreachable sink — see header.
    address public constant BURN_ADDRESS = 0x000000000000000000000000000000000000dEaD;

    /// @notice WETH — the sole payment token this pipe ever receives.
    IERC20 public immutable weth;
    /// @notice The one EnergyBus this adapter will ever accept `execute` from.
    address public immutable bus;
    /// @notice The sole address ever allowed to queue a new `router`. Never
    /// changeable itself — see header.
    address public immutable governance;
    /// @notice Fixed delay between `queueRouter` and `executeRouter`.
    uint256 public immutable timelockDelay;

    /// @notice The governed external PLANK-buy venue. `address(0)` (the
    /// genesis default) means "no venue configured yet" — a safe skip, never
    /// a revert (see header).
    address public router;

    struct QueuedAddress {
        address value;
        uint64 eta;
        bool pending;
    }

    QueuedAddress public queuedRouter;

    event RouterQueued(address indexed router, uint64 eta);
    event RouterSet(address indexed router);
    event PlankBurned(uint256 wethIn, uint256 plankOut);
    event PlankBurnSkipped(uint256 wethIn);

    error ZeroAddress();
    error NotBus();
    error NotGovernance();
    error NothingQueued();
    error TimelockNotElapsed();
    error BusAlreadyFinalized();

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

    // ── Governed router, timelocked, pre-finalize only (see header) ────────

    function queueRouter(address router_) external onlyGovernance preFinalizeOnly {
        uint64 eta = uint64(block.timestamp + timelockDelay);
        queuedRouter = QueuedAddress({value: router_, eta: eta, pending: true});
        emit RouterQueued(router_, eta);
    }

    function executeRouter() external preFinalizeOnly {
        QueuedAddress memory q = queuedRouter;
        if (!q.pending) revert NothingQueued();
        if (block.timestamp < q.eta) revert TimelockNotElapsed();
        delete queuedRouter;
        router = q.value;
        emit RouterSet(q.value);
    }

    // ── Pipe P ───────────────────────────────────────────────────────────

    function execute(uint256 amountIn) external override onlyBus returns (uint256 used, bool skipped) {
        if (amountIn == 0) return (0, false);

        address r = router;
        if (r == address(0)) {
            // No venue configured (realistic pre-launch state) — graceful
            // skip, whole slice back to the Bus, which routes it to Pipe D.
            weth.safeTransfer(msg.sender, amountIn);
            emit PlankBurnSkipped(amountIn);
            return (0, true);
        }

        weth.forceApprove(r, amountIn);
        try IExternalSwapRouter(r).buyPlank(address(weth), amountIn, 0, BURN_ADDRESS) returns (uint256 plankOut) {
            // Same short-delivery / leftover-allowance detection
            // `_routeDevFundBuy` already proves — a router that did not fully
            // spend its approval, or delivered zero PLANK, is treated
            // identically to an outright revert.
            if (weth.allowance(address(this), r) != 0 || plankOut == 0) {
                weth.forceApprove(r, 0);
                emit PlankBurnSkipped(amountIn);
                skipped = true;
            } else {
                emit PlankBurned(amountIn, plankOut);
                used = amountIn;
                return (used, false);
            }
        } catch {
            weth.forceApprove(r, 0);
            emit PlankBurnSkipped(amountIn);
            skipped = true;
        }

        // Balance-based refund, not a blind `amountIn` transfer: a router
        // that reported failure AFTER already pulling some or all of its
        // approval via `transferFrom` (e.g. the SHORT_MINT shape) may have
        // left this adapter holding LESS than `amountIn` — refunding a
        // nominal `amountIn` in that case would revert on insufficient
        // balance, which is exactly the "never reverts on a recoverable
        // failure" constraint this adapter must not violate. Only what is
        // actually still held is returned to the Bus; whatever the router
        // genuinely consumed is gone (the router itself, not this adapter,
        // is where that risk lives — identical to `_routeDevFundBuy`'s own
        // documented "only a router that fully spends AND delivers is ever
        // treated as a genuine buy" doctrine).
        // AUDIT C-1: never return more than we received — see the identical
        // guard in InventoryBuyAdapter. A raw-balance refund lets a donation
        // underflow the Bus's delta arithmetic and brick `route()` forever.
        uint256 leftover = weth.balanceOf(address(this));
        if (leftover > amountIn) leftover = amountIn;
        if (leftover > 0) {
            weth.safeTransfer(msg.sender, leftover);
        }
        used = 0;
    }
}
