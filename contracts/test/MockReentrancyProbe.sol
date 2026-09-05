// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

interface IProbeCrash {
    function placeBet(uint256 targetBps) external payable;
    function withdraw() external;
    function settleRound() external;
    function lockRound() external;
    function refundRound() external;
    function claimRefund(uint256 roundId, address player) external;
    function flushRake() external returns (bool);
    function deliverOverflow() external returns (bool);
    function fundVault() external payable;
    function accountedBalance() external view returns (uint256);
    function currentRoundId() external view returns (uint256);
    function totalOwed() external view returns (uint256);
    function owed(address) external view returns (uint256);
}

interface IProbeLottery {
    function quote() external view returns (uint256, uint256, uint256);
    function accountedBalance() external view returns (uint256);
}

/// @notice TEST-ONLY. Plays as a contract and, inside the ETH callback of
///         PlankCrash.withdraw, probes every state-changing entry point and
///         every accounting view. Records what it observed so the test can
///         assert (a) no re-entry succeeded and (b) the views were consistent
///         (balance == accountedBalance) at the only moment an outsider ever
///         runs code inside the crash.
contract MockReentrancyProbe {
    IProbeCrash public immutable crash;
    IProbeLottery public immutable lottery;

    bool public entered;
    bool public balanceMatchedAccounting;
    bool public lotteryBalanceMatched;
    bool public owedWasZero;
    bool public placeBetReverted;
    bool public withdrawReverted;
    bool public settleReverted;
    bool public lockReverted;
    bool public refundReverted;
    bool public flushReverted;
    bool public overflowReverted;
    bool public fundVaultReverted;
    uint256 public received;

    constructor(address crash_, address lottery_) {
        crash = IProbeCrash(crash_);
        lottery = IProbeLottery(lottery_);
    }

    function bet(uint256 targetBps) external payable {
        crash.placeBet{value: msg.value}(targetBps);
    }

    function pull() external {
        crash.withdraw();
    }

    receive() external payable {
        if (entered) return; // never recurse twice
        entered = true;
        received = msg.value;
        // Views: must be consistent mid-callback (the debit + value transfer
        // both happened before this code runs).
        balanceMatchedAccounting = address(crash).balance == crash.accountedBalance();
        lotteryBalanceMatched = address(lottery).balance == lottery.accountedBalance();
        lottery.quote();
        owedWasZero = crash.owed(address(this)) == 0;
        // Every nonReentrant entry point must reject us.
        try crash.placeBet{value: 1}(15_000) { placeBetReverted = false; } catch { placeBetReverted = true; }
        try crash.withdraw() { withdrawReverted = false; } catch { withdrawReverted = true; }
        try crash.settleRound() { settleReverted = false; } catch { settleReverted = true; }
        try crash.lockRound() { lockReverted = false; } catch { lockReverted = true; }
        try crash.refundRound() { refundReverted = false; } catch { refundReverted = true; }
        try crash.flushRake() { flushReverted = false; } catch { flushReverted = true; }
        try crash.deliverOverflow() { overflowReverted = false; } catch { overflowReverted = true; }
        try crash.fundVault{value: 1}() { fundVaultReverted = false; } catch { fundVaultReverted = true; }
    }
}
