// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IEnergyAdapter} from "../energy/IEnergyAdapter.sol";

interface IEnergyBusLike {
    function route() external returns (uint256);
}

/**
 * @notice Test-only stand-in for the six real Bus adapters (InventoryBuy,
 * CollectionLpRenounce, IdxBurn, PlankBurn, PlankLp, Dividend — PR3/4/5/6/7)
 * per ONESHOT §7 / SPEC §2.2. Records what it received and behaves per a
 * configurable `Mode` so `EnergyBus.test.ts` can exercise every BUS-* case
 * from TEST-MATRIX-AXIOM-1-ADVERSARIAL.md without depending on any real
 * swap/LP venue. LOCAL HARDHAT TEST ONLY.
 */
contract MockEnergyAdapter is IEnergyAdapter {
    using SafeERC20 for IERC20;

    enum Mode {
        SPEND_ALL, // consumes the full amountIn, returns nothing, skipped=false
        SKIP_ALL, // returns the entire amountIn back to the Bus, skipped=true
        PARTIAL, // consumes `partialBps` of amountIn, returns the rest, skipped=false
        REVERT, // always reverts — Bus must treat this as a skip via try/catch
        LIE_SKIP_BUT_KEEP // spends the WETH anyway but reports skipped=true (hostile)
    }

    IERC20 public immutable weth;
    Mode public mode;
    uint16 public partialBps = 5_000;

    uint256 public totalReceived;
    uint256 public callCount;
    uint256 public lastAmountIn;

    // Reentrancy-attack wiring for BUS-5.
    address public reenterTarget;
    bool public reenterArmed;
    uint256 public reenterAttempts;
    bool public reenterSucceeded;

    constructor(address weth_) {
        weth = IERC20(weth_);
    }

    function setMode(Mode mode_) external {
        mode = mode_;
    }

    function setPartialBps(uint16 bps_) external {
        partialBps = bps_;
    }

    function armReenter(address busAddr) external {
        reenterTarget = busAddr;
        reenterArmed = true;
    }

    function execute(uint256 amountIn) external override returns (uint256 used, bool skipped) {
        callCount += 1;
        lastAmountIn = amountIn;
        totalReceived += amountIn;

        if (reenterArmed) {
            // Attempt to re-enter route() mid-pipe. Uses a raw, swallowed
            // call (rather than the typed interface call) so that even
            // though the Bus's nonReentrant guard makes the inner route()
            // revert, THIS execute() call keeps running and its own state
            // (reenterAttempts / reenterSucceeded) survives to be inspected
            // by the test — proving the guard fired rather than merely
            // proving "something reverted somewhere".
            reenterAttempts += 1;
            (bool ok, ) = reenterTarget.call(abi.encodeWithSelector(IEnergyBusLike.route.selector));
            reenterSucceeded = ok;
        }

        if (mode == Mode.SPEND_ALL) {
            return (amountIn, false);
        } else if (mode == Mode.SKIP_ALL) {
            if (amountIn > 0) {
                weth.safeTransfer(msg.sender, amountIn);
            }
            return (0, true);
        } else if (mode == Mode.PARTIAL) {
            uint256 spend = (amountIn * partialBps) / 10_000;
            uint256 refund = amountIn - spend;
            if (refund > 0) {
                weth.safeTransfer(msg.sender, refund);
            }
            return (spend, false);
        } else if (mode == Mode.LIE_SKIP_BUT_KEEP) {
            // Hostile: keeps the WETH but claims skipped=true. The Bus must
            // reconcile off observed balance delta, not this return value,
            // so this cannot be used to double-spend Pipe D's slice.
            return (0, true);
        } else {
            revert("MockEnergyAdapter: forced revert");
        }
    }
}
