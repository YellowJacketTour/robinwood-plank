// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ReentrancyGuard} from "@openzeppelin/contracts/security/ReentrancyGuard.sol";

/// @dev Seaport structs, declared at file scope (Solidity does not allow
/// nested `interface` declarations inside a contract body) -- field order
/// and types mirror Seaport 1.6's own ABI exactly, so what gets passed
/// through is byte-for-byte what OpenSea's orderbook returned, no
/// reinterpretation.
struct OfferItem {
    uint8 itemType;
    address token;
    uint256 identifierOrCriteria;
    uint256 startAmount;
    uint256 endAmount;
}

struct ConsiderationItem {
    uint8 itemType;
    address token;
    uint256 identifierOrCriteria;
    uint256 startAmount;
    uint256 endAmount;
    address recipient;
}

struct OrderParameters {
    address offerer;
    address zone;
    OfferItem[] offer;
    ConsiderationItem[] consideration;
    uint8 orderType;
    uint256 startTime;
    uint256 endTime;
    bytes32 zoneHash;
    uint256 salt;
    bytes32 conduitKey;
    uint256 totalOriginalConsiderationItems;
}

struct AdvancedOrder {
    OrderParameters parameters;
    uint120 numerator;
    uint120 denominator;
    bytes signature;
    bytes extraData;
}

struct CriteriaResolver {
    uint256 orderIndex;
    uint8 side;
    uint256 index;
    uint256 identifier;
    bytes32[] criteriaProof;
}

interface ISeaport {
    function fulfillAdvancedOrder(
        AdvancedOrder calldata advancedOrder,
        CriteriaResolver[] calldata criteriaResolvers,
        bytes32 fulfillerConduitKey,
        address recipient
    ) external payable returns (bool fulfilled);
}

/**
 * @title MarketplankForeignFeeRouter
 * @notice Fulfils a single, real Seaport order sourced from a foreign
 *         marketplace's orderbook (e.g. OpenSea on a chain Marketplank does
 *         not run its own orderbook for), while collecting Marketplank's own
 *         fee on top -- without ever custodying the buyer's NFT.
 *
 * WHY THIS CONTRACT EXISTS
 * ------------------------
 * Seaport's fulfil functions execute EXACTLY the consideration the order's
 * signer signed -- confirmed live and via research 2026-08-17: there is no
 * protocol-level way for a third-party fulfiller to add its own fee to
 * someone else's already-signed order. This is not a gap in understanding;
 * even Blur, the largest Seaport-compatible aggregator, charges ZERO fee on
 * orders sourced from other marketplaces for exactly this reason. The only
 * real mechanism (used historically by Gem.xyz/Genie, the aggregators that
 * DID charge a fee on aggregated liquidity) is a thin router: the buyer pays
 * (order price + fee) to this contract, which forwards EXACTLY the order
 * price to the real Seaport contract to fulfil the order, and keeps the fee.
 *
 * WHAT THIS DELIBERATELY REUSES RATHER THAN REINVENTS
 * ------------------------------------------------------
 * - Seaport itself is called via an EXTERNAL call to the real, canonical,
 *   Trail-of-Bits-audited Seaport 1.6 contract -- this contract never
 *   reimplements order verification, signature checking, or item transfer
 *   logic. It only escrows payment and calls through.
 * - The fee-collection arithmetic (bips of a balance, safe ETH transfer)
 *   follows the same shape as Uniswap's Universal Router's Payments.sol
 *   payPortion() -- a live, audited, production fee-sweep primitive
 *   (github.com/Uniswap/universal-router/blob/main/contracts/modules/Payments.sol,
 *   reviewed 2026-08-17) -- adapted here for a single up-front fee rather
 *   than a portion of an arbitrary token balance, since this contract only
 *   ever holds ETH transiently within one transaction.
 * - Seaport's own `recipient` parameter on fulfillAdvancedOrder is set to
 *   the BUYER, not this contract -- the purchased NFT goes directly from
 *   the seller to the buyer inside Seaport's own transfer logic. This
 *   contract never becomes the NFT's owner, even transiently, closing off
 *   an entire class of risk (a paused/reverting NFT contract, a malicious
 *   NFT's onERC721Received hook, etc. can affect the buyer's own receipt
 *   but can never leave an asset stuck IN this router).
 *
 * SCOPE (V1) -- DELIBERATELY NARROW, NOT A SHORTCUT
 * -----------------------------------------------------
 * ETH-denominated single-order buy-now only. Sweep (multiple orders via
 * Seaport's fulfillAvailableAdvancedOrders) and ERC20/WETH-denominated
 * orders are NOT implemented here -- both need materially different
 * accounting (partial-fill handling for sweep; an ERC20 pull-then-approve
 * step for token-denominated orders) that deserves its own dedicated
 * design and test pass rather than being bolted on under time pressure.
 * Extending this contract, not routing around it, is the intended path.
 *
 * @dev Immutable configuration -- no admin key can change the fee recipient
 *      or fee rate after deployment, matching lib/constants.ts's existing
 *      SEAPORT_ADDRESS/CONDUIT_CONTROLLER_ADDRESS posture of removing
 *      post-deployment misconfiguration risk entirely rather than gating it
 *      behind access control.
 */
