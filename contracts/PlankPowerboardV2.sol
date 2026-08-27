// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ReentrancyGuard} from "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @notice Epoch-isolated accounting prototype for the Heartwood Powerboard.
/// Randomness/ticket selection intentionally remains outside this accounting
/// kernel until its separately specified verifier calls settleEpoch().
contract PlankPowerboardV2 is ReentrancyGuard {
    uint256 private constant BPS = 10_000;

    address public immutable settler;
    address payable public immutable founderSink;
    uint256 public immutable founderFeeBps;
    uint256 public immutable consolationBps;
    uint256 public immutable minPrizeStep;
    uint256 public immutable minBaseStep;
    uint256 public immutable baseGrowthBps;
    bytes32 public immutable rulesHash;

    uint256 public cycle;
    uint256 public currentBase;
    uint256 public nextEpochId = 1;
    uint256 public activeEpochId;
    uint256 public previousMissPrize;

    uint256 public growthEscrow;
    uint256 public resetEscrow;
    uint256 public rolloverCredit;
    uint256 public founderEscrow;
    uint256 public winnerLiabilities;

    uint256 public totalGrossConstituted;
    uint256 public totalFounderFees;
    uint256 public totalFounderFeeOnRollover;
    uint256 public totalNetPrizes;
    uint256 public totalConsolationPaid;
    uint256 public totalWinnerAwards;
    uint256 public jackpotHighWater;

    mapping(address => uint256) public claimable;

    struct Epoch {
        uint256 cycle;
        uint256 grossCapital;
        uint256 rolloverIn;
        uint256 freshIn;
        uint256 founderFee;
        uint256 founderFeeOnRollover;
        uint256 netPrize;
        uint256 payout;
        address winner;
        bool settled;
        bool hit;
    }

    mapping(uint256 => Epoch) public epochs;

    event GrowthFunded(address indexed funder, uint256 amount, uint256 available);
    event ResetFunded(address indexed funder, uint256 amount, uint256 available);
    event EpochSealed(uint256 indexed epoch, uint256 indexed cycle, uint256 gross, uint256 fee, uint256 netPrize);
    event EpochSettled(uint256 indexed epoch, address indexed winner, bool hit, uint256 payout, uint256 rollover);
    event CycleAdvanced(uint256 indexed cycle, uint256 newBase, uint256 grossResetConsumed);
    event Claimed(address indexed recipient, uint256 amount);
    event FounderFeesClaimed(uint256 amount);

    error ZeroAddress();
    error BadConfig();
    error ActiveEpoch();
    error NoActiveEpoch();
    error InsufficientGrowthFunding();
    error ResetNotCovered();
    error UnauthorizedSettler();
    error NothingToClaim();
    error TransferFailed();

    constructor(
        address settler_,
        address payable founderSink_,
        uint256 founderFeeBps_,
        uint256 consolationBps_,
        uint256 initialBase_,
        uint256 minPrizeStep_,
        uint256 minBaseStep_,
        uint256 baseGrowthBps_,
        bytes32 rulesHash_
    ) {
        if (settler_ == address(0) || founderSink_ == address(0)) revert ZeroAddress();
        if (
            founderFeeBps_ >= BPS || consolationBps_ >= BPS || initialBase_ == 0 ||
            minPrizeStep_ == 0 || minBaseStep_ == 0 || baseGrowthBps_ > BPS || rulesHash_ == bytes32(0)
        ) revert BadConfig();
        settler = settler_;
        founderSink = founderSink_;
        founderFeeBps = founderFeeBps_;
        consolationBps = consolationBps_;
        currentBase = initialBase_;
        minPrizeStep = minPrizeStep_;
        minBaseStep = minBaseStep_;
        baseGrowthBps = baseGrowthBps_;
        rulesHash = rulesHash_;
    }

    function fundGrowth() external payable {
        growthEscrow += msg.value;
        emit GrowthFunded(msg.sender, msg.value, growthEscrow);
    }

    function fundReset() external payable {
        resetEscrow += msg.value;
        emit ResetFunded(msg.sender, msg.value, resetEscrow);
    }

    function nextBase() public view returns (uint256) {
        uint256 proportional = Math.mulDiv(currentBase, baseGrowthBps, BPS);
        uint256 increment = proportional > minBaseStep ? proportional : minBaseStep;
        return currentBase + increment;
    }

    /// @notice Smallest gross amount whose exact floor-fee leaves targetNet.
    function minimumGross(uint256 targetNet) public view returns (uint256) {
        uint256 lo = targetNet;
        uint256 hi = Math.mulDiv(targetNet, BPS, BPS - founderFeeBps, Math.Rounding.Up);
        while (lo < hi) {
            uint256 mid = lo + (hi - lo) / 2;
            if (_netOfFee(mid) >= targetNet) hi = mid;
            else lo = mid + 1;
        }
        return lo;
    }

    function requiredResetCoverage() public view returns (uint256) {
        return minimumGross(nextBase());
    }

    function requiredFreshForNextEpoch() public view returns (uint256) {
        uint256 target = previousMissPrize == 0 ? currentBase : previousMissPrize + minPrizeStep;
        uint256 requiredGross = minimumGross(target);
        return requiredGross > rolloverCredit ? requiredGross - rolloverCredit : 0;
    }

    function sealNextEpoch() external {
        if (activeEpochId != 0) revert ActiveEpoch();
        if (resetEscrow < requiredResetCoverage()) revert ResetNotCovered();

        uint256 rollover = rolloverCredit;
        uint256 fresh = growthEscrow;
        uint256 gross = rollover + fresh;
        uint256 target = previousMissPrize == 0 ? currentBase : previousMissPrize + minPrizeStep;
        uint256 netPrize = _netOfFee(gross);
        if (netPrize < target) revert InsufficientGrowthFunding();

        uint256 fee = gross - netPrize;
        uint256 feeOnRollover = Math.mulDiv(rollover, founderFeeBps, BPS);
        uint256 id = nextEpochId++;
        epochs[id] = Epoch({
            cycle: cycle,
            grossCapital: gross,
            rolloverIn: rollover,
            freshIn: fresh,
            founderFee: fee,
            founderFeeOnRollover: feeOnRollover,
            netPrize: netPrize,
            payout: 0,
            winner: address(0),
            settled: false,
            hit: false
        });

        rolloverCredit = 0;
        growthEscrow = 0;
        founderEscrow += fee;
        activeEpochId = id;
        totalGrossConstituted += gross;
        totalFounderFees += fee;
        totalFounderFeeOnRollover += feeOnRollover;
        totalNetPrizes += netPrize;
        if (netPrize > jackpotHighWater) jackpotHighWater = netPrize;
        emit EpochSealed(id, cycle, gross, fee, netPrize);
    }

    /// @dev Only a future target-bound randomness verifier may call this.
    function settleEpoch(address winner, bool hit) external {
        if (msg.sender != settler) revert UnauthorizedSettler();
        if (winner == address(0)) revert ZeroAddress();
        uint256 id = activeEpochId;
        if (id == 0) revert NoActiveEpoch();
        Epoch storage epoch = epochs[id];
        uint256 payout;
        if (hit) {
            payout = epoch.netPrize;
            uint256 resetGross = minimumGross(nextBase());
            // Coverage was required at seal and cannot leave resetEscrow by
            // any other path, so a first-draw hit is always restart-safe.
            resetEscrow -= resetGross;
            rolloverCredit = resetGross;
            currentBase = nextBase();
            cycle += 1;
            previousMissPrize = 0;
            emit CycleAdvanced(cycle, currentBase, resetGross);
        } else {
            payout = Math.mulDiv(epoch.netPrize, consolationBps, BPS);
            rolloverCredit = epoch.netPrize - payout;
            previousMissPrize = epoch.netPrize;
            totalConsolationPaid += payout;
        }
        epoch.settled = true;
        epoch.hit = hit;
        epoch.winner = winner;
        epoch.payout = payout;
        activeEpochId = 0;
        claimable[winner] += payout;
        winnerLiabilities += payout;
        totalWinnerAwards += payout;
        emit EpochSettled(id, winner, hit, payout, rolloverCredit);
    }

    function claim() external nonReentrant {
        uint256 amount = claimable[msg.sender];
        if (amount == 0) revert NothingToClaim();
        claimable[msg.sender] = 0;
        winnerLiabilities -= amount;
        _send(payable(msg.sender), amount);
        emit Claimed(msg.sender, amount);
    }

    function claimFounderFees() external nonReentrant {
        uint256 amount = founderEscrow;
        if (amount == 0) revert NothingToClaim();
        founderEscrow = 0;
        _send(founderSink, amount);
        emit FounderFeesClaimed(amount);
    }

    function accountedBalance() public view returns (uint256) {
        uint256 activePrize = activeEpochId == 0 ? 0 : epochs[activeEpochId].netPrize;
        return growthEscrow + resetEscrow + rolloverCredit + founderEscrow + winnerLiabilities + activePrize;
    }

    function unclassifiedSurplus() external view returns (uint256) {
        uint256 accounted = accountedBalance();
        return address(this).balance > accounted ? address(this).balance - accounted : 0;
    }

    function _netOfFee(uint256 gross) private view returns (uint256) {
        return gross - Math.mulDiv(gross, founderFeeBps, BPS);
    }

    function _send(address payable recipient, uint256 amount) private {
        (bool ok, ) = recipient.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }
}
