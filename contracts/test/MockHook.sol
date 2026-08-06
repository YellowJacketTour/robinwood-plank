// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @notice A registrable observer hook, with a mode switch, for
 * `HookRegistryFacet` / `Hooks.*.test.ts`.
 *
 * `onHook` matches the signature `IndexFacetBase._fireHook` encodes with
 * (`abi.encodeWithSignature("onHook(bytes32,bytes)", point, data)`), so a
 * successful call always lands here regardless of mode.
 */
contract MockHook {
    enum Mode {
        RECORD, // succeed, record the call
        REVERT, // always revert
        BURN_GAS, // spin until out of gas
        REENTER // attempt to call back into `target` with `reentrantCalldata`
    }

    Mode public mode;
    uint256 public calls;
    bytes32 public lastPoint;
    bytes public lastData;

    /// @dev REENTER mode target + calldata, and what the reentrant attempt
    /// returned — set by `setReentrantTarget`, read by the finding-2 hostile
    /// reentrant-hook test to prove the attempted call reverted cleanly.
    address public target;
    bytes public reentrantCalldata;
    bool public reentrantOk;
    bytes public reentrantReturnData;

    constructor(Mode m) {
        mode = m;
    }

    function setMode(Mode m) external {
        mode = m;
    }

    function setReentrantTarget(address t, bytes calldata data) external {
        target = t;
        reentrantCalldata = data;
    }

    function onHook(bytes32 point, bytes calldata data) external {
        if (mode == Mode.REVERT) {
            revert("MockHook: reverting");
        }
        if (mode == Mode.BURN_GAS) {
            // Unbounded work — spins until it runs out of whatever gas it was
            // forwarded. If `_fireHook`'s gas bound were not real, this would
            // consume the CALLER's remaining gas too.
            uint256 i;
            while (true) {
                i++;
            }
        }
        if (mode == Mode.REENTER) {
            // Fired mid-checkpoint (or mid-sync), still inside the diamond's
            // `nonReentrant` window. Attempt to call straight back in — with
            // the guard in place this must revert with `ReentrantCall`.
            (bool ok, bytes memory ret) = target.call(reentrantCalldata);
            reentrantOk = ok;
            reentrantReturnData = ret;
        }
        calls += 1;
        lastPoint = point;
        lastData = data;
    }
}
