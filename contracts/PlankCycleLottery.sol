// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;
import {PlankNumberedLottery} from "./PlankNumberedLottery.sol";

/// @notice Funded-cycle lottery: all seats remain eligible pro rata in the crash.
/// Retention advances with fresh net funding, never wallet count or empty draws.
/// Fees are provisioned before quoting; unsuccessful draws never debit banked prizes.
contract PlankCycleLottery is PlankNumberedLottery {
    uint256 public immutable cycleRetentionMaxBps;
    uint256 public immutable cycleFundingScaleWei;
    uint256 public immutable rolloverFeeBps;
    bytes32 public immutable cycleRulesHash;
    uint256 public cycleFunding;
    uint256 public committedCycleFunding;
    uint256 public totalRolloverFees;
    uint256 public cycleId = 1;
    uint256 public lastRecordedRound;
    error RepeatedRound();
    uint256 public pendingRolloverFees;
    uint256 public committedRolloverFees;
    uint256 public fundingRolloverRemainder;
    uint256 public totalDrawRolloverFees;
    event RolloverProvisioned(address indexed from,uint256 amount,uint256 pendingTotal);
    event DrawRolloverFee(uint256 fee, uint256 poolUnchanged);
    uint256 public fundingFeeRemainder;
    uint256 public rolloverFeeRemainder;
    event CycleRolled(uint256 indexed cycleId, uint256 grossSeed, uint256 fee, uint256 nextSeed, uint256 carriedFreshFunding);

    constructor(Config memory cfg,uint256 retentionMaxBps,uint256 fundingScaleWei,uint256 rolloverFeeBps_)
        PlankNumberedLottery(cfg)
    {
        // A winner always receives at least 75% of its committed gross board.
        // Require explicit production sizing; no hidden deployment default.
        if(cfg.kappaBps>100000000||retentionMaxBps>2500||fundingScaleWei==0||fundingScaleWei>1e33||rolloverFeeBps_>2500)revert BadConfig();
        cycleRetentionMaxBps=retentionMaxBps;
        cycleFundingScaleWei=fundingScaleWei;
        rolloverFeeBps=rolloverFeeBps_;
        cycleRulesHash=keccak256(abi.encode("PLANK_FUNDED_CYCLE_V1",retentionMaxBps,fundingScaleWei,rolloverFeeBps_,founderFeeBps,contributionBps,kappaBps,oddsOneIn));
    }
    function recordRound(uint256 roundId,bytes32 seed,address winner,uint256 rakeWei) public virtual override {
        if(roundId<=lastRecordedRound)revert RepeatedRound();
        lastRecordedRound=roundId;super.recordRound(roundId,seed,winner,rakeWei);
    }
    function fund() external payable override {
        if(msg.value==0)revert NothingToFund();
        if(msg.value>1e33)revert BadConfig();
        uint256 numerator=msg.value*founderFeeBps+fundingFeeRemainder;
        uint256 fee=numerator/10000;fundingFeeRemainder=numerator%10000;
        uint256 net=msg.value-fee;
        uint256 provisionNumerator=net*rolloverFeeBps+fundingRolloverRemainder;
        uint256 provision=provisionNumerator/10000;fundingRolloverRemainder=provisionNumerator%10000;
        pendingRolloverFees+=provision;net-=provision;
        emit RolloverProvisioned(msg.sender,provision,pendingRolloverFees);
        _onFunding(net);founderEscrow+=fee;pool+=net;totalFunded+=msg.value;totalFees+=fee;
        emit Funded(msg.sender,msg.value,fee,pool);
    }
    function _onFunding(uint256 net) internal override {
        if(net>1e33-cycleFunding)revert BadConfig();cycleFunding+=net;
    }
    function _rollFee(uint256 grossSeed) private view returns(uint256){return(grossSeed*rolloverFeeBps+rolloverFeeRemainder)/10000;}
    function retentionBps() public view returns(uint256) {
        // Division before multiplication would discard meaningful tiny funding.
        return cycleRetentionMaxBps*cycleFunding/(cycleFundingScaleWei+cycleFunding);
    }
    function carve(uint256 prize) public view override returns(uint256 winnerPaid,uint256 grossSeed) {
        grossSeed=prize*retentionBps()/10000;
        winnerPaid=prize-grossSeed;
    }
    function carveBps(uint256) external view override returns(uint256) {return retentionBps();}
    function _commitBoard() internal override {
        super._commitBoard();committedCycleFunding=cycleFunding;committedRolloverFees=pendingRolloverFees;
    }
    function _assessDrawFee() private {
        uint256 fee=committedRolloverFees;
        pendingRolloverFees-=fee;founderEscrow+=fee;totalFees+=fee;totalDrawRolloverFees+=fee;
        emit DrawRolloverFee(fee,pool);
    }
    function _onMiss() internal override { _assessDrawFee(); }
    function _onWin(uint256 grossSeed) internal override returns(uint256 nextSeed) {
        _assessDrawFee();
        uint256 fee=_rollFee(grossSeed);
        rolloverFeeRemainder=(grossSeed*rolloverFeeBps+rolloverFeeRemainder)%10000;
        nextSeed=grossSeed-fee;
        pool-=fee;founderEscrow+=fee;totalFees+=fee;totalRolloverFees+=fee;
        // Funding received after this board's snapshot belongs to the next
        // cycle. Neither discard it nor count the old retained seed as fresh.
        cycleFunding-=committedCycleFunding;
        emit CycleRolled(cycleId++,grossSeed,fee,nextSeed,cycleFunding);
    }
    function hitThreshold(uint256 rakeWei,uint256 prize) public view override returns(uint256){
        uint256 winnerPaid;uint256 grossSeed;
        if(prize==committedPrize){winnerPaid=committedWinnerPaid;grossSeed=committedSeeded;}else(winnerPaid,grossSeed)=carve(prize);
        uint256 flat=PROB_ONE/oddsOneIn;if(winnerPaid==0)return flat;
        // Conservative net inflow after both funding fees, including worst-case
        // fractional carry. Neither founders' fees nor promised prizes fund odds.
        uint256 net=rakeWei*contributionBps/10000;
        net=net*(10000-founderFeeBps)/10000;
        net=net*(10000-rolloverFeeBps)/10000;
        uint256 outflow=winnerPaid+_rollFee(grossSeed);
        uint256 funded=net*PROB_ONE*10000/(kappaBps*outflow);
        return funded<flat?funded:flat;
    }
    function accountedBalance() public view override returns(uint256){return super.accountedBalance()+pendingRolloverFees;}
    function quote() external view override returns(uint256 prize,uint256 winnerPaid,uint256 seeded) {
        return(committedPrize,committedWinnerPaid,committedSeeded-_rollFee(committedSeeded));
    }
    function quoteBreakdown() external view returns(uint256 prize,uint256 winnerPaid,uint256 nextSeed,uint256 rolloverFee,uint256 fundingSnapshot) {
        rolloverFee=_rollFee(committedSeeded);
        return(committedPrize,committedWinnerPaid,committedSeeded-rolloverFee,rolloverFee,committedCycleFunding);
    }
}
