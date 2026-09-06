// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {PlankCcs2LMath} from "../lib/PlankCcs2LMath.sol";

/// @notice TEST HARNESS for the CCS-2L settlement library.
/// @dev All arithmetic lives in contracts/lib/PlankCcs2LMath.sol (the
///      production-shaped library). This harness only exposes the library's
///      internal functions externally so hardhat can differential-test them
///      against the JS references (docs/marketplank/sim-settlement-ccs2l/
///      engine.mjs and lib/casino/economics-ccs2l.ts) and measure real gas.
///      This contract does not select CCS-2L for production.
contract PlankCcs2LSettlement {
    function lnScaled(uint256 xBps) external pure returns (uint256) {
        return PlankCcs2LMath.lnScaled(xBps);
    }

    function paramsHash(PlankCcs2LMath.Params memory params) external pure returns (bytes32) {
        return PlankCcs2LMath.paramsHash(params);
    }

    function settle(
        uint256 playerDistributable,
        uint256 seedH,
        uint256 crashBps,
        PlankCcs2LMath.Seat[] calldata seats,
        uint256 reserveAtLock,
        uint256 rakeWei,
        uint256 vaultRoundsContributed,
        PlankCcs2LMath.Params memory params
    ) public pure returns (PlankCcs2LMath.Result memory r) {
        return PlankCcs2LMath.settle(
            playerDistributable, seedH, crashBps, seats, reserveAtLock, rakeWei, vaultRoundsContributed, params
        );
    }

    /// @notice Non-pure wrapper so hardhat reports real gas for settle().
    uint256 private _sink;

    function settleGas(
        uint256 playerDistributable,
        uint256 seedH,
        uint256 crashBps,
        PlankCcs2LMath.Seat[] calldata seats,
        uint256 reserveAtLock,
        uint256 rakeWei,
        uint256 vaultRoundsContributed,
        PlankCcs2LMath.Params memory params
    ) external returns (uint256) {
        PlankCcs2LMath.Result memory r =
            settle(playerDistributable, seedH, crashBps, seats, reserveAtLock, rakeWei, vaultRoundsContributed, params);
        _sink = r.totalPlayerPaid ^ r.totalBonus ^ r.lambda;
        return r.totalPlayerPaid + r.totalBonus;
    }
}
