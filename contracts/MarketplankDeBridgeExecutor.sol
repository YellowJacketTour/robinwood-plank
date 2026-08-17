// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ReentrancyGuard} from "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import {AdvancedOrder, OrderParameters, CriteriaResolver} from "./MarketplankForeignFeeRouter.sol";

/**
 * @title MarketplankDeBridgeExecutor
 * @notice deBridge counterpart to MarketplankAcrossReceiver -- pay on any
 *         deBridge-supported chain, receive an NFT purchased on a
 *         different chain via MarketplankForeignFeeRouter. Exists because
 *         Across has NO live route for BNB Chain (confirmed live
 *         2026-08-17: every WETH/WBNB-denominated route to or from BSC
 *         returns Across's own {"code":"ROUTE_NOT_ENABLED"}, even though
 *         Across's SpokePool contract is genuinely deployed there -- the
 *         contract exists, the live relayer/liquidity network does not
 *         currently service it). deBridge's DLN genuinely routes this
 *         exact pairing (live-verified: a real WBNB(BSC)->WETH(Base) quote
 *         via https://dln.debridge.finance/v1.0/dln/order/create-tx
 *         returned a real fee breakdown and output amount).
 *
 * REAL, VERIFIED FOUNDATIONS -- NOT ASSUMED FROM DOCS
 * -------------------------------------------------------
 * deBridge DLN: open source (github.com/debridge-finance/dln-contracts),
 * 30+ audits (Halborn, Zokyo, Ackee Blockchain per public reporting),
 * zero-TVL design (orders are filled by competing takers against the
 * maker's own funds, not a shared liquidity pool -- a different, arguably
 * safer risk profile than Across's pooled-liquidity model).
 *
 * Confirmed live 2026-08-17 by reading the actual deployed contracts and
 * their real Solidity source (contracts/DLN/DlnDestination.sol,
 * contracts/adapters/DlnExternalCallAdapter.sol,
 * contracts/interfaces/IExternalCallExecutor.sol -- not doc summaries):
 * - DlnDestination.fulfillOrder(), when an order carries a non-empty
 *   externalCall, transfers the take token to the CONFIGURED
 *   externalCallAdapter FIRST, then calls
 *   IExternalCallAdapter(adapter).receiveCall(...).
 * - The adapter's _execute() then transfers the token AGAIN, this time to
 *   whatever executorAddress the order's own
 *   DlnExternalCallLib.ExternalCallEnvelopV1 specifies (this contract),
 *   THEN calls executor.onERC20Received(orderId, token, amount,
 *   fallbackAddress, payload) -- confirmed via the adapter's real source,
 *   token arrives before the callback, same ordering property as Across.
 * - NO try/catch exists ANYWHERE in this call chain (DlnDestination ->
 *   adapter.receiveCall -> adapter._execute -> our onERC20Received) --
 *   confirmed by grepping the actual fetched source files for try/catch
 *   and finding none. A revert in this contract's onERC20Received
 *   therefore atomically undoes the ENTIRE fill, including both token
 *   transfers, exactly like MarketplankAcrossReceiver's equivalent
 *   property with Across's SpokePool. This is why this contract also
 *   simply reverts on any failure rather than implementing refund logic.
 * - The real, live, deterministic (same address on every EVM chain
 *   deBridge supports) DlnExternalCallAdapter address,
 *   0x61eF2E01e603AEb5Cd96F9EC9AE76cC6a68F6cf9, was read DIRECTLY from
 *   DlnDestination's own public externalCallAdapter() state variable via
 *   a live eth_call on both Base and BSC (both returned the identical
 *   value), not taken from any docs page or block-explorer label search
 *   (which returned a DIFFERENT, wrong address guess first) -- this is
 *   the primary access-control anchor below, same role SPOKE_POOL plays
 *   in MarketplankAcrossReceiver.
 */
interface IMarketplankForeignFeeRouter {
    function buyNowFor(
        AdvancedOrder calldata order,
        CriteriaResolver[] calldata criteriaResolvers,
        bytes32 fulfillerConduitKey,
        uint256 orderPriceWei,
        address recipient
    ) external payable;
}

