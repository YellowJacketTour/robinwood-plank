// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {CollectionVault} from "./CollectionVault.sol";

/**
 * ============================================================================
 *  CollectionVaultFactory — permissionless, one vault per collection,
 *  design doc DESIGN-N-VAULT-FACTORY-AND-VALUE-ACCRUAL-2026-08-06.md §2 / §7.2.
 *
 *  Uniqueness key: keccak256(abi.encode(collectionAddress)) (§2.1's ERC-721
 *  case). CREATE2-deployed, so the vault address is deterministic and the
 *  factory reverts outright on a second deploy attempt for the same
 *  collection — that revert IS the entire admission gate, and it is
 *  genuinely permissionless: no allowlist, no fee, no approval.
 *
 *  Every economically load-bearing parameter is fixed HERE, at the FACTORY
 *  level, and passed into each vault's constructor as an immutable — this is
 *  what makes `upstreamSink` and the mandatory routing fraction genuinely
 *  "protocol-wide constant, not creator-settable" (design doc §2.1): no
 *  deployer of a vault chooses them, the factory's own constructor does,
 *  once, for the whole protocol.
 * ============================================================================
 */
contract CollectionVaultFactory {
    /// @notice The Diamond's own address (or designated collection point).
    /// Immutable at the factory level — every vault this factory ever
    /// deploys inherits the identical sink.
    address public immutable upstreamSink;
    /// @notice The ERC-20 every deployed vault denominates fees and its pool
    /// in. Fixed once, protocol-wide, so every vault's swept surplus lands on
    /// the SAME constituent the Diamond can reconcile.
    IERC20 public immutable paymentToken;
    /// @notice Timelock delay every deployed vault inherits for its
    /// treasury-change and sink-split-change queues.
    uint256 public immutable timelockDelay;

    uint256 public constant DEFAULT_MINT_FEE_WEI = 0.01 ether;
    uint256 public constant DEFAULT_REDEEM_FEE_WEI = 0.01 ether;
    /// @notice Default swap fee, 1% — MarketplankVaultV3's own vetted
    /// MAX_SWAP_FEE_BPS ceiling, reused verbatim as the factory-vault default
    /// (design doc §7.2).
    uint256 public constant DEFAULT_SWAP_FEE_BPS = 100;
    /// @notice Default Stream A split: the floor itself, 8.1%. A deployer may
    /// choose any value in [FLOOR, CEIL] at deploy time; nothing below the
    /// floor is ever constructible (CollectionVault's constructor reverts).
    uint256 public constant DEFAULT_MINT_REDEEM_SINK_BPS = 810;

    mapping(bytes32 => address) public vaultForCollection;
    address[] public allVaults;

    event VaultDeployed(address indexed collection, address indexed vault, bytes32 salt);

    error VaultAlreadyExists();
    error ZeroAddress();

    constructor(address upstreamSink_, IERC20 paymentToken_, uint256 timelockDelay_) {
        if (upstreamSink_ == address(0) || address(paymentToken_) == address(0)) revert ZeroAddress();
        upstreamSink = upstreamSink_;
        paymentToken = paymentToken_;
        timelockDelay = timelockDelay_;
    }

    function collectionSalt(address collection) public pure returns (bytes32) {
        return keccak256(abi.encode(collection));
    }

    /// @notice Predict a collection's vault address before deploying it, for
    /// the EXACT constructor args a subsequent deployVault call would use.
    function predictVault(address collection, address treasury_, uint256 mintRedeemSinkBps_)
        external
        view
        returns (address)
    {
        bytes32 salt = collectionSalt(collection);
        bytes memory bytecode = _creationCode(collection, treasury_, mintRedeemSinkBps_);
        return address(
            uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), salt, keccak256(bytecode)))))
        );
    }

    /**
     * @notice Deploy the one, permanent vault for `collection`. Permissionless.
     * Reverts if a vault for this collection already exists — the entire
     * admission gate.
     * @param treasury_ the vault's initial (later timelock-changeable) treasury.
     * @param mintRedeemSinkBps_ the deployer's chosen Stream A split, must lie
     * in [FLOOR_SINK_SPLIT_BPS, CEIL_SINK_SPLIT_BPS] or construction reverts.
     */
    function deployVault(address collection, address treasury_, uint256 mintRedeemSinkBps_)
        external
        returns (address vault)
    {
        if (collection == address(0) || treasury_ == address(0)) revert ZeroAddress();
        bytes32 salt = collectionSalt(collection);
        if (vaultForCollection[salt] != address(0)) revert VaultAlreadyExists();

        bytes memory bytecode = _creationCode(collection, treasury_, mintRedeemSinkBps_);
        address deployed;
        assembly {
            deployed := create2(0, add(bytecode, 0x20), mload(bytecode), salt)
        }
        require(deployed != address(0), "create2 failed");

        vaultForCollection[salt] = deployed;
        allVaults.push(deployed);
        emit VaultDeployed(collection, deployed, salt);
        return deployed;
    }

    function vaultCount() external view returns (uint256) {
        return allVaults.length;
    }

    function _creationCode(address collection, address treasury_, uint256 mintRedeemSinkBps_)
        private
        view
        returns (bytes memory)
    {
        return abi.encodePacked(
            type(CollectionVault).creationCode,
            abi.encode(
                IERC721(collection),
                paymentToken,
                "Collection Vault Share",
                "cvSHARE",
                DEFAULT_MINT_FEE_WEI,
                DEFAULT_REDEEM_FEE_WEI,
                DEFAULT_SWAP_FEE_BPS,
                upstreamSink,
                treasury_,
                mintRedeemSinkBps_,
                timelockDelay
            )
        );
    }
}
