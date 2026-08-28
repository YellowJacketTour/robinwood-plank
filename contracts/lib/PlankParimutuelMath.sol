// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @notice Exact PFSS candidate arithmetic, isolated for audit and differential tests.
/// @dev This library does not select PFSS for production. It makes the candidate executable.
library PlankParimutuelMath {
    uint256 internal constant BPS = 10_000;

    error InvalidTarget();
    error InvalidAggregate();

    struct Pools {
        uint256 basePool;
        uint256 surplusPool;
    }

    struct Payout {
        uint256 base;
        uint256 surplus;
        uint256 total;
    }

    function pools(uint256 distributable, uint256 survivorStake) internal pure returns (Pools memory result) {
        result.basePool = Math.min(distributable, survivorStake);
        result.surplusPool = distributable - result.basePool;
    }

    function riskWeight(uint256 stake, uint256 targetBps) internal pure returns (uint256) {
        if (targetBps < BPS) revert InvalidTarget();
        return stake * (targetBps - BPS);
    }

    function payout(
        uint256 distributable,
        uint256 survivorStake,
        uint256 totalRiskWeight,
        uint256 stake,
        uint256 targetBps
    ) internal pure returns (Payout memory result) {
        if (stake > survivorStake) revert InvalidAggregate();
        Pools memory split = pools(distributable, survivorStake);
        if (survivorStake != 0) result.base = Math.mulDiv(split.basePool, stake, survivorStake);
        uint256 weight = riskWeight(stake, targetBps);
        if (weight > totalRiskWeight) revert InvalidAggregate();
        if (totalRiskWeight != 0) {
            result.surplus = Math.mulDiv(split.surplusPool, weight, totalRiskWeight);
        }
        result.total = result.base + result.surplus;
    }
}
