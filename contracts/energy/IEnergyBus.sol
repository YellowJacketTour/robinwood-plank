// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * ============================================================================
 *  IEnergyBus — PR2 of the AXIOM-1 stack (ONESHOT §7, SPEC §2.1).
 *
 *  Immutable WETH splitter into 6 pipes (LOCKED genesis bps, ONESHOT §4.1):
 *
 *    INV_BPS         = 3500  // Pipe I — buy collection share into L2 by weight
 *    CLP_BPS         = 1500  // Pipe L — collection POL + harvest compound
 *    IDX_BURN_BPS    = 1500  // Pipe X — buy IDX -> lock/burn
 *    PLANK_BURN_BPS  = 1000  // Pipe P — buy PLANK -> burn
 *    PLANK_LP_BPS    = 1000  // Pipe R — PLANK POL
 *    DIV_BPS         = 1500  // Pipe D — DRIP default reinvest
 *
 *  `route()` is permissionless (§6.8). Only observed balance deltas are ever
 *  credited (§6.2) — nothing here trusts a self-reported amount. Adapter
 *  skip on impact/failure routes the remainder to Pipe D, never to any
 *  admin-controlled address (§6.7). The Bus uses CALL only, never
 *  DELEGATECALL (§6.6). `TRUSTED_CAP_BPS = 0` — no spendable team treasury
 *  lives inside the Bus (§0, §6).
 * ============================================================================
 */
interface IEnergyBus {
    event Credited(address indexed from, uint256 amount, uint256 balanceAfter);
    event Routed(
        address indexed caller,
        uint256 total,
        uint256 inv,
        uint256 clp,
        uint256 idxBurn,
        uint256 plankBurn,
        uint256 plankLp,
        uint256 div
    );
    event AdapterSkipped(uint8 indexed pipe, uint256 amount);
    event PipeFinalized();

    error NotFinalizable();
    error AlreadyFinalized();
    error Finalized();
    error ZeroAddress();
    error BpsSumInvalid();
    error BelowMinRoute();

    /// @notice WETH — the sole payment token the Bus ever handles.
    function paymentToken() external view returns (address);

    function invBps() external view returns (uint16);
    function clpBps() external view returns (uint16);
    function idxBurnBps() external view returns (uint16);
    function plankBurnBps() external view returns (uint16);
    function plankLpBps() external view returns (uint16);
    function divBps() external view returns (uint16);

    function finalized() external view returns (bool);

    /// @notice Permissionless. Spends min(balance, MAX_ROUTE_WEI, this block's
    /// remaining BLOCK_BUDGET_WEI) if that amount is >= MIN_ROUTE_WEI;
    /// otherwise no-ops and returns 0. The per-block budget (audit H-5) makes
    /// the cap cumulative across repeated calls in one block, so looping
    /// route() within a single transaction cannot exceed it — see
    /// `blockBudgetRemaining()` and the EnergyBus implementation.
    function route() external returns (uint256 spent);

    /// @notice Optional accounting sync hook; the Bus itself is a pure
    /// balance model so this simply returns the current WETH balance.
    function sync() external returns (uint256 surplus);

    /// @notice One-way freeze of bps + adapter addresses + dead addresses.
    function finalize() external;
}