contract MarketplankForeignFeeRouter is ReentrancyGuard {
    /// @notice The real, canonical Seaport 1.6 contract on this chain (same address on every EVM chain this router is deployed to -- see lib/market/multichain/trading/foreign-chain-registry.ts).
    address public immutable seaport;

    /// @notice Where the fee goes. Set once at deploy time, never changes.
    address public immutable feeRecipient;

    /// @notice Fee in basis points (1.8% = 180), applied to the order's ETH price. Set once at deploy time, never changes.
    uint256 public immutable feeBps;

    uint256 private constant BPS_DENOMINATOR = 10_000;
    /// @dev Sanity ceiling, not a governance knob -- prevents an obviously-wrong constructor argument (e.g. a misplaced decimal turning 180 into 18000) from ever being deployable.
    uint256 private constant MAX_FEE_BPS = 1_000; // 10%

    error FeeTooHigh(uint256 requested, uint256 max);
    error ZeroAddress();
    error InsufficientPayment(uint256 required, uint256 sent);
    error SeaportCallFailed();

    event ForeignOrderFulfilled(address indexed buyer, uint256 orderPriceWei, uint256 feeWei);

    constructor(address seaport_, address feeRecipient_, uint256 feeBps_) {
        if (seaport_ == address(0) || feeRecipient_ == address(0)) revert ZeroAddress();
        if (feeBps_ > MAX_FEE_BPS) revert FeeTooHigh(feeBps_, MAX_FEE_BPS);
        seaport = seaport_;
        feeRecipient = feeRecipient_;
        feeBps = feeBps_;
    }

    /**
     * @notice Fulfil one ETH-denominated foreign-marketplace Seaport order,
     *         collecting Marketplank's fee on top.
     * @dev `orderPriceWei` is the EXACT total ETH the order's consideration
     *      requires (sum of every consideration item's startAmount for a
     *      fixed-price listing) -- computed off-chain from the same order
     *      data being passed in, and re-derived here from msg.value/fee math
     *      rather than trusted blindly: this function requires
     *      msg.value >= orderPriceWei + fee, forwards EXACTLY orderPriceWei
     *      to Seaport, and if Seaport's own consideration-total check
     *      doesn't match, Seaport itself reverts the whole transaction --
     *      this contract cannot under-pay the seller.
     * @param order The real order returned by the foreign marketplace's API, unmodified.
     * @param orderPriceWei The order's total ETH consideration (buyer-facing quoted price, before Marketplank's fee).
     */
    function buyNow(
        AdvancedOrder calldata order,
        CriteriaResolver[] calldata criteriaResolvers,
        bytes32 fulfillerConduitKey,
        uint256 orderPriceWei
    ) external payable nonReentrant {
        uint256 fee = (orderPriceWei * feeBps) / BPS_DENOMINATOR;
        uint256 required = orderPriceWei + fee;
        if (msg.value < required) revert InsufficientPayment(required, msg.value);

        // Recipient = the buyer, not this contract -- the NFT never touches
        // this router (see header comment). Seaport itself enforces that
        // `order`'s consideration is satisfied by the ETH forwarded here; if
        // it is not, Seaport reverts and this whole transaction reverts with
        // it (nonReentrant + no state changes before this call means a
        // revert here leaves nothing to unwind).
        bool fulfilled = ISeaport(seaport).fulfillAdvancedOrder{value: orderPriceWei}(
            order,
            criteriaResolvers,
            fulfillerConduitKey,
            msg.sender
        );
        if (!fulfilled) revert SeaportCallFailed();

        (bool feeSent, ) = feeRecipient.call{value: fee}("");
        if (!feeSent) revert SeaportCallFailed();

        // Refund any overpayment LAST -- checks-effects-interactions: every
        // external call above either reverts the whole transaction or is
        // the exact accounted-for amount, so this is the only place a
        // caller-controlled excess is returned, and reentrancy is already
        // blocked for the whole function by nonReentrant.
        uint256 refund = msg.value - required;
        if (refund > 0) {
            (bool refunded, ) = msg.sender.call{value: refund}("");
            if (!refunded) revert SeaportCallFailed();
        }

        emit ForeignOrderFulfilled(msg.sender, orderPriceWei, fee);
    }
}
