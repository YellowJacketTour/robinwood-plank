// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;
import {PlankStakeIndex} from "../lib/PlankStakeIndex.sol";
contract PlankStakeIndexHarness {
    using PlankStakeIndex for PlankStakeIndex.Index;
    mapping(uint256 => PlankStakeIndex.Index) private books;
    function insert(uint256 book,uint256[] calldata targets,uint256[] calldata units) external {
        require(targets.length == units.length);
        for(uint256 i; i < targets.length; ++i) books[book].insert(targets[i],units[i]);
    }
    function clear(uint256 book,uint256 budget,uint256 crash,uint256 floorBps) external view returns(PlankStakeIndex.Clearing memory) {
        return books[book].clear(budget,crash,floorBps);
    }
    function payouts(uint256 book,uint256 budget,uint256 crash,uint256 floorBps,uint256[] calldata stakes,uint256[] calldata targets) external view returns(uint256[] memory result) {
        require(stakes.length == targets.length);
        PlankStakeIndex.Clearing memory c=books[book].clear(budget,crash,floorBps);
        result=new uint256[](stakes.length);
        for(uint256 i;i<stakes.length;++i) result[i]=PlankStakeIndex.payout(c,stakes[i],targets[i]);
    }
}
