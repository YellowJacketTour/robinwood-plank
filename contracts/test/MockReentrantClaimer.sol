// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface IDistributor {
    function stake(uint256 shares) external;

    function claim() external returns (uint256);

    function claimable(address account) external view returns (uint256);
}

/**
 * @notice A hostile dividend recipient. On being paid, it calls `claim()`
 * again from inside its own `receive()` — the classic re-entrant drain — and
 * counts how much ETH it managed to extract in total.
 *
 * Two modes, because a reentrancy test that only proves "it reverts" is a weak
 * test: it can prove the guard fires, but it cannot prove the accounting
 * underneath the guard was ever right. `attack = true` re-enters and shows the
 * whole claim reverts; `attack = false` takes the payment quietly, so the
 * suite can pin the EXACT amount extracted and assert it is precisely what was
 * owed and not one wei more.
 *
 * Never deployed anywhere real.
 */
contract MockReentrantClaimer {
    IDistributor public immutable dist;
    bool public attack;
    uint256 public reenterAttempts;
    uint256 public received;

    constructor(IDistributor dist_) {
        dist = dist_;
    }

    function setAttack(bool on) external {
        attack = on;
    }

    function stakeInto(IERC20 shareToken, address distAddr, uint256 amount) external {
        shareToken.approve(distAddr, amount);
        dist.stake(amount);
    }

    function doClaim() external returns (uint256) {
        return dist.claim();
    }

    receive() external payable {
        received += msg.value;
        if (attack) {
            reenterAttempts += 1;
            // Re-enter. Two independent things must stop this from paying
            // twice: `nonReentrant`, and — underneath it — the fact that
            // `owed` was already zeroed before this call was ever made.
            dist.claim();
        }
    }
}