contract MarketplankDeBridgeExecutor is ReentrancyGuard {
    /// @notice The real deBridge DlnExternalCallAdapter -- the ONLY address permitted to call onERC20Received. Read live from DlnDestination.externalCallAdapter() on the target chain before deployment, never guessed (see header).
    address public immutable externalCallAdapter;

    /// @notice The MarketplankForeignFeeRouter this executor forwards purchases to, on this same chain.
    address public immutable router;

    /// @notice wrappedNativeToken for this chain -- same role as MarketplankAcrossReceiver's equivalent field.
    address public immutable wrappedNativeToken;

    error NotExternalCallAdapter(address caller);
    error ZeroAddress();
    error WrongToken(address expected, address got);
    error InsufficientDeliveredAmount(uint256 required, uint256 delivered);
    error UnwrapFailed();
    error RouterCallFailed();

    event CrossChainPurchaseCompleted(address indexed recipient, uint256 amountDelivered);

    constructor(address externalCallAdapter_, address router_, address wrappedNativeToken_) {
        if (externalCallAdapter_ == address(0) || router_ == address(0) || wrappedNativeToken_ == address(0)) {
            revert ZeroAddress();
        }
        externalCallAdapter = externalCallAdapter_;
        router = router_;
        wrappedNativeToken = wrappedNativeToken_;
    }

    function _unwrapNative(uint256 amount) private {
        (bool ok, ) = wrappedNativeToken.call(abi.encodeWithSignature("withdraw(uint256)", amount));
        if (!ok) revert UnwrapFailed();
    }

    /**
     * @notice Called by the real deBridge external-call adapter after it
     *         has ALREADY delivered `_transferredAmount` of `_token` to
     *         this contract (see header on transfer-then-call ordering).
     * @param _token The token delivered -- expected to be wrappedNativeToken; anything else fails closed rather than proceeding with the wrong asset.
     * @param _transferredAmount The amount of `_token` delivered.
     * @param _payload ABI-encoded (OrderParameters parameters, bytes signature, CriteriaResolver[] criteriaResolvers, bytes32 fulfillerConduitKey, uint256 orderPriceWei, address recipient) -- identical shape to MarketplankAcrossReceiver's message, for one consistent encoding across both cross-chain paths.
     */
    function onERC20Received(
        bytes32 /* orderId */,
        address _token,
        uint256 _transferredAmount,
        address /* fallbackAddress */,
        bytes memory _payload
    ) external nonReentrant returns (bool, bytes memory) {
        // THE PRIMARY DEFENSE. Checked first, unconditionally -- see header.
        if (msg.sender != externalCallAdapter) revert NotExternalCallAdapter(msg.sender);
        if (_token != wrappedNativeToken) revert WrongToken(wrappedNativeToken, _token);

        (
            OrderParameters memory parameters,
            bytes memory signature,
            CriteriaResolver[] memory criteriaResolvers,
            bytes32 fulfillerConduitKey,
            uint256 orderPriceWei,
            address recipient
        ) = abi.decode(_payload, (OrderParameters, bytes, CriteriaResolver[], bytes32, uint256, address));

        if (recipient == address(0)) revert ZeroAddress();

        _unwrapNative(_transferredAmount);

        uint256 delivered = address(this).balance;
        if (delivered < orderPriceWei) revert InsufficientDeliveredAmount(orderPriceWei, delivered);

        AdvancedOrder memory order = AdvancedOrder({
            parameters: parameters,
            numerator: 1,
            denominator: 1,
            signature: signature,
            extraData: ""
        });

        try
            IMarketplankForeignFeeRouter(router).buyNowFor{value: delivered}(
                order,
                criteriaResolvers,
                fulfillerConduitKey,
                orderPriceWei,
                recipient
            )
        {
            emit CrossChainPurchaseCompleted(recipient, delivered);
            return (true, "");
        } catch {
            // Re-revert rather than return (false, ...): per header, a
            // revert here is SAFE (atomically undoes both token transfers
            // too), and returning false instead would only be safe if
            // EVERY order this contract's counterparty constructs sets
            // requireSuccessfullExecution=true -- reverting is correct
            // regardless of that flag, not conditional on trusting it.
            revert RouterCallFailed();
        }
    }

    /// @notice Accepts the unwrapped ETH from wrappedNativeToken's withdraw() call inside _unwrapNative.
    receive() external payable {}
}
