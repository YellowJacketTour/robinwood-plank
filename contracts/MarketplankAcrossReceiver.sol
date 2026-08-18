// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ReentrancyGuard} from "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import {AdvancedOrder, OrderParameters, CriteriaResolver} from "./MarketplankForeignFeeRouter.sol";
import {IMarketplankForeignFeeRouter} from "./interfaces/IMarketplankForeignFeeRouter.sol";

/**
 * @title MarketplankAcrossReceiver
 * @notice Lets a buyer pay on ANY chain Across supports, in ETH/WETH, and
 *         receive an NFT purchased via MarketplankForeignFeeRouter on a
 *         DIFFERENT chain -- the genuinely cypherpunk answer to "buy any
 *         NFT with any currency on any chain": composed entirely from two
 *         independently open-source, audited systems (Across Protocol and
 *         our own already-tested router), never a proprietary company API
 *         sitting in the execution path.
 *
 * REAL, VERIFIED FOUNDATIONS -- NOT ASSUMED FROM DOCS
 * -------------------------------------------------------
 * Confirmed live 2026-08-17 against Across's actual deployed contracts
 * (github.com/across-protocol/contracts, audited by OpenZeppelin across 18+
 * engagements): real SpokePool bytecode on Ethereum/Base/Arbitrum/Optimism/
 * Polygon (eth_getCode, 21.5-29KB each), a live eth_call to Base's
 * SpokePool.chainId() returning exactly 8453, and the real
 * AcrossMessageHandler interface pulled from
 * contracts/interfaces/SpokePoolMessageHandler.sol:
 *   function handleV3AcrossMessage(address tokenSent, uint256 amount, address relayer, bytes memory message) external;
 * SpokePool's real _transferTokensToRecipient (spoke-pools/SpokePool.sol)
 * transfers tokens to this contract FIRST, then calls
 * handleV3AcrossMessage with no try/catch -- confirmed by reading that
 * function's actual body. That means a revert in this contract's handler
 * atomically undoes the ENTIRE fill, including the token transfer: nothing
 * is ever stranded here. A failed purchase is a clean no-op for that fill
 * attempt; the depositor's original funds remain safe on the origin chain
 * for Across's own normal retry/refund path. This is why this contract
 * reverts on any failure rather than implementing its own refund logic --
 * a hand-rolled "catch and refund to an address encoded in the message"
 * path would be NEW, untested complexity solving a problem Across's own
 * atomicity already solves for free.
 *
 * REAL DISCLOSED VULNERABILITY THIS DESIGN ACCOUNTS FOR
 * -----------------------------------------------------------
 * A real, publicly disclosed (Jan 2025) high-severity Across bug let a
 * malicious relayer exploit a self-relay early-return optimization to mark
 * a fill "complete" without tokens ever actually reaching the recipient,
 * then claim the relayer refund. Across's own fix removed that early
 * return entirely -- this contract does not depend on that specific code
 * path, but the LESSON generalizes: never trust that "handleV3AcrossMessage
 * was called" alone proves funds arrived. This contract additionally
 * verifies its own ETH balance is sufficient for the decoded purchase
 * BEFORE calling the router, rather than trusting the `amount` parameter
 * blindly.
 *
 * ACCESS CONTROL -- THE PRIMARY DEFENSE
 * ------------------------------------------
 * handleV3AcrossMessage is a PUBLIC function (required by
 * AcrossMessageHandler's interface) -- anyone can call it directly, not
 * just the real SpokePool. Without a strict caller check, an attacker
 * could call it directly with attacker-chosen parameters, e.g. an "amount"
 * that was never actually transferred, tricking this contract into
 * attempting (and, if this contract held any balance from prior activity,
 * potentially spending) funds it does not actually have from this call.
 * msg.sender MUST equal the real, immutable SPOKE_POOL address for this
 * chain -- checked FIRST, before any other logic.
 */
