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
    /// @notice PR4 (ONESHOT §5.2 "Factory: isVault(address)"). Set exactly
    /// once, at deploy time, for every vault this factory ever creates — the
    /// same permissionless CREATE2 admission gate `deployVault` already is.
    /// Consumed by `WeightModule.onlyFactoryVault` (PR1) to gate signal
    /// ingestion to genuine factory-deployed vaults only.
    mapping(address => bool) private _isVault;

    event VaultDeployed(address indexed collection, address indexed vault, bytes32 salt);

    error VaultAlreadyExists();
    error ZeroAddress();
    /// @dev Replaces `require(deployed != address(0), "create2 failed")`. A
    /// revert STRING is stored verbatim in the deployed bytecode; a custom
    /// error is four selector bytes. Trivial on most contracts, worth taking
    /// on this one — it sits closest to EIP-170 of anything in the repo
    /// because it embeds all of `CollectionVault`'s creation code (see
    /// `_creationCode`), and there is no upgrade path to reclaim space later.
    error Create2Failed();

    constructor(address upstreamSink_, IERC20 paymentToken_, uint256 timelockDelay_) {
        if (upstreamSink_ == address(0) || address(paymentToken_) == address(0)) revert ZeroAddress();
        upstreamSink = upstreamSink_;
        paymentToken = paymentToken_;
        timelockDelay = timelockDelay_;
    }

    /**
     * @notice Uniqueness key. PHASE 2 (DESIGN-HONEST-INDEX-2026-08-09 §2):
     * **a vault is `(collection, predicate)`, not `collection`.** The salt
     * therefore commits to BOTH, so one collection may host several vaults
     * with disjoint or nested eligibility bands — a "floor" vault and a
     * "1/1s" vault of the same CryptoPunks-shaped collection are genuinely
     * different fungibility claims and must not be forced to share a share
     * token. Collapsing them into one vault is precisely the intra-vault
     * variance that audit C-5 extracts from.
     *
     * Creation stays PERMISSIONLESS: nobody defines the bands centrally, the
     * factory approves nothing, and the CREATE2 collision revert remains the
     * entire admission gate — it now merely gates `(collection, root)` pairs
     * rather than collections.
     */
    function vaultSalt(address collection, bytes32 eligibilityRoot) public pure returns (bytes32) {
        return keccak256(abi.encode(collection, eligibilityRoot));
    }

    /// @notice The salt of `collection`'s OPEN vault (`eligibilityRoot == 0`).
    function collectionSalt(address collection) public pure returns (bytes32) {
        return vaultSalt(collection, bytes32(0));
    }

    /// @notice Predict a collection's OPEN vault address before deploying it,
    /// for the EXACT constructor args a subsequent deployVault call would use.
    function predictVault(address collection, address treasury_, uint256 mintRedeemSinkBps_)
        external
        view
        returns (address)
    {
        return _predict(collection, treasury_, mintRedeemSinkBps_, bytes32(0));
    }

    /// @notice Predict a PREDICATE vault's address. Same relationship to
    /// `deployPredicateVault` as `predictVault` has to `deployVault`.
    function predictPredicateVault(
        address collection,
        address treasury_,
        uint256 mintRedeemSinkBps_,
        bytes32 eligibilityRoot
    ) external view returns (address) {
        return _predict(collection, treasury_, mintRedeemSinkBps_, eligibilityRoot);
    }

    function _predict(address collection, address treasury_, uint256 mintRedeemSinkBps_, bytes32 eligibilityRoot)
        private
        view
        returns (address)
    {
        bytes32 salt = vaultSalt(collection, eligibilityRoot);
        bytes memory bytecode = _creationCode(collection, treasury_, mintRedeemSinkBps_, eligibilityRoot);
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
        return _deploy(collection, treasury_, mintRedeemSinkBps_, bytes32(0));
    }

    /**
     * @notice Deploy a PREDICATE vault (DESIGN-HONEST-INDEX-2026-08-09 §2):
     * a vault whose `deposit` admits only tokenIds proven to lie in
     * `eligibilityRoot`'s merkle set.
     *
     * The root is passed straight into the vault's constructor as an
     * `immutable` and there is NO setter on the far side, so this call is the
     * only moment in the vault's entire lifetime at which its predicate is
     * chosen. That is deliberate and is the whole point: a mutable predicate
     * would let an owner attract deposits against a tight band and then widen
     * it to admit junk, which is a rug. Choose carefully; there is no second
     * chance, by construction.
     *
     * Passing `bytes32(0)` yields an OPEN vault, identical in every respect to
     * `deployVault` — and identically exposed to the C-5 rarity-sniping loss.
     * Kept legal because that failure is honest and locally contained: the
     * vault's own `S` depreciates and its weight decays, and nothing reaches
     * the index or any other vault.
     *
     * Still permissionless: no allowlist, no fee, no approval. The only gate
     * is the `(collection, root)` collision revert.
     */
    function deployPredicateVault(
        address collection,
        address treasury_,
        uint256 mintRedeemSinkBps_,
        bytes32 eligibilityRoot
    ) external returns (address vault) {
        return _deploy(collection, treasury_, mintRedeemSinkBps_, eligibilityRoot);
    }

    function _deploy(address collection, address treasury_, uint256 mintRedeemSinkBps_, bytes32 eligibilityRoot)
        private
        returns (address vault)
    {
        if (collection == address(0) || treasury_ == address(0)) revert ZeroAddress();
        bytes32 salt = vaultSalt(collection, eligibilityRoot);
        if (vaultForCollection[salt] != address(0)) revert VaultAlreadyExists();

        bytes memory bytecode = _creationCode(collection, treasury_, mintRedeemSinkBps_, eligibilityRoot);
        address deployed;
        assembly {
            deployed := create2(0, add(bytecode, 0x20), mload(bytecode), salt)
        }
        if (deployed == address(0)) revert Create2Failed();

        vaultForCollection[salt] = deployed;
        allVaults.push(deployed);
        _isVault[deployed] = true;
        emit VaultDeployed(collection, deployed, salt);
        return deployed;
    }

    function vaultCount() external view returns (uint256) {
        return allVaults.length;
    }

    /// @notice True iff `vault` was CREATE2-deployed by this exact factory.
    function isVault(address vault) external view returns (bool) {
        return _isVault[vault];
    }

    function _creationCode(address collection, address treasury_, uint256 mintRedeemSinkBps_, bytes32 eligibilityRoot)
        private
        view
        returns (bytes memory)
    {
        return abi.encodePacked(
            type(CollectionVault).creationCode,
            abi.encode(
                CollectionVault.VaultConfig({
                    collection: IERC721(collection),
                    paymentToken: paymentToken,
                    name: "Collection Vault Share",
                    symbol: "cvSHARE",
                    mintFeeWei: DEFAULT_MINT_FEE_WEI,
                    redeemFeeWei: DEFAULT_REDEEM_FEE_WEI,
                    swapFeeBps: DEFAULT_SWAP_FEE_BPS,
                    upstreamSink: upstreamSink,
                    treasury: treasury_,
                    mintRedeemSinkBps: mintRedeemSinkBps_,
                    timelockDelay: timelockDelay,
                    eligibilityRoot: eligibilityRoot
                })
            )
        );
    }
}
