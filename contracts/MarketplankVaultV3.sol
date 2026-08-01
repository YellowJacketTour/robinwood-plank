// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * ============================================================================
 *          __________
 *        .' .  .  . '._            ____   _         _    _   _  _  __
 *      .'____________ '._         |  _ \ | |       / \  | \ | || |/ /
 *     |  ,-.      ,-.   |'.        | |_) || |      / _ \ |  \| || ' /
 *     | ( o )    ( o )  | |        |  __/ | |___  / ___ \| |\  || . \
 *     |  `-'      `-'   | |        |_|    |_____|/_/   \_\_| \_||_|\_\
 *     |                 | |
 *     |  '-.______.-'   | |        Premium Plank Liquidity
 *     |    .      .     |,'        share token: vROBIN
 *     |  .    .     .   |
 *     |    .    .    .  |          "it's just a plank —
 *     |  .    .    .    |           but it makes a market."
 *     | .    .    .   . |
 *     |_________________|
 *
 *  Deposit an NFT, mint one fungible vault share. Trade shares against ETH on a
 *  constant-product pool with a 30 bps swap fee. Provide liquidity for a
 *  proportional claim on the pool. Redeem a share for an NFT — a specific one
 *  for an ETH premium, or a random one via drand commit-reveal.
 *
 *  Design:
 *    - Proportional LP: add/remove mint/burn against CURRENT reserves, so a
 *      contributor absorbs any price move they cause. LP is internal and
 *      NON-TRANSFERABLE.
 *    - Explicit shareReserve / ethReserve (not live balances): a stray transfer
 *      is inert dead capital, so donation-inflation is impossible; no receive().
 *    - ETH-denominated flat fees kept in accruedFees, paid only to the immutable
 *      treasury via withdrawFees() — never pushed inside deposit/redeem.
 *    - Seed lock: openPool() mints L0 = sqrt(E*S) LP to address(0) forever, so
 *      pool ETH is never withdrawable and reserves stay strictly positive.
 *    - depositMany / redeemTargetMany for batches; VAULT_VERSION +
 *      capabilities() / poolComposition() views.
 *
 *  Excluded: no oracle, no external AMM, no owner-mutable fees, no
 *  upgradeability, no admin withdrawal of pool ETH, no pause.
 *
 *  SOLVENCY INVARIANT (after every NFT/share-moving call):
 *      totalSupply() + pendingRedeemCount * SHARE_UNIT == heldTokenIds.length * SHARE_UNIT
 *  ETH BACKING INVARIANT (after every ETH-moving call):
 *      address(this).balance >= ethReserve + accruedFees
 * ============================================================================
 */

import {IDrandBeacon} from "./IDrandBeacon.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/**
 * @title MarketplankVaultV3
 * @notice Deposit an NFT, mint one fungible vault share. Trade shares against
 * ETH on a constant-product pool with a swap fee. Provide liquidity for a
 * proportional claim on the pool. Redeem a share for an NFT — a specific one
 * for a premium, or a random one via drand commit-reveal.
 */
