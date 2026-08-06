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
        BURN_GAS // spin until out of gas
    }

    Mode public mode;
    uint256 public calls;
    bytes32 public lastPoint;
    bytes public lastData;

    constructor(Mode m) {
        mode = m;
    }

    function setMode(Mode m) external {
        mode = m;
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
        calls += 1;
        lastPoint = point;
        lastData = data;
    }
}
