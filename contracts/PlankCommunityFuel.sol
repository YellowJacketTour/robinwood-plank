// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ReentrancyGuard} from "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

interface IFuelToken {
    function balanceOf(address) external view returns (uint256);
    function totalSupply() external view returns (uint256);
    function burnFrom(address, uint256) external;
}
interface IFuelDestination {
    function currentRoundId() external view returns (uint256);
    // Prefix of PlankCrash's public Round getter; later fields are unused.
    function rounds(uint256) external view returns (uint8, uint64, uint64);
    function fundVault() external payable;
}

/// @notice Candidate sponsor-backed community fuel. NOT part of the mainnet deployment.
/// Burns never buy a personal payout or change a committed target/randomness.
/// The immutable matching rate is a sponsor offer, NOT a market-price oracle.
/// Every match must already be funded; a cap/quote failure burns nothing.
contract PlankCommunityFuel is ReentrancyGuard {
    IFuelToken public immutable plank;
    IFuelDestination public immutable crash;
    uint256 public immutable weiPerWholePlank;
    uint256 public immutable maxBoostPerRoundWei;
    uint256 public backing;
    uint256 public totalBurned;
    uint256 public totalDelivered;
    mapping(uint256 => uint256) public usedInRound;

    error BadConfig();
    error BettingClosed();
    error QuoteExpired();
    error WrongRound();
    error UnfundedQuote();
    error BurnMismatch();
    event Funded(address indexed sponsor, uint256 amount);
    event FuelBurned(uint256 indexed roundId, address indexed player, uint256 plankAmount, uint256 vaultWei);

    constructor(address token, address destination, uint256 rate, uint256 roundCap) {
        if (token.code.length == 0 || destination.code.length == 0 || rate == 0 || roundCap == 0) revert BadConfig();
        plank = IFuelToken(token);
        crash = IFuelDestination(destination);
        weiPerWholePlank = rate;
        maxBoostPerRoundWei = roundCap;
    }
    function fund() external payable {
        if (msg.value == 0) revert UnfundedQuote();
        backing += msg.value;
        emit Funded(msg.sender, msg.value);
    }
    function quote(uint256 amount) public view returns (uint256 roundId, uint256 boost, bool available) {
        roundId = crash.currentRoundId();
        (uint8 phase,,uint64 closesAt) = crash.rounds(roundId);
        boost = Math.mulDiv(amount, weiPerWholePlank, 1e18);
        available = phase == 0 && block.timestamp < closesAt && boost > 0 && boost <= backing
            && boost <= maxBoostPerRoundWei - usedInRound[roundId];
    }
    function burnFuel(uint256 amount, uint256 expectedRound, uint256 minimumBoost, uint256 deadline) external nonReentrant {
        if (block.timestamp > deadline) revert QuoteExpired();
        (uint256 roundId, uint256 boost, bool available) = quote(amount);
        if (roundId != expectedRound) revert WrongRound();
        (uint8 phase,,uint64 closesAt) = crash.rounds(roundId);
        if (phase != 0 || block.timestamp >= closesAt) revert BettingClosed();
        if (!available || minimumBoost == 0 || boost < minimumBoost) revert UnfundedQuote();
        backing -= boost;
        usedInRound[roundId] += boost;
        totalBurned += amount;
        totalDelivered += boost;
        uint256 supplyBefore = plank.totalSupply();
        uint256 balanceBefore = plank.balanceOf(msg.sender);
        plank.burnFrom(msg.sender, amount);
        if (plank.totalSupply() != supplyBefore - amount || plank.balanceOf(msg.sender) != balanceBefore - amount) revert BurnMismatch();
        crash.fundVault{value: boost}();
        emit FuelBurned(roundId, msg.sender, amount, boost);
    }
}
