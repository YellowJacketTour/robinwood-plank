// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ReentrancyGuard} from "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

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
 * SCOPE
 * -----
 * buyNow: ETH-denominated single-order buy-now (V1).
 * sweepBuy: multiple ETH-denominated orders in one transaction (V2) -- NOT
 *   Seaport's fulfillAvailableAdvancedOrders (that function's offer/
 *   consideration "fulfillment component" aggregation arrays are a real,
 *   documented source of aggregator bugs when built for heterogeneous
 *   orders from different offerers). Instead, sweepBuy loops N independent
 *   fulfillAdvancedOrder calls -- the exact same audited entry point
 *   buyNow already uses -- wrapped in try/catch so ONE order that's
 *   already been bought by someone else (a real, common race in a sweep)
 *   degrades to "skip it and refund its share," not "revert the whole
 *   batch." Every successful fill still goes through Seaport's own full
 *   verification; nothing about the per-order safety guarantees changes
 *   from calling buyNow N times.
 * buyNowWithToken: ERC20/WETH-denominated single-order buy-now (V2) -- the
 *   fulfiller's OWN token payment always uses fulfillerConduitKey =
 *   bytes32(0), so Seaport pulls directly from this contract's balance via
 *   a plain approval to Seaport itself; this is independent of the
 *   order's own (the offerer's) conduitKey field, which governs how the
 *   OFFERER's item moves, not the fulfiller's payment -- confirmed by
 *   Seaport's own ABI separating these two conduit choices. The approval
 *   is set to exactly the order price before the call and reset to zero
 *   after, defense-in-depth against a lingering allowance even though
 *   Seaport is expected to pull the exact amount in the same transaction.
 *
 * @dev Immutable configuration -- no admin key can change the fee recipient
 *      or fee rate after deployment, matching lib/constants.ts's existing
 *      SEAPORT_ADDRESS/CONDUIT_CONTROLLER_ADDRESS posture of removing
 *      post-deployment misconfiguration risk entirely rather than gating it
 *      behind access control.
 */