contract MarketplankVaultV3 is ERC20, ReentrancyGuard, IERC721Receiver {
    /// @notice Generation marker so the client never has to sniff bytecode.
    uint256 public constant VAULT_VERSION = 3;

    IERC721 public immutable collection;

    /// @notice Flat fees in wei, fixed forever at deployment.
    uint256 public immutable mintFeeWei;
    uint256 public immutable redeemFeeWei;
    /// @notice Extra ETH to pick an exact token ID instead of a random one.
    uint256 public immutable targetPremiumWei;
    /// @notice AMM swap fee in basis points, kept in the reserve for LPs.
    uint256 public immutable swapFeeBps;

    /// @notice Receives fees and is the only address that may seed the pool.
    address public immutable treasury;

    /// @notice The verified drand round cache this vault draws its seed from.
    IDrandBeacon public immutable beacon;

    /**
     * @notice True once the treasury has explicitly opened the pool.
     * @dev One-way, permanent. While false, buyShares/sellShares/addLiquidity/
     * removeLiquidity revert PoolNotOpen; once true, seeding reverts forever.
     */
    bool public poolOpen;

    uint256 private constant BPS_DENOMINATOR = 10_000;
    uint256 private constant SHARE_UNIT = 1e18;

    /// @dev Wei fee ceilings — a predatory-fee deployment is impossible, not
    /// merely unintended.
    uint256 private constant MAX_MINT_FEE_WEI = 0.05 ether;
    uint256 private constant MAX_REDEEM_FEE_WEI = 0.05 ether;
    uint256 private constant MAX_TARGET_PREMIUM_WEI = 0.1 ether;
    uint256 private constant MAX_SWAP_FEE_BPS = 100;

    /// @dev A LP floor stronger than UniV2's 1000-wei MINIMUM_LIQUIDITY.
    uint256 private constant MIN_INITIAL_LIQUIDITY = 1e3;

    /// @dev Cap batch size so a loop cannot exceed block gas and strand a user.
    uint256 private constant MAX_BATCH = 50;

    uint64 private constant ROUND_LEAD = 1;
    uint64 private constant ROUND_EXPIRY = 28_800;

    /// @dev Token IDs currently custodied, available for redemption.
    uint256[] private heldTokenIds;
    /// @dev tokenId => index+1 in heldTokenIds (0 means "not held").
    mapping(uint256 => uint256) private heldTokenIndex;

    /// @dev Constant-product pool reserves. BOTH are explicit storage — see
    /// header note 2 for why the share side is not balanceOf(address(this)).
    uint256 public ethReserve;
    uint256 public shareReserve;

    /// @notice ETH fees awaiting a withdrawFees() pull. Never part of a
    /// reserve; excluded from the AMM and from removeLiquidity payouts.
    uint256 public accruedFees;

    /// @notice Proportional LP bookkeeping. Non-transferable by design.
    mapping(address => uint256) public lpBalance;
    uint256 public totalLpSupply;

    struct RedeemRequest {
        uint64 targetRound;
        uint64 frozenLen;
        bool active;
        bool pinned;
        uint256 drawnTokenId;
    }

    mapping(address => RedeemRequest) public redeemRequests;
    uint96 public pendingRedeemCount;
    address public pendingRequester;

    event Deposited(address indexed from, uint256 indexed tokenId);
    event RedeemRequested(address indexed by, uint64 targetRound);
    event DrawPinned(address indexed by, uint256 indexed tokenId);
    event RedeemForfeited(address indexed by);
    event SharesSeeded(uint256 shares, uint256 ethIn);
    event Redeemed(address indexed to, uint256 indexed tokenId, bool targeted);
    event Bought(address indexed buyer, uint256 ethIn, uint256 sharesOut);
    event Sold(address indexed seller, uint256 sharesIn, uint256 ethOut);
    event PoolOpened(uint256 ethReserve, uint256 shareReserve, uint256 lockedLp);
    event LiquidityAdded(address indexed from, uint256 sharesIn, uint256 ethIn, uint256 lpMinted);
    event LiquidityRemoved(address indexed to, uint256 sharesOut, uint256 ethOut, uint256 lpBurned);
    event FeesWithdrawn(uint256 amount);

    error FeeTooHigh();
    error IncorrectFee();
    error EmptyVault();
    error TokenNotHeld();
    error InsufficientOutput();
    error TransferFailed();
    error NotTreasury();
    error RequestPending();
    error NoRequest();
    error TooSoon();
    error RandomnessNotAvailable();
    error RandomnessExpired();
    error InvalidBeacon();
    error ReservedForPendingRedeem();
    error SolvencyBroken();
    error EthBackingBroken();
    error DrawNotPinned();
    error NothingToSeed();
    error AlreadyHeld();
    error BootstrapComplete();
    error PoolNotOpen();
    error PoolAlreadyOpen();
    error BadBatch();
    error InsufficientLiquidity();
    error NoFees();

    constructor(
        IERC721 collection_,
        string memory name_,
        string memory symbol_,
        uint256 mintFeeWei_,
        uint256 redeemFeeWei_,
        uint256 targetPremiumWei_,
        uint256 swapFeeBps_,
        address treasury_,
        IDrandBeacon beacon_
    ) ERC20(name_, symbol_) {
        if (
            mintFeeWei_ > MAX_MINT_FEE_WEI ||
            redeemFeeWei_ > MAX_REDEEM_FEE_WEI ||
            targetPremiumWei_ > MAX_TARGET_PREMIUM_WEI ||
            swapFeeBps_ > MAX_SWAP_FEE_BPS
        ) {
            revert FeeTooHigh();
        }
        if (treasury_ == address(0)) revert NotTreasury();
        if (address(beacon_) == address(0)) revert InvalidBeacon();
        beacon = beacon_;
        collection = collection_;
        mintFeeWei = mintFeeWei_;
        redeemFeeWei = redeemFeeWei_;
        targetPremiumWei = targetPremiumWei_;
        swapFeeBps = swapFeeBps_;
        treasury = treasury_;
    }

    // ── Deposit / redeem ───────────────────────────────────────────────────

    /// @notice Deposit an NFT you own, receive exactly one share. Pay mintFeeWei.
    function deposit(uint256 tokenId) external payable nonReentrant {
        if (msg.value != mintFeeWei) revert IncorrectFee();
        _pinPendingDraw();
        collection.safeTransferFrom(msg.sender, address(this), tokenId);
        _addHeldToken(tokenId);
        _mint(msg.sender, SHARE_UNIT);
        accruedFees += msg.value;
        emit Deposited(msg.sender, tokenId);
        _assertSolvent();
    }

    /// @notice Deposit several NFTs in one transaction. Pay mintFeeWei * n.
    function depositMany(uint256[] calldata tokenIds) external payable nonReentrant {
        uint256 n = tokenIds.length;
        if (n == 0 || n > MAX_BATCH) revert BadBatch();
        if (msg.value != mintFeeWei * n) revert IncorrectFee();
        // Pin once before any append; appends cannot move a frozen index.
        _pinPendingDraw();
        for (uint256 i = 0; i < n; i++) {
            collection.safeTransferFrom(msg.sender, address(this), tokenIds[i]);
            _addHeldToken(tokenIds[i]);
        }
        // Single mint keeps the transiently-off invariant unobservable behind
        // nonReentrant; the collection's callback is into our own pure hook.
        _mint(msg.sender, SHARE_UNIT * n);
        accruedFees += msg.value;
        _assertSolvent();
    }

    /**
     * @notice Step 1 of a random redemption: burn one share now, draw later.
     * Pay redeemFeeWei. The commit-reveal draws against a future drand round so
     * the outcome cannot be predicted or ground at request time.
     */
    function requestRandomRedeem() external payable nonReentrant {
        if (msg.value != redeemFeeWei) revert IncorrectFee();
        if (pendingRequester != address(0)) revert RequestPending();
        if (heldTokenIds.length <= pendingRedeemCount) revert EmptyVault();

        _burn(msg.sender, SHARE_UNIT);
        accruedFees += msg.value;

        uint64 targetRound = beacon.nextRoundAfter(block.timestamp) + ROUND_LEAD;
        pendingRedeemCount += 1;
        pendingRequester = msg.sender;
        redeemRequests[msg.sender] = RedeemRequest({
            targetRound: targetRound,
            frozenLen: uint64(heldTokenIds.length),
            active: true,
            pinned: false,
            drawnTokenId: 0
        });

        emit RedeemRequested(msg.sender, targetRound);
        _assertSolvent();
    }

    /// @notice Resolve the pending draw to a concrete tokenId. Permissionless.
    function pinPendingDraw() external nonReentrant {
        _pinPendingDraw();
        address r = pendingRequester;
        if (r != address(0) && !redeemRequests[r].pinned) revert DrawNotPinned();
    }

    /// @notice Step 2: claim the NFT this request was pinned to. No fee here —
    /// it was paid at request time, and settlement must stay pushable by anyone.
    function claimRandomRedeem() external nonReentrant returns (uint256 tokenId) {
        return _settle(msg.sender);
    }

    /// @notice Settle someone else's pending draw, delivering to them.
    function claimRandomRedeemFor(address requester)
        external
        nonReentrant
        returns (uint256 tokenId)
    {
        return _settle(requester);
    }

    /// @notice Burn an expired request that was never pinned. Permissionless.
    function forfeitExpiredRedeem(address requester) external nonReentrant {
        RedeemRequest memory req = redeemRequests[requester];
        if (!req.active) revert NoRequest();
        _pinPendingDraw();
        if (redeemRequests[requester].pinned) revert RequestPending();
        if (!_roundExpired(req.targetRound)) revert TooSoon();

        delete redeemRequests[requester];
        pendingRequester = address(0);
        pendingRedeemCount -= 1;
        // The burned share is re-minted to the TREASURY, never the requester —
        // and this is load-bearing, not a fee. A drand round is public on the
        // drand network the instant it is emitted, BEFORE anyone relays it into
        // this vault's beacon (relaying is a separate, permissionless act). So a
        // requester can compute their own draw off-chain,
        //     index = keccak256(seed, requester) % frozenLen,
        // WITHOUT pinning it on-chain. If forfeit refunded the share, a
        // requester who dislikes that draw could simply never relay the round,
        // wait out ROUND_EXPIRY, forfeit for a full refund, and retry — a
        // near-free reroll that cherry-picks rares, defeating the commit-reveal
        // entirely. Burning the share on forfeit makes declining a draw cost a
        // full share, which is what makes "frozen means frozen" actually hold.
        // (We tried refunding the requester and an independent review caught
        // exactly this; see git history.) Keeps solvency exact: the NFT stays in
        // the vault, its claim moves to the treasury.
        _mint(treasury, SHARE_UNIT);

        emit RedeemForfeited(requester);
        _assertSolvent();
    }

    /// @notice Redeem a specific token ID for a share plus the target premium.
    function redeemTarget(uint256 tokenId) external payable nonReentrant {
        if (msg.value != redeemFeeWei + targetPremiumWei) revert IncorrectFee();
        if (heldTokenIndex[tokenId] == 0) revert TokenNotHeld();

        address r = pendingRequester;
        if (r != address(0)) {
            _pinPendingDraw();
            RedeemRequest memory pend = redeemRequests[r];
            if (!pend.pinned) revert ReservedForPendingRedeem();
            if (pend.drawnTokenId == tokenId) revert ReservedForPendingRedeem();
        }
        if (heldTokenIds.length <= pendingRedeemCount) revert ReservedForPendingRedeem();

        _burn(msg.sender, SHARE_UNIT);
        accruedFees += msg.value;

        _removeHeldToken(tokenId);
        collection.safeTransferFrom(address(this), msg.sender, tokenId);

        emit Redeemed(msg.sender, tokenId, true);
        _assertSolvent();
    }

    /**
     * @notice Redeem several specific token IDs in one transaction.
     * Pay (redeemFeeWei + targetPremiumWei) * n.
     * @dev The reservation check is AGGREGATE, not per-item: a per-item check
     * would let a loop drop held below what a pending draw is owed.
     */
    function redeemTargetMany(uint256[] calldata tokenIds) external payable nonReentrant {
        uint256 n = tokenIds.length;
        if (n == 0 || n > MAX_BATCH) revert BadBatch();
        if (msg.value != (redeemFeeWei + targetPremiumWei) * n) revert IncorrectFee();

        uint256 drawn = type(uint256).max;
        address r = pendingRequester;
        if (r != address(0)) {
            _pinPendingDraw();
            RedeemRequest memory pend = redeemRequests[r];
            if (!pend.pinned) revert ReservedForPendingRedeem();
            drawn = pend.drawnTokenId;
        }
        // Aggregate: after removing n, held must still cover pendingRedeemCount.
        if (heldTokenIds.length < uint256(pendingRedeemCount) + n) {
            revert ReservedForPendingRedeem();
        }

        _burn(msg.sender, SHARE_UNIT * n);
        accruedFees += msg.value;

        for (uint256 i = 0; i < n; i++) {
            uint256 tokenId = tokenIds[i];
            if (tokenId == drawn) revert ReservedForPendingRedeem();
            // Duplicates self-revert: the second occurrence is no longer held.
            _removeHeldToken(tokenId);
            collection.safeTransferFrom(address(this), msg.sender, tokenId);
            emit Redeemed(msg.sender, tokenId, true);
        }
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
        if (!poolOpen) revert PoolNotOpen();
        if (shareReserve == 0 || ethReserve == 0) revert EmptyVault();

        // Full input joins the reserve; output is priced on the discounted
        // input, so k strictly grows and LPs earn the fee.
        uint256 inNet = (msg.value * (BPS_DENOMINATOR - swapFeeBps)) / BPS_DENOMINATOR;
        sharesOut = (inNet * shareReserve) / (ethReserve + inNet);
        if (sharesOut == 0 || sharesOut < minSharesOut) revert InsufficientOutput();

        ethReserve += msg.value;
        shareReserve -= sharesOut;
        _transfer(address(this), msg.sender, sharesOut);
        emit Bought(msg.sender, msg.value, sharesOut);
    }

    /// @notice Sell shares for ETH. `minEthOut` is your slippage floor.
    function sellShares(uint256 sharesIn, uint256 minEthOut)
        external
        nonReentrant
        returns (uint256 ethOut)
    {
        if (!poolOpen) revert PoolNotOpen();
        if (shareReserve == 0 || ethReserve == 0) revert EmptyVault();
        if (sharesIn == 0) revert InsufficientOutput();

        uint256 inNet = (sharesIn * (BPS_DENOMINATOR - swapFeeBps)) / BPS_DENOMINATOR;
        ethOut = (inNet * ethReserve) / (shareReserve + inNet);
        if (ethOut == 0 || ethOut < minEthOut) revert InsufficientOutput();

        _transfer(msg.sender, address(this), sharesIn);
        shareReserve += sharesIn;
        ethReserve -= ethOut;

        (bool ok, ) = msg.sender.call{value: ethOut}("");
        if (!ok) revert TransferFailed();
        _assertEthBacked();
        emit Sold(msg.sender, sharesIn, ethOut);
    }

    /**
     * @notice Provide liquidity. ETH-driven: the shares are PULLED to match
     * msg.value at the current ratio, so there is no mis-ratioed side to
     * donate and no refund path (hence no external call in this function).
     * @param maxSharesIn slippage guard on how many shares may be pulled.
     * @param minLpOut slippage guard on LP units minted.
     */
    function addLiquidity(uint256 maxSharesIn, uint256 minLpOut)
        external
        payable
        nonReentrant
        returns (uint256 lpMinted, uint256 sharesUsed)
    {
        if (!poolOpen) revert PoolNotOpen();
        if (msg.value == 0) revert InsufficientOutput();

        uint256 e = ethReserve;
        uint256 s = shareReserve;
        uint256 l = totalLpSupply;

        // ceil the pulled side (favours the pool), floor the LP minted.
        sharesUsed = Math.ceilDiv(msg.value * s, e);
        lpMinted = (msg.value * l) / e;
        if (sharesUsed == 0 || sharesUsed > maxSharesIn) revert InsufficientOutput();
        if (lpMinted == 0 || lpMinted < minLpOut) revert InsufficientOutput();

        // Rounding always favours the pool, by construction and with no runtime
        // check needed: lpMinted = floor(msg.value*l/e) gives e*lpMinted <=
        // msg.value*l, and sharesUsed = ceil(msg.value*s/e) gives sharesUsed*l
        // >= s*lpMinted. Both hold for every input, so an explicit assert here
        // would be permanently unreachable dead code.

        _transfer(msg.sender, address(this), sharesUsed);
        ethReserve = e + msg.value;
        shareReserve = s + sharesUsed;
        lpBalance[msg.sender] += lpMinted;
        totalLpSupply = l + lpMinted;

        emit LiquidityAdded(msg.sender, sharesUsed, msg.value, lpMinted);
    }

    /**
     * @notice Remove liquidity: burn LP units for a pro-rata slice of CURRENT
     * reserves on both sides. Pro-rata means a contributor absorbs the price
     * move they caused, so add/remove can never extract value from the pool.
     */
    function removeLiquidity(uint256 lpIn, uint256 minEthOut, uint256 minSharesOut)
        external
        nonReentrant
        returns (uint256 ethOut, uint256 sharesOut)
    {
        if (lpIn == 0) revert InsufficientOutput();
        if (lpIn > lpBalance[msg.sender]) revert InsufficientLiquidity();

        uint256 e = ethReserve;
        uint256 s = shareReserve;
        uint256 l = totalLpSupply;

        // Both sides floored (favours the pool). Locked seed LP keeps l > lpIn,
        // so both reserves stay strictly positive — the pool cannot be bricked.
        ethOut = (lpIn * e) / l;
        sharesOut = (lpIn * s) / l;
        if (ethOut == 0 || sharesOut == 0) revert InsufficientOutput();
        if (ethOut < minEthOut || sharesOut < minSharesOut) revert InsufficientOutput();

        lpBalance[msg.sender] -= lpIn;
        totalLpSupply = l - lpIn;
        ethReserve = e - ethOut;
        shareReserve = s - sharesOut;

        _transfer(address(this), msg.sender, sharesOut);
        (bool ok, ) = msg.sender.call{value: ethOut}("");
        if (!ok) revert TransferFailed();
        _assertEthBacked();

        emit LiquidityRemoved(msg.sender, sharesOut, ethOut, lpIn);
    }

    // ── Bootstrap ──────────────────────────────────────────────────────────

    /// @notice Add ETH to the pool. Treasury only, bootstrap only. No LP claim.
    function seedLiquidity() external payable nonReentrant {
        if (msg.sender != treasury) revert NotTreasury();
        if (poolOpen) revert BootstrapComplete();
        ethReserve += msg.value;
    }

    /// @notice Move treasury shares into the pool, optionally with ETH.
    /// Treasury only, bootstrap only. No LP claim (the seed is donated at open).
    function seedShares(uint256 shares) external payable nonReentrant {
        if (msg.sender != treasury) revert NotTreasury();
        if (poolOpen) revert BootstrapComplete();
        if (shares == 0) revert NothingToSeed();
        _transfer(msg.sender, address(this), shares);
        shareReserve += shares;
        ethReserve += msg.value;
        emit SharesSeeded(shares, msg.value);
        _assertSolvent();
    }

    /**
     * @notice Open the pool for public trading. Treasury only. ONE-WAY.
     * @dev Mints L0 = sqrt(ethReserve * shareReserve) LP units to a permanently
     * locked balance (address(0)) so totalLpSupply is non-zero the instant
     * trading begins — see header note 5. Requires both sides non-empty AND
     * L0 above a floor, so a dust seed cannot yield L0 == 1.
     */
    function openPool() external nonReentrant {
        if (msg.sender != treasury) revert NotTreasury();
        if (poolOpen) revert PoolAlreadyOpen();
        uint256 e = ethReserve;
        uint256 s = shareReserve;
        if (e == 0 || s == 0) revert EmptyVault();

        uint256 l0 = Math.sqrt(e * s);
        if (l0 <= MIN_INITIAL_LIQUIDITY) revert InsufficientLiquidity();

        poolOpen = true;
        lpBalance[address(0)] = l0; // permanently locked, unredeemable
        totalLpSupply = l0;
        emit PoolOpened(e, s, l0);
    }

    /// @notice Push accrued ETH fees to the immutable treasury. Permissionless
    /// (the destination is fixed, so this is not a rug lever).
    function withdrawFees() external nonReentrant {
        uint256 amount = accruedFees;
        if (amount == 0) revert NoFees();
        accruedFees = 0;
        (bool ok, ) = treasury.call{value: amount}("");
        if (!ok) revert TransferFailed();
        _assertEthBacked();
        emit FeesWithdrawn(amount);
    }

    // ── Views ──────────────────────────────────────────────────────────────

    function heldTokenCount() external view returns (uint256) {
        return heldTokenIds.length;
    }

    function availableTokenCount() external view returns (uint256) {
        uint256 held = heldTokenIds.length;
        return held > pendingRedeemCount ? held - pendingRedeemCount : 0;
    }

    function isTokenHeld(uint256 tokenId) external view returns (bool) {
        return heldTokenIndex[tokenId] != 0;
    }

    function pendingDraw() external view returns (bool pinned, uint256 tokenId) {
        address r = pendingRequester;
        if (r == address(0)) return (false, 0);
        RedeemRequest memory req = redeemRequests[r];
        return (req.pinned, req.drawnTokenId);
    }

    function pendingRound() external view returns (uint64 round, bool available) {
        address r = pendingRequester;
        if (r == address(0)) return (0, false);
        round = redeemRequests[r].targetRound;
        available = beacon.isRoundAvailable(round);
    }

    /// @notice What the client needs instead of grepping bytecode for selectors.
    function capabilities()
        external
        pure
        returns (bool proportionalLp, bool ethFees, bool batch, uint256 version)
    {
        return (true, true, true, VAULT_VERSION);
    }

    /**
     * @notice Pool make-up so the UI can state what is genuinely removable and
     * the contract can self-report. `lockedLp` is the donated seed at open.
     */
    function poolComposition()
        external
        view
        returns (uint256 ethSide, uint256 shareSide, uint256 lpTotal, uint256 lockedLp)
    {
        return (ethReserve, shareReserve, totalLpSupply, lpBalance[address(0)]);
    }

    // ── Internals ──────────────────────────────────────────────────────────

    function _pinPendingDraw() private {
        address r = pendingRequester;
        if (r == address(0)) return;
        RedeemRequest storage req = redeemRequests[r];
        if (req.pinned) return;
        bytes32 seed = beacon.randomnessOrZero(req.targetRound);
        if (seed == bytes32(0)) return;

        uint256 index = uint256(keccak256(abi.encodePacked(seed, r))) % req.frozenLen;
        uint256 drawn = heldTokenIds[index];
        req.drawnTokenId = drawn;
        req.pinned = true;
        emit DrawPinned(r, drawn);
    }

    /// @dev Deliver a pinned draw to its requester. transferFrom, NOT
    /// safeTransferFrom — see the V2 header: an undeliverable requester must
    /// never brick the single vault-wide slot.
    function _settle(address requester) private returns (uint256 tokenId) {
        RedeemRequest memory req = redeemRequests[requester];
        if (!req.active) revert NoRequest();

        _pinPendingDraw();
        req = redeemRequests[requester];
        if (!req.pinned) {
            if (_roundExpired(req.targetRound)) revert RandomnessExpired();
            revert RandomnessNotAvailable();
        }

        delete redeemRequests[requester];
        pendingRequester = address(0);
        pendingRedeemCount -= 1;

        tokenId = req.drawnTokenId;
        _removeHeldToken(tokenId);
        collection.transferFrom(address(this), requester, tokenId);

        emit Redeemed(requester, tokenId, false);
        _assertSolvent();
    }

    function _roundExpired(uint64 targetRound) private view returns (bool) {
        uint64 nowRound = beacon.currentRoundAt(block.timestamp);
        return nowRound > targetRound && nowRound - targetRound > ROUND_EXPIRY;
    }

    /// @dev Every share that exists (plus every burned-but-unclaimed redeem) is
    /// backed one-to-one by a held NFT.
    function _assertSolvent() private view {
        if (totalSupply() + pendingRedeemCount * SHARE_UNIT != heldTokenIds.length * SHARE_UNIT) {
            revert SolvencyBroken();
        }
    }

    /// @dev Accounted pool ETH plus unpaid fees never exceeds the real balance.
    function _assertEthBacked() private view {
        if (address(this).balance < ethReserve + accruedFees) {
            revert EthBackingBroken();
        }
    }

    function _addHeldToken(uint256 tokenId) private {
        if (heldTokenIndex[tokenId] != 0) revert AlreadyHeld();
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