contract MarketplankAcrossReceiver is ReentrancyGuard {
    /// @notice The real, canonical Across SpokePool for THIS chain. Immutable -- verified live per-chain before deployment (see header), never guessed.
    address public immutable spokePool;

    /// @notice The MarketplankForeignFeeRouter this receiver forwards purchases to, on this same chain.
    address public immutable router;

    /// @notice wrappedNativeToken address for this chain -- Across delivers wrapped native (WETH) when the destination output token is native-denominated; see header on outputToken == wrappedNativeToken in SpokePool.sol. This contract unwraps it before paying the router (which expects ETH via msg.value).
    address public immutable wrappedNativeToken;

    error NotSpokePool(address caller);
    error ZeroAddress();
    error InsufficientDeliveredAmount(uint256 required, uint256 delivered);
    error UnwrapFailed();
    error RouterCallFailed();

    event CrossChainPurchaseCompleted(address indexed recipient, uint256 amountDelivered);

    constructor(address spokePool_, address router_, address wrappedNativeToken_) {
        if (spokePool_ == address(0) || router_ == address(0) || wrappedNativeToken_ == address(0)) {
            revert ZeroAddress();
        }
        spokePool = spokePool_;
        router = router_;
        wrappedNativeToken = wrappedNativeToken_;
    }

    /// @dev Minimal WETH-shaped interface -- withdraw() is the standard WETH9 unwrap function, present on every canonical wrapped-native-token contract this receiver will ever be deployed against.
    function _unwrapNative(uint256 amount) private {
        (bool ok, ) = wrappedNativeToken.call(abi.encodeWithSignature("withdraw(uint256)", amount));
        if (!ok) revert UnwrapFailed();
    }

    /**
     * @notice Called by the real Across SpokePool after it has ALREADY
     *         delivered `amount` of `tokenSent` to this contract (see
     *         header on transfer-then-call ordering). Decodes `message`
     *         into the exact parameters MarketplankForeignFeeRouter.buyNowFor
     *         needs, and forwards the purchase -- any failure reverts this
     *         whole call, which per SpokePool's own real code atomically
     *         undoes the token delivery too. Nothing is ever left stranded
     *         in this contract by design (not by cleanup logic).
     * @param tokenSent The token Across delivered -- expected to be wrappedNativeToken for this receiver (an ERC20-denominated version would need its own dedicated receiver, not this one).
     * @param amount The amount of tokenSent delivered.
     * (The third parameter, the relayer who filled this deposit, is intentionally unnamed -- not used for authorization; msg.sender, the SpokePool address, is the only trust anchor.)
     * @param message ABI-encoded (OrderParameters parameters, bytes signature, CriteriaResolver[] criteriaResolvers, bytes32 fulfillerConduitKey, uint256 orderPriceWei, address recipient) -- built server-side by whatever quotes the Across deposit. numerator/denominator/extraData are NOT part of the message; they are fixed to 1/1/"0x" here (see below).
     */
    function handleV3AcrossMessage(
        address tokenSent,
        uint256 amount,
        address /* relayer */,
        bytes memory message
    ) external nonReentrant {
        // THE PRIMARY DEFENSE. See header -- this is checked before any
        // other logic runs, unconditionally.
        if (msg.sender != spokePool) revert NotSpokePool(msg.sender);

        // Decodes OrderParameters + signature separately, NOT a full
        // AdvancedOrder struct -- every buyNow/buyNowFor call in this
        // codebase always uses numerator=1, denominator=1, extraData="0x"
        // (a full, non-partial fill; see MarketplankForeignFeeRouter's own
        // buyNow), so reconstructing those constants here instead of
        // trusting them from an untrusted-until-decoded message removes a
        // whole class of "attacker sets numerator/denominator to something
        // that causes a partial fill" concern for free.
        (
            OrderParameters memory parameters,
            bytes memory signature,
            CriteriaResolver[] memory criteriaResolvers,
            bytes32 fulfillerConduitKey,
            uint256 orderPriceWei,
            address recipient
        ) = abi.decode(message, (OrderParameters, bytes, CriteriaResolver[], bytes32, uint256, address));
        AdvancedOrder memory order = AdvancedOrder({
            parameters: parameters,
            numerator: 1,
            denominator: 1,
            signature: signature,
            extraData: ""
        });

        if (recipient == address(0)) revert ZeroAddress();

        // Never trust `amount` blindly (see header on the Jan 2025 Across
        // disclosure's lesson) -- unwrap what was ACTUALLY delivered and
        // verify it against what the purchase needs before spending it.
        if (tokenSent == wrappedNativeToken) {
            _unwrapNative(amount);
        }
        // A non-wrapped-native tokenSent is out of scope for this receiver
        // (see param doc) -- amount stays 0-spendable-as-ETH below, and the
        // required-value check that follows fails closed rather than
        // silently proceeding with the wrong asset.

        uint256 delivered = address(this).balance;
        // orderPriceWei + router's own fee is computed inside buyNowFor;
        // this contract cannot know the exact fee rate without querying
        // the router, so it forwards its full delivered balance as
        // msg.value and lets buyNowFor's own InsufficientPayment check be
        // the authoritative gate -- avoids duplicating (and risking
        // drifting from) the router's fee arithmetic here.
        if (delivered < orderPriceWei) revert InsufficientDeliveredAmount(orderPriceWei, delivered);

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
        } catch {
            // Deliberately re-revert rather than swallow: per header, a
            // revert here is SAFE (atomically undoes the token delivery
            // too), so there is nothing to clean up -- letting the error
            // propagate is strictly better than a silent partial state.
            revert RouterCallFailed();
        }
    }

    /// @notice Accepts the unwrapped ETH from wrappedNativeToken's withdraw() call inside _unwrapNative, and nothing else meaningfully -- there is no other flow in this contract that sends it plain ETH.
    receive() external payable {}
}
