// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ReentrancyGuard} from "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @notice One-pass router for the ratified Plank crash rake. This is an
/// additive V2 prototype: historical distributors and liabilities are not
/// mutated or imported.
contract PlankEconomicRouterV2 is ReentrancyGuard {
    uint256 private constant BPS = 10_000;
    uint256 public constant BURN_BPS = 4_000;
    uint256 public constant COMMUNITY_BPS = 4_000;
    uint256 public constant MAX_KEEPER_BPS = 500;

    address payable public immutable burnSink;
    address payable public immutable communitySink;
    address payable public immutable founderSink;
    uint256 public immutable keeperBps;
    bytes32 public immutable rulesHash;

    mapping(address => bool) public isSource;
    mapping(address => uint256) public keeperEscrow;

    uint256 public burnEscrow;
    uint256 public communityEscrow;
    uint256 public founderEscrow;
    uint256 public totalKeeperEscrow;

    uint256 public totalGrossRake;
    uint256 public totalKeeper;
    uint256 public totalBurn;
    uint256 public totalCommunity;
    uint256 public totalFounders;

    event RakeRouted(
        address indexed source,
        address indexed keeper,
        uint256 grossRake,
        uint256 keeperAmount,
        uint256 burnAmount,
        uint256 communityAmount,
        uint256 founderAmount
    );
    event EscrowClaimed(bytes32 indexed leg, address indexed recipient, uint256 amount);

    error ZeroAddress();
    error BadConfig();
    error UnauthorizedSource();
    error NothingToClaim();
    error TransferFailed();

    constructor(
        address payable burnSink_,
        address payable communitySink_,
        address payable founderSink_,
        address[] memory sources_,
        uint256 keeperBps_,
        bytes32 rulesHash_
    ) {
        if (burnSink_ == address(0) || communitySink_ == address(0) || founderSink_ == address(0)) {
            revert ZeroAddress();
        }
        if (keeperBps_ > MAX_KEEPER_BPS || rulesHash_ == bytes32(0)) revert BadConfig();
        burnSink = burnSink_;
        communitySink = communitySink_;
        founderSink = founderSink_;
        keeperBps = keeperBps_;
        rulesHash = rulesHash_;
        for (uint256 i; i < sources_.length; ++i) {
            if (sources_[i] == address(0)) revert ZeroAddress();
            isSource[sources_[i]] = true;
        }
    }

    /// @dev Gross rake must contain fresh-wager rake only. Vault seeds,
    /// donations, fuel backing, and rollover never enter this function.
    function routeRake(address keeper) external payable {
        if (!isSource[msg.sender]) revert UnauthorizedSource();
        if (keeperBps != 0 && keeper == address(0)) revert ZeroAddress();

        uint256 gross = msg.value;
        uint256 keeperAmount = Math.mulDiv(gross, keeperBps, BPS);
        uint256 net = gross - keeperAmount;
        uint256 burnAmount = Math.mulDiv(net, BURN_BPS, BPS);
        uint256 communityAmount = Math.mulDiv(net, COMMUNITY_BPS, BPS);
        uint256 founderAmount = net - burnAmount - communityAmount;

        totalGrossRake += gross;
        totalKeeper += keeperAmount;
        totalBurn += burnAmount;
        totalCommunity += communityAmount;
        totalFounders += founderAmount;
        if (keeperAmount != 0) {
            keeperEscrow[keeper] += keeperAmount;
            totalKeeperEscrow += keeperAmount;
        }
        burnEscrow += burnAmount;
        communityEscrow += communityAmount;
        founderEscrow += founderAmount;

        emit RakeRouted(
            msg.sender,
            keeper,
            gross,
            keeperAmount,
            burnAmount,
            communityAmount,
            founderAmount
        );
    }

    function claimBurn() external { _claimLeg(keccak256("BURN"), burnSink, 0); }
    function claimCommunity() external { _claimLeg(keccak256("COMMUNITY"), communitySink, 1); }
    function claimFounders() external { _claimLeg(keccak256("FOUNDERS"), founderSink, 2); }

    function claimKeeper() external nonReentrant {
        uint256 amount = keeperEscrow[msg.sender];
        if (amount == 0) revert NothingToClaim();
        keeperEscrow[msg.sender] = 0;
        totalKeeperEscrow -= amount;
        _send(payable(msg.sender), amount);
        emit EscrowClaimed(keccak256("KEEPER"), msg.sender, amount);
    }

    function accountedBalance() public view returns (uint256) {
        return burnEscrow + communityEscrow + founderEscrow + totalKeeperEscrow;
    }

    function unclassifiedSurplus() external view returns (uint256) {
        uint256 accounted = accountedBalance();
        return address(this).balance > accounted ? address(this).balance - accounted : 0;
    }

    function _claimLeg(bytes32 leg, address payable recipient, uint256 kind) private nonReentrant {
        uint256 amount;
        if (kind == 0) { amount = burnEscrow; burnEscrow = 0; }
        else if (kind == 1) { amount = communityEscrow; communityEscrow = 0; }
        else { amount = founderEscrow; founderEscrow = 0; }
        if (amount == 0) revert NothingToClaim();
        _send(recipient, amount);
        emit EscrowClaimed(leg, recipient, amount);
    }

    function _send(address payable recipient, uint256 amount) private {
        (bool ok, ) = recipient.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }
}
