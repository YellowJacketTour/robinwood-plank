// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;
import {PlankCycleLottery} from "../PlankCycleLottery.sol";
contract RecoverableCycleLottery is PlankCycleLottery {
    bool public broken;
    bytes32 public recordedSeed;
    uint256 public recordedRake;
    address public recordedWinner;
    constructor(Config memory cfg,uint256 retention,uint256 scale,uint256 fee) PlankCycleLottery(cfg,retention,scale,fee) {}
    function setBroken(bool value) external { broken=value; }
    function recordRound(uint256 id,bytes32 seed,address winner,uint256 rake) public override {
        require(!broken,"lottery unavailable");
        recordedSeed=seed;recordedRake=rake;recordedWinner=winner;
        super.recordRound(id,seed,winner,rake);
    }
}
