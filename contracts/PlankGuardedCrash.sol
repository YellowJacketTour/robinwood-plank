// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;
import {PlankCrash} from "./PlankCrash.sol";

/// @notice Narrow emergency powers: stop admission, never seize or cancel funds.
/// Production guardian and governance should be distinct audited multisig accounts.
contract PlankGuardedCrash is PlankCrash {
    address public immutable guardian;
    address public immutable safetyGovernance;
    uint256 public immutable reopenDelay;
    bool public admissionsPaused;
    uint256 public reopenAt;
    error UnauthorizedSafetyRole();
    error AdmissionsPaused();
    error InvalidSafetyState();
    event AdmissionsFrozen(address indexed by);
    event ReopenRequested(uint256 executableAt);
    event AdmissionsReopened();
    event RecoveryFreeze(uint256 indexed stalledRound);
    constructor(Config memory cfg,address guardian_,address governance_,uint256 delay_) PlankCrash(cfg) {
        if(guardian_==address(0)||governance_==address(0)||guardian_==governance_||delay_<1 hours||delay_>7 days) revert BadConfig();
        guardian=guardian_;safetyGovernance=governance_;reopenDelay=delay_;
    }
    function freeze() external {
        if(msg.sender!=guardian&&msg.sender!=safetyGovernance)revert UnauthorizedSafetyRole();
        admissionsPaused=true;reopenAt=0;
        emit AdmissionsFrozen(msg.sender);
    }
    function requestReopen() external {
        if(msg.sender!=safetyGovernance)revert UnauthorizedSafetyRole();
        if(!admissionsPaused||reopenAt!=0)revert InvalidSafetyState();
        _requireResolvedIncident();
        reopenAt=block.timestamp+reopenDelay;
        emit ReopenRequested(reopenAt);
    }
    function executeReopen() external {
        if(!admissionsPaused||reopenAt==0||block.timestamp<reopenAt)revert InvalidSafetyState();
        _requireResolvedIncident();
        admissionsPaused=false;reopenAt=0;
        emit AdmissionsReopened();
    }
    function _requireResolvedIncident() private view {
        if (recoveryPending()) revert InvalidSafetyState();
    }
    function recoveryPending() public view returns (bool) {
        return stalledRound != 0 && rounds[stalledRound].phase != Phase.SETTLED;
    }
    // Timeout freezes new admissions without cancelling the committed result.
    function _afterRoundStalled(uint256 id) internal override {
        admissionsPaused = true;
        reopenAt = 0;
        emit RecoveryFreeze(id);
        emit AdmissionsFrozen(msg.sender);
    }
    function _beforeBet() internal view override {
        if(admissionsPaused)revert AdmissionsPaused();
    }
}
