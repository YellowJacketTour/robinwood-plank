// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * ============================================================================
 *  UNAUDITED BY A THIRD PARTY. DO NOT DEPLOY WITH REAL VALUE UNTIL REVIEWED.
 *
 *  Phase 2 of docs/marketplank/SPEC.md — an NFTX-style instant liquidity
 *  vault for a single NFT collection. Unlike Seaport (Phase 1, already
 *  deployed and independently audited on Robinhood Chain), this is new code.
 *
 *  Revision 2 (2026-07-27) after an adversarial self-review that found and
 *  fixed six real defects — see test/contracts/VaultDrain.audit.test.ts,
 *  where each is pinned by a regression test:
 *    1. CRITICAL: selling shares against an empty share reserve returned the
 *       entire ETH pool for dust input. Total pool drain.
 *    2. CRITICAL: redemptions minted a fee without burning an offsetting
 *       amount, so share claims and NFT backing drifted apart permanently.
 *    3. Zero-output swaps accepted payment and returned nothing.
 *    4. seedLiquidity() was permissionless.
 *    5. HIGH: single-transaction random redemption let a contract caller
 *       inspect the result and revert to reroll — free rare-sniping.
 *    6. HIGH: targeted redemption could consume the NFT backing an
 *       already-paid-for pending random redemption.
 * ============================================================================
 */

import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/security/ReentrancyGuard.sol";

/**
 * @title MarketplankVault
 * @notice Deposit an NFT, mint one fungible vault share. Trade shares against
 * ETH on a constant-product pool. Redeem a share for an NFT — a specific one
 * for a premium, or a random one via commit-reveal.
 *
 * SOLVENCY INVARIANT, enforced after every state-changing call:
 *
 *     totalSupply() + pendingRedeemCount * SHARE_UNIT
 *         == heldTokenIds.length * SHARE_UNIT
 *
 * In words: every share that exists, plus every share already burned for a
 * redemption that hasn't been claimed yet, is backed one-to-one by an NFT
 * actually sitting in this contract. There is no path that creates a claim
 * the vault cannot honor.
 *
 * Deliberately excluded (see the scoping research): no pooled lending, no
 * oracle, no external AMM dependency for a peg, no owner-mutable fees, no
 * upgradeability, no admin withdrawal of pool ETH.
 */
