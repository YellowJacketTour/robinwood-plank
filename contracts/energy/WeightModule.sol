// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IWeightModule} from "./IWeightModule.sol";

/**
 * @notice Minimal view any factory must expose so WeightModule can gate
 * note* calls to real, factory-deployed collection vaults. Wiring this onto
 * `CollectionVaultFactory` itself is a later PR (SPEC §5, ONESHOT §7 PR8) —
 * PR1 only needs the interface so the module can be tested and deployed
 * against any conforming factory.
 */
interface IVaultFactoryView {
    function isVault(address vault) external view returns (bool);
}

/**
 * ============================================================================
 *  WeightModule — ONESHOT §4.3 / SPEC §3, PR1 of the AXIOM-1 stack.
 *
 *  s_i = m_i * (ALPHA_F*F_i + BETA_P*P_i + GAMMA_D*D_i + DELTA_V*V_i)
 *  w_i = cap(s_i / sum(s), W_MAX_BPS) then renormalized
 *  m_i = delta / (delta + K_BLOCKS), delta = block.number - firstFeeBlock
 *
 *  No settlement oracle anywhere in this file. Every signal is either a
 *  cumulative counter (F, P) or a latest-value / EWMA counter (D, V) fed
 *  exclusively by self-reporting, factory-verified collection vaults.
 * ============================================================================
 */
