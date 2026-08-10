// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * ============================================================================
 *  IWeightModule — REWRITTEN for DESIGN-HONEST-INDEX-2026-08-09 §3
 *  ("Weight: earned with value you cannot take back").
 *
 *  Closes audit C-4, H-4, H-6, H-8.
 *
 *  s_i = m_i * decay_i * (ALPHA_F*F_i + BETA_P*P_i + GAMMA_D*D_i + DELTA_V*V_i)
 *  w_i = s_i / sum(s), clamped to vault i's EXIT-CAPACITY share, then
 *        renormalized to EXACTLY 10_000, with the Robinwood floor applied.
 *
 *  THE ONE RULE THAT GOVERNS EVERY SIGNAL BELOW — design §3.1, `R <= C`:
 *  a signal must cost what it earns, so **every quantity fed to this module
 *  must be UNRECOVERABLE contribution**: value that has irreversibly left the
 *  reporting vault's control and reached the commons (the upstream sink /
 *  Energy Bus). Never a gross notional, never a fee the vault's own
 *  `treasury` receives, never a self-compound that stays inside the vault's
 *  own reserves and can be withdrawn again by its own LPs.
 *
 *  The pre-rewrite interface documented "fees" and was fed gross notional
 *  (audit H-6: "the doc is false"). It is now true, and the vault-side call
 *  sites are named in the parameter docs so the falsehood cannot silently
 *  return.
 * ============================================================================
 */
interface IWeightModule {
    event FeeNoted(address indexed vault, uint256 sinkAmount, uint256 cumulative);
    event MintPressureNoted(address indexed vault, int256 delta, int256 cumulative);
    event DepthNoted(address indexed vault, uint256 reserveWeth, uint256 windowMin);
    event VolumeNoted(address indexed vault, uint256 sinkFeeWei, uint256 ewma);
    event Admitted(address indexed vault);
    event RobinwoodVaultSet(address indexed vault);

    error NotFactoryVault();
    error NotAdmitted();
    error AlreadyAdmitted();
    error ZeroAddress();
    error NotRobinwoodSetter();
    error RobinwoodAlreadySet();

    /// @notice The factory whose `isVault(address)` gates every note* call.
    function factory() external view returns (address);

    /// @notice Matured, decay-applied composite score for `vault`.
    function score(address vault) external view returns (uint256 s);

    /// @notice Admitted vaults and their weights in bps.
    /// @dev INVARIANT (closes audit H-8): whenever at least one admitted vault
    /// has a nonzero score, the returned `wBps` sum to EXACTLY 10_000. The old
    /// fiat `W_MAX_BPS = 2500` cap let three admitted vaults sum to 7500 and
    /// silently leak 25% of the largest pipe into dividends; with fewer than
    /// four vaults it leaked up to 75%.
    function weights() external view returns (address[] memory vaults, uint256[] memory wBps);

    /// @notice Permissionless. Admits `vault` once its cumulative UNRECOVERABLE
    /// (sink-delivered) fee contribution clears `F_MIN_WEI`.
    function checkAdmit(address vault) external returns (bool);

    /// @notice Whether `vault` has cleared the admit floor.
    function isAdmitted(address vault) external view returns (bool);

    /// @notice Vault self-reports the portion of a mint/redeem fee that was
    /// IRREVERSIBLY PUSHED TO `upstreamSink` (F signal).
    /// @param sinkAmountWei MUST be the vault's `sinkCut` only — never the
    /// gross fee, never the `treasuryCut` (which the vault's own operator
    /// receives and can spend), never the `compoundCut` (which stays in the
    /// vault's own `paymentReserve` and is recoverable by its own LPs).
    /// Feeding anything larger re-opens audit H-4, where ~0.004 WETH bought
    /// 12.5% of all fee flow permanently by choosing one's own `treasury_`
    /// and `sinkBps` at `deployVault`.
    function noteFee(address vault, uint256 sinkAmountWei) external;

    /// @notice Vault self-reports signed net mint(+)/redeem(-) pressure.
    /// @param netSinkDeltaWei MUST also be denominated in sink-delivered wei,
    /// for the same `R <= C` reason as `noteFee`. Wash mint+redeem nets to ~0.
    function noteMintPressure(address vault, int256 netSinkDeltaWei) external;

    /// @notice Vault self-reports its AMM WETH-leg reserve depth (D signal).
    /// @dev Scored as the MINIMUM across a rolling window of buckets, never
    /// the latest sample (audit C-4/H-6: `noteDepth` latched an instantaneous
    /// value, so a flash-loaned addLiquidity -> dust swap -> removeLiquidity
    /// owned the depth signal forever). A windowed minimum cannot be faked
    /// without HOLDING real liquidity for the whole window.
    function noteDepth(address vault, uint256 reserveWethWei) external;

    /// @notice Vault self-reports the swap fee that IRREVERSIBLY reached the
    /// sink (V signal) — NOT gross swap notional.
    /// @param sinkFeeWei The `sinkCut` transferred to `upstreamSink` by this
    /// swap. Gross notional is free to wash (buy then sell round-trips to ~0
    /// cost); the sink cut is not, which is exactly the `R <= C` property.
    function noteVolume(address vault, uint256 sinkFeeWei) external;

    /// @notice Permissionless: sample `vault`'s REAL current WETH reserve into
    /// the depth window by reading it directly, so a vault cannot keep a stale
    /// high sample alive merely by going quiet. Anyone may prove a pool is
    /// thinner than it claimed.
    function pokeDepth(address vault) external;

    /// @notice The windowed-minimum WETH depth currently scored for `vault`.
    function windowMinDepth(address vault) external view returns (uint256);

    /// @notice Payment-token size `vault` could absorb on exit within
    /// `EXIT_HAIRCUT_BPS`, quality-adjusted by the vault's own
    /// `realizableBps()`. This is what caps concentration — derived, not
    /// decreed (design §3.3).
    function exitCapacityWeth(address vault) external view returns (uint256);

    /// @notice The permanent 8.1% beneficiary (design §3.4), or address(0).
    function robinwoodVault() external view returns (address);

    /// @notice bps of the 810 floor that exit capacity CANNOT honestly support
    /// right now. Design §3.4: this shortfall is never waived and never faked
    /// — `CollectionLpAdapter` reads it and spends that share of Pipe L on
    /// DEEPENING Robinwood's own pool until the floor becomes supportable.
    function robinwoodShortfallBps() external view returns (uint256);
}
