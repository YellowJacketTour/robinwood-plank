// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;
import {PlankGuardedCrash} from "../PlankGuardedCrash.sol";
import {PlankCcs2LMath} from "../lib/PlankCcs2LMath.sol";

/// @notice Local simulated-ETH schedule only. Cannot be deployed to mainnet.
/// Frontend liftoff is bettingEndsAt + 8 seconds. The next cutoff accounts
/// for the preceding flight so lottery-result-to-liftoff is about 30 seconds. The 38-second
/// crash interval includes the 2.6-second finale and 4.8-second lottery reveal.
contract PlankTimedPracticeCrash is PlankGuardedCrash {
    constructor(Config memory cfg,address guardian_,address governance_,uint256 delay_)
        PlankGuardedCrash(cfg,guardian_,governance_,delay_) {
        require(block.chainid == 31337, "Local practice only");
    }
    mapping(uint256 => uint256) public practiceLiftoffAtMs;
    function _bettingDeadline(uint256 id) internal override returns (uint256) {
        uint256 liftoff=(block.timestamp+38)*1000;
        if(id>1){
            Round storage previous=rounds[id-1];
            if(previous.crashBps>=10000){
                uint256 flightMs=PlankCcs2LMath.lnScaled(previous.crashBps)*1000/220000;
                // Crash finale 2600ms + numbered reveal 4800ms + 30s edit window.
                liftoff=practiceLiftoffAtMs[id-1]+flightMs+37400;
                if(liftoff<(block.timestamp+23)*1000)liftoff=(block.timestamp+38)*1000;
            }
        }
        practiceLiftoffAtMs[id]=liftoff;
        // Close submissions 8-9 seconds before the shared launch to allow
        // mock relay, verification, and off-screen preparation to finish.
        return (liftoff-8000)/1000;
    }
}
