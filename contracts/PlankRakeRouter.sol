// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ReentrancyGuard} from "@openzeppelin/contracts/security/ReentrancyGuard.sol";

/// @notice The lottery's funding surface (PlankLottery.fund).
interface IPlankLotteryFundable {
    function fund() external payable;
}

/// @notice The crash Vault's community-return surface (PlankCrash.fundCommunityReturn).
interface IPlankVaultReturn {
    function fundCommunityReturn() external payable;
}

/**
 * PlankRakeRouter -- the ratified one-pass 25 / 69 / 6 split of NET crash
 * rake (net = gross minus the settling keeper's bounty, which PlankCrash pays
 * itself before routing). Successor to PlankRakeDistributor (push, post-Vault,
 * effective 24/24/12), PlankEconomicRouterV2 (prototype), and the v1 40/40/20
 * split (owner-ratified revision, SPEC-monotonic-vault-positive-sum-2026-09-05
 * §4: shifting weight from burn and founders into the community share is the
 * entire growth engine behind the participation-count vault/lottery bonus --
 * see PlankCrash.sol's maxVaultBonusBps and PlankLottery.sol's
 * carveHalfSaturationCeilingWei, both fed by this router's community leg).
 * It keeps V2's escrowed-pull shape, `accountedBalance`, and `rulesHash`.
 *
 * Mirrors lib/casino/economics.ts ratifiedRakeSplit() exactly:
 *   burn      = net * 2500 / 10000
 *   community = net * 6900 / 10000
 *   founders  = net - burn - community           (all integer dust -> founders)
 * and lib/casino/simulation.ts's community subdivision:
 *   lottery   = community * communityLotteryBps / 10000   (playtest: 6500)
 *   vault     = community - lottery                       -> PlankCrash.fundCommunityReturn
 *
 * Every leg is ESCROWED here and pushed by a permissionless claim* call to a
 * sink fixed at construction, so a reverting sink can never block settlement
 * (the crash only ever calls routeRake, which makes no external call). No
 * owner, no setters, no pause.
 */
contract PlankRakeRouter is ReentrancyGuard {
    uint256 private constant BPS = 10_000;
    uint256 public constant BURN_BPS = 2_500;
    uint256 public constant COMMUNITY_BPS = 6_900;
    // founders = BPS - BURN_BPS - COMMUNITY_BPS = 600 (6%), taken as the remainder.

    address public immutable source; // the PlankCrash allowed to route
    address payable public immutable burnSink; // PlankBurnEngine (receive())
    address public immutable lottery; // PlankLottery (fund())
    address public immutable vault; // PlankCrash (fundCommunityReturn())
    address payable public immutable founderSink;
    uint256 public immutable communityLotteryBps;
    bytes32 public immutable rulesHash;

    uint256 public burnEscrow;
    uint256 public lotteryEscrow;
    uint256 public vaultEscrow;
    uint256 public founderEscrow;

    uint256 public totalNetRake;
    uint256 public totalBurn;
    uint256 public totalLottery;
    uint256 public totalVault;
    uint256 public totalFounders;

    event RakeRouted(uint256 net, uint256 burn, uint256 lottery, uint256 vault, uint256 founders);
    event LegClaimed(bytes32 indexed leg, address indexed recipient, uint256 amount);

    error ZeroAddress();
    error BadConfig();
    error UnauthorizedSource();
    error NothingToClaim();
    error TransferFailed();

    constructor(
        address source_,
        address payable burnSink_,
        address lottery_,
        address vault_,
        address payable founderSink_,
        uint256 communityLotteryBps_
    ) {
        if (
            source_ == address(0) || burnSink_ == address(0) || lottery_ == address(0) || vault_ == address(0)
                || founderSink_ == address(0)
        ) revert ZeroAddress();
        if (communityLotteryBps_ > BPS) revert BadConfig();
        // The burn sink and the lottery are deployed BEFORE the router and are
        // called by claimBurn / claimLottery: an address without code would
        // strand those legs forever. source_ / vault_ are the (predicted, not
        // yet deployed) crash, so only non-zero can be required for them.
        if (burnSink_.code.length == 0 || lottery_.code.length == 0) revert BadConfig();
        source = source_;
        burnSink = burnSink_;
        lottery = lottery_;
        vault = vault_;
        founderSink = founderSink_;
        communityLotteryBps = communityLotteryBps_;
        rulesHash = keccak256(abi.encode(keccak256("plank.rake-router.v1"), BURN_BPS, COMMUNITY_BPS, communityLotteryBps_));
    }

    /// @notice Route one round's NET rake. Only the crash may call; no external
    ///         calls are made here, so this can never revert settlement for a
    ///         reason outside the crash's own control.
    function routeRake() external payable {
        if (msg.sender != source) revert UnauthorizedSource();
        uint256 net = msg.value;
        uint256 burnAmount = (net * BURN_BPS) / BPS;
        uint256 community = (net * COMMUNITY_BPS) / BPS;
        uint256 founders = net - burnAmount - community;
        uint256 lotteryAmount = (community * communityLotteryBps) / BPS;
        uint256 vaultAmount = community - lotteryAmount;

        burnEscrow += burnAmount;
        lotteryEscrow += lotteryAmount;
        vaultEscrow += vaultAmount;
        founderEscrow += founders;
        totalNetRake += net;
        totalBurn += burnAmount;
        totalLottery += lotteryAmount;
        totalVault += vaultAmount;
        totalFounders += founders;
        emit RakeRouted(net, burnAmount, lotteryAmount, vaultAmount, founders);
    }

    function claimBurn() external nonReentrant {
        uint256 amount = burnEscrow;
        if (amount == 0) revert NothingToClaim();
        burnEscrow = 0;
        (bool ok,) = burnSink.call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit LegClaimed(keccak256("BURN"), burnSink, amount);
    }

    function claimLottery() external nonReentrant {
        uint256 amount = lotteryEscrow;
        if (amount == 0) revert NothingToClaim();
        lotteryEscrow = 0;
        IPlankLotteryFundable(lottery).fund{value: amount}();
        emit LegClaimed(keccak256("LOTTERY"), lottery, amount);
    }

    function claimVault() external nonReentrant {
        uint256 amount = vaultEscrow;
        if (amount == 0) revert NothingToClaim();
        vaultEscrow = 0;
        IPlankVaultReturn(vault).fundCommunityReturn{value: amount}();
        emit LegClaimed(keccak256("VAULT"), vault, amount);
    }

    function claimFounders() external nonReentrant {
        uint256 amount = founderEscrow;
        if (amount == 0) revert NothingToClaim();
        founderEscrow = 0;
        (bool ok,) = founderSink.call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit LegClaimed(keccak256("FOUNDERS"), founderSink, amount);
    }

    function accountedBalance() public view returns (uint256) {
        return burnEscrow + lotteryEscrow + vaultEscrow + founderEscrow;
    }

    /// @notice Forced ETH (selfdestruct) is dead capital here, never a leg.
    function unclassifiedSurplus() external view returns (uint256) {
        uint256 accounted = accountedBalance();
        return address(this).balance > accounted ? address(this).balance - accounted : 0;
    }
}
