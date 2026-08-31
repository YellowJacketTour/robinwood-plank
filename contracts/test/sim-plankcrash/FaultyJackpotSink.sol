// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// TEST ONLY. NEVER DEPLOY. Adversarial jackpot-sink battery for validating
/// the pendingOverflow design (deliverOverflow + skim-in-_creditReserve)
/// in PlankCrashOverflowV2Proto — every fault mode the design's §8/§10
/// verification vectors call for:
///   OK               accept and account the ETH (well-behaved Powerboard)
///   REVERT           always revert (permanently-unavailable sink)
///   GASBURN          consume more gas than SINK_GAS_STIPEND in a loop
///   REENTER_DELIVER  reenter caller.deliverOverflow() on receipt
///   REENTER_PLACEBET reenter caller.placeBet() on receipt
///   MALFORMED        no-op fund() that does NOT accept ETH (non-payable
///                    semantics: reverts on msg.value via explicit check —
///                    "wrong shape" sink; see also NoFundSink below for the
///                    wrong-selector / no-fund()-at-all case)
///   INTERMITTENT     revert every Nth call (default every 2nd)
interface IOverflowCrashLike {
    function deliverOverflow() external returns (bool);
    function placeBet(uint256 autoCashOutBps_) external payable;
}

contract FaultyJackpotSink {
    enum Mode {
        OK,
        REVERT,
        GASBURN,
        REENTER_DELIVER,
        REENTER_PLACEBET,
        MALFORMED,
        INTERMITTENT
    }

    Mode public mode;
    uint256 public totalFunded;
    uint256 public callCount;
    uint256 public intermittentN = 2; // revert every Nth call in INTERMITTENT
    uint256 public reentryAttempts;
    uint256 public reentrySucceeded;
    uint256 private _gasSinkSlot; // storage burner target
    address public target; // the crash contract to reenter

    function setMode(Mode m) external {
        mode = m;
    }

    function setTarget(address t) external {
        target = t;
    }

    function setIntermittentN(uint256 n) external {
        intermittentN = n;
    }

    error SinkDown();
    error NotPayable();

    function fund() external payable {
        callCount += 1;
        Mode m = mode;
        if (m == Mode.REVERT) revert SinkDown();
        if (m == Mode.MALFORMED) revert NotPayable(); // "non-payable" fund(): refuses the ETH
        if (m == Mode.INTERMITTENT) {
            if (callCount % intermittentN == 0) revert SinkDown();
        }
        if (m == Mode.GASBURN) {
            // Burn well past any ~100k stipend with storage writes; if the
            // caller forwarded unbounded gas this would still eventually
            // succeed — under the stipend it MUST out-of-gas the sub-call.
            for (uint256 i = 1; i <= 5000; i++) {
                _gasSinkSlot = i;
            }
        }
        if (m == Mode.REENTER_DELIVER) {
            reentryAttempts += 1;
            // Swallow the expected ReentrancyGuard revert so we can observe
            // whether the reentry ever succeeds (it must not).
            try IOverflowCrashLike(target).deliverOverflow() returns (bool okInner) {
                if (okInner) reentrySucceeded += 1;
            } catch {}
        }
        if (m == Mode.REENTER_PLACEBET) {
            reentryAttempts += 1;
            try IOverflowCrashLike(target).placeBet{value: 0}(10001) {
                reentrySucceeded += 1;
            } catch {}
        }
        totalFunded += msg.value;
    }
}

/// Wrong-selector / garbage sink: has NO fund() function, no receive(), no
/// fallback — any fund() call reverts at dispatch. The "malformed ABI" case.
contract NoFundSink {
    uint256 public nothing;

    function unrelated() external pure returns (uint256) {
        return 42;
    }
}

/// Forced-ETH helper: selfdestructs into a target, bypassing every payable
/// gate — for the §8.3 forced-ETH inertness vector.
contract ForceSend {
    constructor(address payable target) payable {
        selfdestruct(target);
    }
}
