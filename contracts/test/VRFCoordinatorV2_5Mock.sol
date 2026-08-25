// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {VRFCoordinatorV2_5Mock} from "@chainlink/contracts/src/v0.8/vrf/mocks/VRFCoordinatorV2_5Mock.sol";

// A bare `import` of an unused contract gets tree-shaken by Hardhat 3's
// compiler (confirmed by actually trying it -- no artifact was produced).
// This empty subclass, unmodified beyond forwarding the constructor, is
// the standard pattern for pulling in a real, unmodified dependency
// contract for tests: real behavior, real bytecode, just a name Hardhat
// will actually emit an artifact for.
contract PlankCrashVRFCoordinatorMock is VRFCoordinatorV2_5Mock {
    constructor(
        uint96 baseFee,
        uint96 gasPrice,
        int256 weiPerUnitLink
    ) VRFCoordinatorV2_5Mock(baseFee, gasPrice, weiPerUnitLink) {}
}
