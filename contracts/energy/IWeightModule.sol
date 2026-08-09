// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * ============================================================================
 *  IWeightModule — PR1 of the AXIOM-1 stack (ONESHOT §7, SPEC §3).
 *
 *  Multi-signal, on-chain-only performance weighting for the L2 index's
 *  InventoryBuyAdapter (built in a later PR). No floor oracle, ever —
 *  every signal is an EWMA/cumulative counter fed by real vault activity.
 *
 *  s_i = m_i * (ALPHA_F*F_i + BETA_P*P_i + GAMMA_D*D_i + DELTA_V*V_i)
 *  w_i = cap(s_i / sum(s), W_MAX_BPS) then renormalized to sum 10_000
 *  m_i = delta / (delta + K_BLOCKS), delta = block.number - firstFeeBlock
 * ============================================================================
 */
interface IWeightModule {
    event FeeNoted(address indexed vault, uint256 amount, uint256 cumulative);
    event MintPressureNoted(address indexed vault, int256 delta, int256 cumulative);
    event DepthNoted(address indexed vault, uint256 reserveWeth);
    event VolumeNoted(address indexed vault, uint256 feeDerivedVolumeWei, uint256 ewma);
    event Admitted(address indexed vault);

    error NotFactoryVault();
    error NotAdmitted();
    error AlreadyAdmitted();
    error ZeroAddress();

    /// @notice The factory whose `isVault(address)` gates every note* call.
    function factory() external view returns (address);

    /// @notice Matured, decay-applied composite score for `vault` (raw WAD-ish
    /// units; only meaningful relative to other vaults' scores).
    function score(address vault) external view returns (uint256 s);

    /// @notice Admitted vaults and their current weights in bps, summing to
    /// 10_000 (or 0 if no vault is admitted yet), each capped at W_MAX_BPS.
    function weights() external view returns (address[] memory vaults, uint256[] memory wBps);

    /// @notice Permissionless. Admits `vault` once its matured cumulative fee
    /// signal clears `F_MIN_WEI`. Reverts if not yet eligible or already
    /// admitted.
    function checkAdmit(address vault) external returns (bool);

    /// @notice Whether `vault` has cleared the admit floor.
    function isAdmitted(address vault) external view returns (bool);

    /// @notice Vault self-reports a matured WETH fee contribution (F signal).
    /// Callable only by `msg.sender == vault` where `factory.isVault(vault)`.
    function noteFee(address vault, uint256 amountWei) external;

    /// @notice Vault self-reports signed net mint(+)/redeem(-) pressure for
    /// this period (P signal). Wash mint+redeem nets to ~0, so it does not
    /// move this signal the way genuine one-sided demand does.
    function noteMintPressure(address vault, int256 netDeltaWei) external;

    /// @notice Vault self-reports its AMM WETH-leg reserve depth (D signal).
    /// Latest-value, not cumulative — an empty pool reports 0.
    function noteDepth(address vault, uint256 reserveWethWei) external;

    /// @notice Vault self-reports fee-derived swap volume (V signal) — i.e.
    /// volume that actually paid a swap fee, so pure wash-trading cannot
    /// inflate this signal without paying for it each time.
    function noteVolume(address vault, uint256 feeDerivedVolumeWei) external;
}
