// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;
contract FuelDestinationMock {
    uint256 public currentRoundId = 1;
    uint8 public phase;
    uint64 public closesAt = type(uint64).max;
    uint256 public received;
    bool public reject;
    function configure(uint256 id, uint8 p, uint64 end, bool fail) external {currentRoundId=id;phase=p;closesAt=end;reject=fail;}
    function rounds(uint256) external view returns(uint8,uint64,uint64){return(phase,0,closesAt);}
    function fundVault() external payable {require(!reject,"sink rejected");received+=msg.value;}
}
