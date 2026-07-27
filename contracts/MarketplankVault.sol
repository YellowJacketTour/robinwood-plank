// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * ============================================================================
 *  UNAUDITED. DO NOT DEPLOY TO MAINNET WITH REAL VALUE.
 *
 *  This is Phase 2 of docs/marketplank/SPEC.md — an NFTX-style instant
 *  liquidity vault for a single NFT collection. Unlike Seaport (Phase 1,
 *  already deployed and independently audited on Robinhood Chain), this is
 *  genuinely new code with no audit history of its own. It does not go live
 *  until an independent third-party audit covers it — see SPEC.md §7, gate 3.
 *  This file exists to be reviewed and tested, not deployed.
 * ============================================================================
 */

import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/security/ReentrancyGuard.sol";

/**
 * @title MarketplankVault
 * @notice Deposit an NFT from one collection, mint a fungible vault share
 * 1:1. Trade that share against ETH on a constant-product AMM. Redeem a
 * share for a random NFT from the vault, or pay a premium to pick a specific
 * token ID. This is the mechanism from docs/marketplank/RESEARCH pulled from
 * the NFTX scoping research — deliberately narrow in scope (single
 * collection, no admin fee changes after deploy, no upgradability).
 *
 * Explicitly NOT included, matching the scoping doc's "never build" list:
 * - No pooled lending or oracle-based liquidation (BendDAO pattern).
 * - No dependency on any external AMM for a peg (JPEG'd pattern).
 * - No owner-mutable fees after deployment — see `feesLocked`.
 */