contract MarketplankVault is ERC20, ReentrancyGuard, IERC721Receiver {
    IERC721 public immutable collection;

    /// @notice Fees in basis points (100 = 1%), fixed forever at deployment.
    uint256 public immutable mintFeeBps;
    uint256 public immutable redeemFeeBps;
    /// @notice Extra charge to pick an exact token ID instead of a random one.
    uint256 public immutable targetPremiumBps;

    /// @notice Receives fees and is the only address that may seed pool ETH.
    address public immutable treasury;

    uint256 private constant BPS_DENOMINATOR = 10_000;
    uint256 private constant SHARE_UNIT = 1e18;
    /// @dev EVM keeps only the last 256 block hashes available.
    uint256 private constant BLOCKHASH_WINDOW = 256;

    /// @dev Token IDs currently custodied, available for redemption.
    uint256[] private heldTokenIds;
    /// @dev tokenId => index+1 in heldTokenIds (0 means "not held").
    mapping(uint256 => uint256) private heldTokenIndex;

    /// @dev Constant-product pool: ETH side. Share side is balanceOf(this).
    uint256 public ethReserve;

    struct RedeemRequest {
        /// @dev Block whose hash seeds the draw. Shares are already burned.
        uint64 commitBlock;
        bool active;
    }

    mapping(address => RedeemRequest) public redeemRequests;
    /// @notice NFTs owed to committed-but-unclaimed random redemptions.
    uint256 public pendingRedeemCount;

    event Deposited(address indexed from, uint256 indexed tokenId);
    event RedeemRequested(address indexed by, uint64 commitBlock);
    event RedeemRefreshed(address indexed by, uint64 commitBlock);
    event Redeemed(address indexed to, uint256 indexed tokenId, bool targeted);
    event Bought(address indexed buyer, uint256 ethIn, uint256 sharesOut);
    event Sold(address indexed seller, uint256 sharesIn, uint256 ethOut);

    error FeeTooHigh();
    error EmptyVault();
    error TokenNotHeld();
    error InsufficientOutput();
    error TransferFailed();
    error NotTreasury();
    error RequestPending();
    error NoRequest();
    error TooSoon();
    error RandomnessExpired();
    error ReservedForPendingRedeem();
    error SolvencyBroken();

    constructor(
        IERC721 collection_,
        string memory name_,
        string memory symbol_,
        uint256 mintFeeBps_,
        uint256 redeemFeeBps_,
        uint256 targetPremiumBps_,
        address treasury_
    ) ERC20(name_, symbol_) {
        // Hard ceiling. These are immutable anyway, but this makes a
        // predatory-fee deployment impossible rather than merely unintended.
        if (mintFeeBps_ > 1_000 || redeemFeeBps_ > 1_000 || targetPremiumBps_ > 2_000) {
            revert FeeTooHigh();
        }
        if (treasury_ == address(0)) revert NotTreasury();
        collection = collection_;
        mintFeeBps = mintFeeBps_;
        redeemFeeBps = redeemFeeBps_;
        targetPremiumBps = targetPremiumBps_;
        treasury = treasury_;
    }

    // ── Deposit / redeem ───────────────────────────────────────────────────

    /// @notice Deposit an NFT you own, receive one share minus the mint fee.
    function deposit(uint256 tokenId) external nonReentrant {
        collection.safeTransferFrom(msg.sender, address(this), tokenId);
        _addHeldToken(tokenId);

        uint256 fee = (SHARE_UNIT * mintFeeBps) / BPS_DENOMINATOR;
        _mint(msg.sender, SHARE_UNIT - fee);
        if (fee > 0) _mint(treasury, fee);

        emit Deposited(msg.sender, tokenId);
        _assertSolvent();
    }

    /**
     * @notice Step 1 of a random redemption: burn the shares now, draw later.
     *
     * Burning up front is the whole point. If the draw and the payout happened
     * in one transaction, a contract caller could check which token it got and
     * revert the transaction to try again, repeating until it hit a rare one —
     * paying only gas to snipe the best NFTs out of the vault at the plain
     * redeem rate. Committing first makes the outcome unconditional.
     */
    function requestRandomRedeem() external nonReentrant {
        if (redeemRequests[msg.sender].active) revert RequestPending();
        // Reserve one NFT for this request, on top of anything already owed.
        if (heldTokenIds.length <= pendingRedeemCount) revert EmptyVault();

        uint256 fee = (SHARE_UNIT * redeemFeeBps) / BPS_DENOMINATOR;
        _burn(msg.sender, SHARE_UNIT + fee);
        if (fee > 0) _mint(treasury, fee);

        pendingRedeemCount += 1;
        redeemRequests[msg.sender] = RedeemRequest({
            commitBlock: uint64(block.number),
            active: true
        });

        emit RedeemRequested(msg.sender, uint64(block.number));
        _assertSolvent();
    }

    /// @notice Step 2: claim the NFT drawn from the committed block's hash.
    function claimRandomRedeem() external nonReentrant returns (uint256 tokenId) {
        RedeemRequest memory req = redeemRequests[msg.sender];
        if (!req.active) revert NoRequest();
        // The committed block's hash must exist, which it does not until the
        // next block is mined.
        if (block.number <= req.commitBlock) revert TooSoon();
        if (block.number > req.commitBlock + BLOCKHASH_WINDOW) revert RandomnessExpired();

        bytes32 seed = blockhash(req.commitBlock);
        // Defensive: a zero hash means the window lapsed between the check
        // above and here. Never draw from a zero seed — it is identical for
        // every caller.
        if (seed == bytes32(0)) revert RandomnessExpired();

        delete redeemRequests[msg.sender];
        pendingRedeemCount -= 1;

        uint256 index = uint256(keccak256(abi.encodePacked(seed, msg.sender))) %
            heldTokenIds.length;
        tokenId = heldTokenIds[index];

        _removeHeldToken(tokenId);
        collection.safeTransferFrom(address(this), msg.sender, tokenId);

        emit Redeemed(msg.sender, tokenId, false);
        _assertSolvent();
    }

    /**
     * @notice Re-anchor an expired request to a fresh block.
     * @dev Shares stay burned; this only replaces randomness that aged out of
     * the 256-block window. Without it, waiting too long would strand a
     * redemption the user already paid for.
     */
    function refreshRandomRedeem() external nonReentrant {
        RedeemRequest storage req = redeemRequests[msg.sender];
        if (!req.active) revert NoRequest();
        if (block.number <= req.commitBlock + BLOCKHASH_WINDOW) revert RequestPending();

        req.commitBlock = uint64(block.number);
        emit RedeemRefreshed(msg.sender, uint64(block.number));
    }

    /// @notice Redeem a specific token ID for a share plus the target premium.
    function redeemTarget(uint256 tokenId) external nonReentrant {
        if (heldTokenIndex[tokenId] == 0) revert TokenNotHeld();
        // Never consume an NFT that is already owed to a pending random
        // redemption whose shares have been burned.
        if (heldTokenIds.length <= pendingRedeemCount) revert ReservedForPendingRedeem();

        uint256 fee = (SHARE_UNIT * redeemFeeBps) / BPS_DENOMINATOR;
        uint256 premium = (SHARE_UNIT * targetPremiumBps) / BPS_DENOMINATOR;
        // Burn exactly one unit of backing plus the charges, then re-mint the
        // charges to the treasury. Net effect on supply is exactly -1 share
        // for exactly -1 NFT, which is what keeps the vault solvent.
        _burn(msg.sender, SHARE_UNIT + fee + premium);
        uint256 charges = fee + premium;
        if (charges > 0) _mint(treasury, charges);

        _removeHeldToken(tokenId);
        collection.safeTransferFrom(address(this), msg.sender, tokenId);

        emit Redeemed(msg.sender, tokenId, true);
        _assertSolvent();
    }

    // ── Constant-product pool ──────────────────────────────────────────────

    /// @notice Buy shares with ETH. `minSharesOut` is your slippage floor.
    function buyShares(uint256 minSharesOut)
        external
        payable
        nonReentrant
        returns (uint256 sharesOut)
    {
        uint256 shareReserve = balanceOf(address(this));
        if (shareReserve == 0 || ethReserve == 0) revert EmptyVault();

        // out = (in * reserveOut) / (reserveIn + in)
        sharesOut = (msg.value * shareReserve) / (ethReserve + msg.value);
        // Rounding can floor this to zero for dust input. Reverting is the
        // only honest outcome — otherwise the ETH is kept for nothing.
        if (sharesOut == 0 || sharesOut < minSharesOut) revert InsufficientOutput();

        ethReserve += msg.value;
        _transfer(address(this), msg.sender, sharesOut);
        emit Bought(msg.sender, msg.value, sharesOut);
    }

    /// @notice Sell shares for ETH. `minEthOut` is your slippage floor.
    function sellShares(uint256 sharesIn, uint256 minEthOut)
        external
        nonReentrant
        returns (uint256 ethOut)
    {
        uint256 shareReserve = balanceOf(address(this));
        // Both sides must be non-empty. With a zero share reserve the formula
        // below collapses to the entire ETH reserve for any input — the
        // critical drain this guard exists to stop.
        if (shareReserve == 0 || ethReserve == 0) revert EmptyVault();
        if (sharesIn == 0) revert InsufficientOutput();

        ethOut = (sharesIn * ethReserve) / (shareReserve + sharesIn);
        if (ethOut == 0 || ethOut < minEthOut) revert InsufficientOutput();

        // Effects before interaction; nonReentrant on top.
        _transfer(msg.sender, address(this), sharesIn);
        ethReserve -= ethOut;

        (bool ok, ) = msg.sender.call{value: ethOut}("");
        if (!ok) revert TransferFailed();
        emit Sold(msg.sender, sharesIn, ethOut);
    }

    /**
     * @notice Add ETH to the pool. Treasury only.
     * @dev There is deliberately no withdrawal path: pool ETH is committed
     * permanently, so the vault cannot be rugged by whoever holds the
     * treasury key.
     */
    function seedLiquidity() external payable {
        if (msg.sender != treasury) revert NotTreasury();
        ethReserve += msg.value;
    }

    // ── Views ──────────────────────────────────────────────────────────────

    function heldTokenCount() external view returns (uint256) {
        return heldTokenIds.length;
    }

    /// @notice NFTs redeemable right now, excluding those owed to pending draws.
    function availableTokenCount() external view returns (uint256) {
        uint256 held = heldTokenIds.length;
        return held > pendingRedeemCount ? held - pendingRedeemCount : 0;
    }

    function isTokenHeld(uint256 tokenId) external view returns (bool) {
        return heldTokenIndex[tokenId] != 0;
    }

    // ── Internals ──────────────────────────────────────────────────────────

    /// @dev The solvency invariant. Reverting here unwinds the whole call.
    function _assertSolvent() private view {
        if (totalSupply() + pendingRedeemCount * SHARE_UNIT != heldTokenIds.length * SHARE_UNIT) {
            revert SolvencyBroken();
        }
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
