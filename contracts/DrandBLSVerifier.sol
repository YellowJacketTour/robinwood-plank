// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {BLS} from "@kevincharm/bls-bn254/contracts/BLS.sol";
import {IDrandVerifier} from "./IDrandVerifier.sol";

/**
 * A minimal, standalone contract whose only job is verifying a real
 * drand evmnet BLS signature for a given round number -- see
 * PlankCrashDrand.sol's own header for why drand/evmnet was chosen and
 * how the constants below were derived for real (not guessed).
 *
 * WHY THIS IS ITS OWN CONTRACT, NOT INLINED INTO PlankCrashDrand.sol:
 * a real compiler limitation, found and reproduced while building this,
 * not a hypothetical one. BLS.sol's inline assembly (unannotated as
 * memory-safe) hits a genuine Yul optimizer crash ("Cannot swap Variable
 * headStart with Variable tail") specifically when its internal
 * functions get inlined into the SAME contract as OpenZeppelin's
 * PullPayment/ReentrancyGuard machinery -- reproduced with a minimal
 * standalone probe (BLS.sol alone compiles fine, in isolation, with
 * identical solc/viaIR/runs/evmVersion settings) and confirmed to
 * persist even with Hardhat's per-file `isolated` compilation-unit
 * option, which rules out whole-program cross-contamination as the
 * cause. Splitting the BLS-touching code into its own contract with no
 * other inheritance sidesteps the crash entirely, verified by actually
 * compiling and testing this split, not assumed to work.
 */
contract DrandBLSVerifier is IDrandVerifier {
    // drand evmnet beacon parameters -- REAL, PERMANENT, network-wide
    // constants, not deploy-time config. See PlankCrashDrand.sol's header
    // for how these were derived and independently verified.
    uint256 private constant DRAND_PK_X_C0 =
        2416910118189096557713698606232949750075245832257361418817199221841198809231;
    uint256 private constant DRAND_PK_X_C1 =
        3565178688866727608783247307855519961161197286613423629330948765523825963906;
    uint256 private constant DRAND_PK_Y_C0 =
        18766085122067595057703228467555884757373773082319035490740181099798629248523;
    uint256 private constant DRAND_PK_Y_C1 =
        263980444642394177375858669180402387903005329333277938776544051059273779190;
    bytes private constant DRAND_DST = bytes("BLS_SIG_BN254G1_XMD:KECCAK-256_SVDW_RO_NUL_");

    /// Verifies that `signature` is the real drand evmnet threshold BLS
    /// signature for `round`. Pure verification, no state -- safe to call
    /// as a view from anywhere, including off-chain via eth_call before
    /// ever submitting a transaction.
    function verifyRound(uint64 round, uint256[2] calldata signature) external view returns (bool) {
        if (!BLS.isValidSignature(signature)) return false;
        bytes memory hashedRoundBytes = new bytes(32);
        assembly {
            mstore(0x00, round)
            let hashedRound := keccak256(0x18, 0x08)
            mstore(add(0x20, hashedRoundBytes), hashedRound)
        }
        uint256[2] memory message = BLS.hashToPoint(DRAND_DST, hashedRoundBytes);
        (bool pairingSuccess, bool callSuccess) = BLS.verifySingle(
            signature,
            [DRAND_PK_X_C0, DRAND_PK_X_C1, DRAND_PK_Y_C0, DRAND_PK_Y_C1],
            message
        );
        return callSuccess && pairingSuccess;
    }
}
