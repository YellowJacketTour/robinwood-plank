// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IEnergyAdapter} from "../energy/IEnergyAdapter.sol";

/**
 * @notice Test-only stand-in for `EnergyBus` used ONLY by
 * `PlankAdapters.test.ts` to exercise `PlankBurnAdapter`/
 * `PlankLpRenounceAdapter`'s own governance gate (`preFinalizeOnly`), which
 * reads `IBusFinalized(bus).finalized()`. A plain EOA "bus" (the shape every
 * other adapter suite in this directory already uses for its non-governance
 * tests) has no such function, so this minimal stub provides one, plus a
 * `pushAndCall` helper that reproduces `EnergyBus._runPipe`'s own
 * transfer-then-execute call shape (plain `IERC20.transfer` followed by
 * `adapter.execute`) so `msg.sender` inside `execute()` is this stub's own
 * address, exactly like the real Bus. LOCAL HARDHAT TEST ONLY.
 */
contract MockFinalizableBus {
    using SafeERC20 for IERC20;

    bool public finalized;

    function finalize() external {
        finalized = true;
    }

    function pushAndCall(address adapter, address token, uint256 amount)
        external
        returns (uint256 used, bool skipped)
    {
        if (amount > 0) {
            IERC20(token).safeTransfer(adapter, amount);
        }
        return IEnergyAdapter(adapter).execute(amount);
    }
}
