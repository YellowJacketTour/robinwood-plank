// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;
import {PlankLottery} from "./PlankLottery.sol";

/// @notice LOCAL CANDIDATE: numbered draw, preserving the legacy funding/carve/accounting.
/// @dev Not a deployment approval. N is computed from the legacy funded probability cap.
contract PlankNumberedLottery is PlankLottery {
    bytes32 public constant NUMBERED_BALL_DOMAIN=keccak256("PLANK_NUMBERED_BALL_V1");
    event NumberedDraw(uint256 indexed roundId,uint256 ballCount,uint256 drawnBall);
    constructor(Config memory cfg) PlankLottery(cfg) {}
    function ballCountFor(uint256 rakeWei,uint256 prize) public view returns(uint256) {
        if(prize==0)return 0;
        return _count(hitThreshold(rakeWei,prize));
    }
    function _count(uint256 threshold) internal pure returns(uint256) {
        if(threshold==0)return 0;
        return (PROB_ONE+threshold-1)/threshold;
    }
    function _drawBall(uint256 roundId,bytes32 seed,uint256 threshold) internal override returns(bool) {
        uint256 count=_count(threshold);
        uint256 drawn=0;
        if(count>0){
            // Reverse the residue labels: winning ball 1 gets residue N-1.
            // It has floor(2^256/N) preimages, so finite-word modulo bias can
            // NEVER increase its probability above 1/N (unlike residue zero).
            // N<=1e18: deviation from 1/N is <1/2^256, no loops or rerolls.
            drawn=count-(uint256(keccak256(abi.encode(NUMBERED_BALL_DOMAIN,seed)))%count);
        }
        emit NumberedDraw(roundId,count,drawn);
        return drawn==1;
    }
}