contract WeightModule is IWeightModule {
    uint256 internal constant WAD = 1e18;
    uint256 internal constant BPS_DENOM = 10_000;

    // ---- LOCKED genesis constants (ONESHOT §4.2 / §4.3 — do not deviate) ----
    uint256 public constant ALPHA_F_WAD = 450_000_000_000_000_000; // 0.45
    uint256 public constant BETA_P_WAD = 250_000_000_000_000_000; // 0.25
    uint256 public constant GAMMA_D_WAD = 150_000_000_000_000_000; // 0.15
    uint256 public constant DELTA_V_WAD = 150_000_000_000_000_000; // 0.15

    uint256 public constant K_BLOCKS = 50_400;
    uint256 public constant F_MIN_WEI = 0.05 ether;
    uint256 public constant W_MAX_BPS = 2_500;
    uint256 public constant DECAY_BLOCKS = 100_800;

    /// @dev Weight given to the newest sample in the V-signal EWMA (20%).
    uint256 internal constant EWMA_ALPHA_WAD = 200_000_000_000_000_000;

    struct VaultScore {
        uint256 feeWethCumulative; // F_i raw cumulative matured-fee wei
        int256 mintPressureCumulative; // P_i signed net mint(+)/redeem(-) wei
        uint256 depthWeth; // D_i latest observed WETH-leg reserve
        uint256 volumeEwma; // V_i EWMA of fee-derived swap volume wei
        uint64 firstFeeBlock;
        uint64 lastFeeBlock;
        bool admitted;
    }

    address public immutable factory;

    mapping(address => VaultScore) public scores;
    address[] internal admittedVaults;
    mapping(address => bool) internal isAdmittedVault;

    constructor(address factory_) {
        if (factory_ == address(0)) revert ZeroAddress();
        factory = factory_;
    }

    modifier onlyFactoryVault(address vault) {
        if (msg.sender != vault || !IVaultFactoryView(factory).isVault(vault)) {
            revert NotFactoryVault();
        }
        _;
    }

    // -------------------------------------------------------------------
    // Signal ingestion — self-reported, factory-gated.
    // -------------------------------------------------------------------

    function noteFee(address vault, uint256 amountWei) external onlyFactoryVault(vault) {
        VaultScore storage vs = scores[vault];
        if (vs.firstFeeBlock == 0) {
            vs.firstFeeBlock = uint64(block.number);
        }
        vs.lastFeeBlock = uint64(block.number);
        vs.feeWethCumulative += amountWei;
        emit FeeNoted(vault, amountWei, vs.feeWethCumulative);
    }

    function noteMintPressure(address vault, int256 netDeltaWei) external onlyFactoryVault(vault) {
        VaultScore storage vs = scores[vault];
        vs.mintPressureCumulative += netDeltaWei;
        emit MintPressureNoted(vault, netDeltaWei, vs.mintPressureCumulative);
    }

    function noteDepth(address vault, uint256 reserveWethWei) external onlyFactoryVault(vault) {
        VaultScore storage vs = scores[vault];
        vs.depthWeth = reserveWethWei;
        emit DepthNoted(vault, reserveWethWei);
    }

    function noteVolume(address vault, uint256 feeDerivedVolumeWei) external onlyFactoryVault(vault) {
        VaultScore storage vs = scores[vault];
        vs.volumeEwma = vs.volumeEwma == 0
            ? feeDerivedVolumeWei
            : (vs.volumeEwma * (WAD - EWMA_ALPHA_WAD) + feeDerivedVolumeWei * EWMA_ALPHA_WAD) / WAD;
        emit VolumeNoted(vault, feeDerivedVolumeWei, vs.volumeEwma);
    }

    // -------------------------------------------------------------------
    // Admit
    // -------------------------------------------------------------------

    function checkAdmit(address vault) external returns (bool) {
        VaultScore storage vs = scores[vault];
        if (vs.admitted) revert AlreadyAdmitted();
        if (vs.feeWethCumulative < F_MIN_WEI) revert NotAdmitted();
        vs.admitted = true;
        isAdmittedVault[vault] = true;
        admittedVaults.push(vault);
        emit Admitted(vault);
        return true;
    }

    function isAdmitted(address vault) external view returns (bool) {
        return scores[vault].admitted;
    }

    // -------------------------------------------------------------------
    // Score / weights
    // -------------------------------------------------------------------

    function score(address vault) external view returns (uint256) {
        return _rawScore(vault);
    }

    function _rawScore(address vault) internal view returns (uint256) {
        VaultScore storage vs = scores[vault];
        if (vs.firstFeeBlock == 0) return 0;

        uint256 delta = block.number - vs.firstFeeBlock;
        uint256 m = (delta * WAD) / (delta + K_BLOCKS);

        uint256 fHat = vs.feeWethCumulative;
        uint256 pHat = vs.mintPressureCumulative > 0 ? uint256(vs.mintPressureCumulative) : 0;
        uint256 dHat = vs.depthWeth;
        uint256 vHat = vs.volumeEwma;

        uint256 composite = (ALPHA_F_WAD * fHat + BETA_P_WAD * pHat + GAMMA_D_WAD * dHat + DELTA_V_WAD * vHat) / WAD;

        uint256 s = (m * composite) / WAD;

        uint256 sinceLast = block.number - vs.lastFeeBlock;
        if (sinceLast > DECAY_BLOCKS) {
            uint256 quiet = sinceLast - DECAY_BLOCKS;
            // Half-life-shaped shrink identical in form to the maturity
            // curve: the longer the silence beyond the quiet window, the
            // closer the multiplier gets to 0, but it never resets state.
            s = (s * K_BLOCKS) / (K_BLOCKS + quiet);
        }
        return s;
    }

    function weights() external view returns (address[] memory vaults, uint256[] memory wBps) {
        uint256 n = admittedVaults.length;
        vaults = new address[](n);
        wBps = new uint256[](n);
        if (n == 0) return (vaults, wBps);

        uint256[] memory raw = new uint256[](n);
        uint256 sum;
        for (uint256 i = 0; i < n; i++) {
            vaults[i] = admittedVaults[i];
            raw[i] = _rawScore(vaults[i]);
            sum += raw[i];
        }
        if (sum == 0) return (vaults, wBps);

        for (uint256 i = 0; i < n; i++) {
            wBps[i] = (raw[i] * BPS_DENOM) / sum;
        }

        // Iterative waterfall cap: any vault over W_MAX_BPS is clamped, and
        // the bps it gives up is redistributed pro-rata (by raw score)
        // among the still-uncapped vaults. Repeats until stable — bounded
        // by `n` iterations, which is also the worst case for convergence.
        bool[] memory capped = new bool[](n);
        for (uint256 iter = 0; iter < n; iter++) {
            bool anyNewCap = false;
            for (uint256 i = 0; i < n; i++) {
                if (!capped[i] && wBps[i] > W_MAX_BPS) {
                    capped[i] = true;
                    anyNewCap = true;
                }
            }
            if (!anyNewCap) break;

            uint256 usedByCapped;
            uint256 uncappedRawSum;
            for (uint256 i = 0; i < n; i++) {
                if (capped[i]) {
                    usedByCapped += W_MAX_BPS;
                } else {
                    uncappedRawSum += raw[i];
                }
            }
            uint256 remaining = usedByCapped >= BPS_DENOM ? 0 : BPS_DENOM - usedByCapped;
            for (uint256 i = 0; i < n; i++) {
                if (capped[i]) {
                    wBps[i] = W_MAX_BPS;
                } else {
                    wBps[i] = uncappedRawSum == 0 ? 0 : (raw[i] * remaining) / uncappedRawSum;
                }
            }
        }
    }
}