contract MarketplankForeignFeeRouter is ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice The real, canonical Seaport 1.6 contract on this chain (same address on every EVM chain this router is deployed to -- see lib/market/multichain/trading/foreign-chain-registry.ts).
    address public immutable seaport;

    /// @notice Where the fee goes. Set once at deploy time, never changes.
    address public immutable feeRecipient;

    /// @notice Fee in basis points (1.8% = 180), applied to the order's ETH price. Set once at deploy time, never changes.
    uint256 public immutable feeBps;

    uint256 private constant BPS_DENOMINATOR = 10_000;
    /// @dev Sanity ceiling, not a governance knob -- prevents an obviously-wrong constructor argument (e.g. a misplaced decimal turning 180 into 18000) from ever being deployable.
    uint256 private constant MAX_FEE_BPS = 1_000; // 10%

    /// @dev sweepBuy caps the batch size, not as a fee/pricing decision but a
    /// gas-griefing guard: an unbounded array of orders could be crafted to
    /// exceed the block gas limit and make the whole sweep unmineable.
    uint256 private constant MAX_SWEEP_ITEMS = 50;

    error FeeTooHigh(uint256 requested, uint256 max);
    error ZeroAddress();
    error InsufficientPayment(uint256 required, uint256 sent);
    error SeaportCallFailed();
    error ArrayLengthMismatch();
    error EmptySweep();
    error SweepTooLarge(uint256 requested, uint256 max);
    error NoOrdersFilled();

    event ForeignOrderFulfilled(address indexed buyer, uint256 orderPriceWei, uint256 feeWei);
    event ForeignSweepItemFulfilled(address indexed buyer, uint256 orderIndex, uint256 orderPriceWei, uint256 feeWei);
    event ForeignSweepItemSkipped(address indexed buyer, uint256 orderIndex);

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

    /**
     * @notice Fulfil several ETH-denominated foreign-marketplace orders in
     *         one transaction (a "sweep"), collecting Marketplank's fee on
     *         each one that actually fills.
     * @dev Best-effort per item: if an individual order fails (already
     *      sold, expired, cancelled -- a real and common race the instant
     *      a sweep touches more than one seller), that item is SKIPPED,
     *      not reverted-whole-batch. msg.value must cover the worst case
     *      (every order succeeding); anything not spent on orders that
     *      actually filled is refunded, including the fee portion for any
     *      skipped item. Reverts only if EVERY order in the batch fails --
     *      a sweep that buys nothing is not a success.
     */
    function sweepBuy(
        AdvancedOrder[] calldata orders,
        CriteriaResolver[][] calldata criteriaResolvers,
        bytes32 fulfillerConduitKey,
        uint256[] calldata orderPricesWei
    ) external payable nonReentrant returns (bool[] memory filled) {
        uint256 count = orders.length;
        if (count == 0) revert EmptySweep();
        if (count > MAX_SWEEP_ITEMS) revert SweepTooLarge(count, MAX_SWEEP_ITEMS);
        if (criteriaResolvers.length != count || orderPricesWei.length != count) revert ArrayLengthMismatch();

        filled = new bool[](count);
        uint256 totalSpent;
        uint256 fillCount;

        for (uint256 i = 0; i < count; i++) {
            uint256 price = orderPricesWei[i];
            uint256 fee = (price * feeBps) / BPS_DENOMINATOR;
            uint256 needed = price + fee;

            // Never attempt an order this transaction can't possibly afford
            // even in isolation -- cheaper than letting Seaport's own call
            // revert-and-catch for the same reason, and keeps the "did we
            // even try" signal (this counts as skipped, not a Seaport
            // rejection) accurate for the emitted event.
            if (totalSpent + needed > msg.value) {
                emit ForeignSweepItemSkipped(msg.sender, i);
                continue;
            }

            try ISeaport(seaport).fulfillAdvancedOrder{value: price}(
                orders[i],
                criteriaResolvers[i],
                fulfillerConduitKey,
                msg.sender
            ) returns (bool ok) {
                if (!ok) {
                    emit ForeignSweepItemSkipped(msg.sender, i);
                    continue;
                }
                (bool feeSent, ) = feeRecipient.call{value: fee}("");
                if (!feeSent) revert SeaportCallFailed();
                totalSpent += needed;
                fillCount++;
                filled[i] = true;
                emit ForeignSweepItemFulfilled(msg.sender, i, price, fee);
            } catch {
                emit ForeignSweepItemSkipped(msg.sender, i);
            }
        }

        if (fillCount == 0) revert NoOrdersFilled();

        uint256 refund = msg.value - totalSpent;
        if (refund > 0) {
            (bool refunded, ) = msg.sender.call{value: refund}("");
            if (!refunded) revert SeaportCallFailed();
        }
    }

    /**
     * @notice Fulfil one ERC20/WETH-denominated foreign-marketplace order,
     *         collecting Marketplank's fee on top.
     * @dev The buyer must have approved THIS CONTRACT (not Seaport) for at
     *      least `orderPriceTokenAmount + fee` in `token` before calling --
     *      the standard ERC20 two-step pattern, identical in shape to the
     *      wallet-side approval step lib/market/seaport.ts's own offer
     *      flow already asks users for on Robinhood Chain.
     * @param token The ERC20 (e.g. WETH) the order's consideration is priced in.
     * @param orderPriceTokenAmount The order's total token consideration (buyer-facing quoted price, before Marketplank's fee).
     */
    function buyNowWithToken(
        AdvancedOrder calldata order,
        CriteriaResolver[] calldata criteriaResolvers,
        uint256 orderPriceTokenAmount,
        address token
    ) external nonReentrant {
        uint256 fee = (orderPriceTokenAmount * feeBps) / BPS_DENOMINATOR;
        uint256 total = orderPriceTokenAmount + fee;

        IERC20(token).safeTransferFrom(msg.sender, address(this), total);

        // Always fulfillerConduitKey = 0 for OUR OWN payment: Seaport then
        // pulls directly from this contract's balance via a plain
        // approval, independent of the order's own conduitKey (that field
        // governs how the OFFERER's item moves, a separate concern -- see
        // header comment). Approve exactly the order price, not `total`
        // (the fee never needs to leave this contract via Seaport).
        IERC20(token).forceApprove(seaport, orderPriceTokenAmount);
        bool fulfilled = ISeaport(seaport).fulfillAdvancedOrder(
            order,
            criteriaResolvers,
            bytes32(0),
            msg.sender
        );
        // Defense-in-depth: reset the approval even on the success path,
        // in case Seaport pulled less than the full approved amount for
        // any reason (e.g. a partial-fill numerator/denominator on the
        // order) -- never leave a standing allowance on this contract.
        IERC20(token).forceApprove(seaport, 0);
        if (!fulfilled) revert SeaportCallFailed();

        IERC20(token).safeTransfer(feeRecipient, fee);

        emit ForeignOrderFulfilled(msg.sender, orderPriceTokenAmount, fee);
    }
}
