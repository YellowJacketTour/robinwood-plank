// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {PlankFenwickTree} from "../lib/PlankFenwickTree.sol";
import {PlankParimutuelMath} from "../lib/PlankParimutuelMath.sol";

contract PlankSettlementHarness {
    using PlankFenwickTree for PlankFenwickTree.Tree;

    PlankFenwickTree.Tree private _stakeTree;
    PlankFenwickTree.Tree private _riskTree;

    constructor(uint32 size) {
        _stakeTree.initialize(size);
        _riskTree.initialize(size);
    }

    function add(uint32 tick, uint256 stake, uint256 targetBps) external {
        _stakeTree.add(tick, stake);
        _riskTree.add(tick, PlankParimutuelMath.riskWeight(stake, targetBps));
    }

    function replace(
        uint32 oldTick,
        uint256 oldTargetBps,
        uint32 newTick,
        uint256 newTargetBps,
        uint256 stake
    ) external {
        _stakeTree.subtract(oldTick, stake);
        _riskTree.subtract(oldTick, PlankParimutuelMath.riskWeight(stake, oldTargetBps));
        _stakeTree.add(newTick, stake);
        _riskTree.add(newTick, PlankParimutuelMath.riskWeight(stake, newTargetBps));
    }

    function prefix(uint32 tick) external view returns (uint256 survivorStake, uint256 riskWeight) {
        survivorStake = _stakeTree.prefix(tick);
        riskWeight = _riskTree.prefix(tick);
    }

    function at(uint32 tick) external view returns (uint256 stake, uint256 riskWeight) {
        stake = _stakeTree.at(tick);
        riskWeight = _riskTree.at(tick);
    }

    function payout(
        uint256 distributable,
        uint256 survivorStake,
        uint256 totalRiskWeight,
        uint256 stake,
        uint256 targetBps
    ) external pure returns (uint256 base, uint256 surplus, uint256 total) {
        PlankParimutuelMath.Payout memory result = PlankParimutuelMath.payout(
            distributable, survivorStake, totalRiskWeight, stake, targetBps
        );
        return (result.base, result.surplus, result.total);
    }
}