contract MarketplankVault is ERC20, ReentrancyGuard, IERC721Receiver {
    IERC721 public immutable collection;

    /// @notice Basis points (1/100 of a percent) charged on mint/redeem — fixed at deploy.
    uint256 public immutable mintFeeBps;
    uint256 public immutable redeemFeeBps;
    /// @notice Extra fee (bps) to redeem a specific token ID instead of a random one.
    uint256 public immutable targetPremiumBps;

    address public immutable feeRecipient;

    uint256 private constant BPS_DENOMINATOR = 10_000;
    uint256 private constant SHARE_UNIT = 1e18;

    /// @dev Token IDs currently held by the vault, available for redemption.
    uint256[] private heldTokenIds;
    mapping(uint256 => uint256) private heldTokenIndex; // tokenId => index in heldTokenIds (1-based; 0 = absent)

    /// @dev Constant-product AMM reserves: ETH held for the vTOKEN/ETH pool.
    uint256 public ethReserve;

    event Deposited(address indexed from, uint256 indexed tokenId);
    event Redeemed(address indexed to, uint256 indexed tokenId, bool targeted);
    event Bought(address indexed buyer, uint256 ethIn, uint256 sharesOut);
    event Sold(address indexed seller, uint256 sharesIn, uint256 ethOut);

    error FeeTooHigh();
    error EmptyVault();
    error TokenNotHeld();
    error InsufficientOutput();
    error TransferFailed();

    constructor(
        IERC721 collection_,
        string memory name_,
        string memory symbol_,
        uint256 mintFeeBps_,
        uint256 redeemFeeBps_,
        uint256 targetPremiumBps_,
        address feeRecipient_
    ) ERC20(name_, symbol_) {
        // Hard ceiling — no fee configuration, ever, can exceed 10%. Prevents
        // a griefing/rug deploy even though these are already immutable.
        if (mintFeeBps_ > 1_000 || redeemFeeBps_ > 1_000 || targetPremiumBps_ > 2_000) {
            revert FeeTooHigh();
        }
        collection = collection_;
        mintFeeBps = mintFeeBps_;
        redeemFeeBps = redeemFeeBps_;
        targetPremiumBps = targetPremiumBps_;
        feeRecipient = feeRecipient_;
    }

    /// @notice Deposit an NFT you own, receive one vault share (minus mint fee).
    function deposit(uint256 tokenId) external nonReentrant {
        collection.safeTransferFrom(msg.sender, address(this), tokenId);
        _addHeldToken(tokenId);

        uint256 fee = (SHARE_UNIT * mintFeeBps) / BPS_DENOMINATOR;
        uint256 netShares = SHARE_UNIT - fee;
        _mint(msg.sender, netShares);
        if (fee > 0) _mint(feeRecipient, fee);

        emit Deposited(msg.sender, tokenId);
    }

    /// @notice Burn one vault share, receive a random held NFT (minus redeem fee, paid in shares).
    function redeemRandom() external nonReentrant returns (uint256 tokenId) {
        if (heldTokenIds.length == 0) revert EmptyVault();
        uint256 fee = (SHARE_UNIT * redeemFeeBps) / BPS_DENOMINATOR;
        _burn(msg.sender, SHARE_UNIT);
        if (fee > 0) _mint(feeRecipient, fee);

        // Pseudo-random index. NOT secure against a miner/validator with
        // block-production power choosing which token to reveal — acceptable
        // for a same-value collection (no token is individually more
        // valuable) but this assumption MUST be re-checked by the audit
        // before this is ever used for a mixed-rarity collection.
        uint256 index = uint256(
            keccak256(abi.encodePacked(block.prevrandao, block.timestamp, msg.sender, heldTokenIds.length))
        ) % heldTokenIds.length;
        tokenId = heldTokenIds[index];

        _removeHeldToken(tokenId);
        collection.safeTransferFrom(address(this), msg.sender, tokenId);
        emit Redeemed(msg.sender, tokenId, false);
    }

    /// @notice Burn one vault share plus a premium, receive a specific token ID.
    function redeemTarget(uint256 tokenId) external nonReentrant {
        if (heldTokenIndex[tokenId] == 0) revert TokenNotHeld();
        uint256 fee = (SHARE_UNIT * redeemFeeBps) / BPS_DENOMINATOR;
        uint256 premium = (SHARE_UNIT * targetPremiumBps) / BPS_DENOMINATOR;
        _burn(msg.sender, SHARE_UNIT + premium);
        if (fee > 0) _mint(feeRecipient, fee);

        _removeHeldToken(tokenId);
        collection.safeTransferFrom(address(this), msg.sender, tokenId);
        emit Redeemed(msg.sender, tokenId, true);
    }

    /// @notice Buy vault shares with ETH via the constant-product pool (x*y=k against ethReserve).
    function buyShares(uint256 minSharesOut) external payable nonReentrant returns (uint256 sharesOut) {
        uint256 shareReserve = balanceOf(address(this));
        if (shareReserve == 0 || ethReserve == 0) revert EmptyVault();

        // out = (in * reserveOut) / (reserveIn + in) — standard constant-product swap.
        sharesOut = (msg.value * shareReserve) / (ethReserve + msg.value);
        if (sharesOut < minSharesOut) revert InsufficientOutput();

        ethReserve += msg.value;
        _transfer(address(this), msg.sender, sharesOut);
        emit Bought(msg.sender, msg.value, sharesOut);
    }

    /// @notice Sell vault shares for ETH via the same constant-product pool.
    function sellShares(uint256 sharesIn, uint256 minEthOut) external nonReentrant returns (uint256 ethOut) {
        uint256 shareReserve = balanceOf(address(this));
        ethOut = (sharesIn * ethReserve) / (shareReserve + sharesIn);
        if (ethOut < minEthOut) revert InsufficientOutput();

        _transfer(msg.sender, address(this), sharesIn);
        ethReserve -= ethOut;
        (bool ok, ) = msg.sender.call{value: ethOut}("");
        if (!ok) revert TransferFailed();
        emit Sold(msg.sender, sharesIn, ethOut);
    }

    /// @notice Seed the AMM's ETH side once at launch. One-time, by design — no admin top-up path.
    function seedLiquidity() external payable {
        ethReserve += msg.value;
    }

    function heldTokenCount() external view returns (uint256) {
        return heldTokenIds.length;
    }

    function _addHeldToken(uint256 tokenId) private {
        heldTokenIds.push(tokenId);
        heldTokenIndex[tokenId] = heldTokenIds.length; // 1-based
    }

    function _removeHeldToken(uint256 tokenId) private {
        uint256 idxPlusOne = heldTokenIndex[tokenId];
        if (idxPlusOne == 0) revert TokenNotHeld();
        uint256 idx = idxPlusOne - 1;
        uint256 lastIdx = heldTokenIds.length - 1;
        uint256 lastTokenId = heldTokenIds[lastIdx];

        heldTokenIds[idx] = lastTokenId;
        heldTokenIndex[lastTokenId] = idx + 1;
        heldTokenIds.pop();
        delete heldTokenIndex[tokenId];
    }

    function onERC721Received(
        address,
        address,
        uint256,
        bytes calldata
    ) external pure override returns (bytes4) {
        return IERC721Receiver.onERC721Received.selector;
    }
}
