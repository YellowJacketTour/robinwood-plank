// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * ============================================================================
 *  TBAValueSweeper — universal stranded-value sweep for ERC-6551 token-bound
 *  accounts owned by vault-held NFTs
 *
 *  NOT FOR DEPLOYMENT. Same gate as GlobalIndexVault.sol, PlankGauge.sol and
 *  IndexDividendDistributor.sol: nothing in this repo may put any of them on
 *  any network until the external audit clears. hardhat.config.ts has no
 *  default network on purpose; keep it that way.
 *
 *  THE PROBLEM
 *  -----------
 *  An NFT custodied by MarketplankVault / MarketplankVaultV3 may itself own an
 *  ERC-6551 token-bound account (TBA), and that TBA can keep accruing value
 *  long after the mint — the StonkBrokers precedent, where each NFT's TBA was
 *  seeded with tokenized stock and then fed by ongoing AMM-fee-funded
 *  airdrops. While the vault holds the NFT, the vault is the TBA's owner, so
 *  that value is economically the vault's — but nothing was ever moving it
 *  into vault-accounted reserves. It just sat there, stranded, invisible to
 *  every share-holder's pro-rata claim.
 *
 *  This contract is the sweep. It is deliberately a SEPARATE contract with no
 *  authority over either vault, for the same reason IndexDividendDistributor
 *  is separate: the vaults' redemption paths are the part that has to be
 *  perfect, and the cheapest way to keep them perfect is to not touch them.
 *
 *  ══ THE THREE HARD RULES THIS FILE ENFORCES ═══════════════════════════════
 *
 *  1. ZERO INTERACTION WITH ANY REDEMPTION PATH.
 *     This contract holds no vault authority of any kind. Its entire view of
 *     each vault is `IHeldNftOwner` — nothing but `isTokenHeld`, a view. It
 *     cannot pause, gate, delay, queue, reserve or otherwise touch a user's
 *     withdrawal, because none of those levers exist in this bytecode to be
 *     reached. Sweeping is purely additive value capture, and a user's exit
 *     works identically whether a sweep is mid-flight, pending, disabled, or
 *     with a hostile allowlist queued. The suite proves this directly.
 *
 *  2. NO CUSTODY, EVER, NOT EVEN FOR ONE OPCODE.
 *     Every sweep moves value from the TBA (or the position manager) DIRECTLY
 *     to an IMMUTABLE destination set at construction. This contract never
 *     takes intermediate custody, has no `transfer`, `withdraw`, `rescue`,
 *     `sweepTo`, or any other function that can move a token it holds, and
 *     takes no `recipient` argument on any function. So:
 *       - a permissionless caller gets exactly zero personal benefit; there is
 *         no argument they could point anywhere, and no balance here to take;
 *       - once value is credited, NO role — including ROLE_ADMIN — has a
 *         claw-back path, because the destination is immutable and no transfer
 *         function exists. Swept value behaves exactly like every other
 *         reserve asset: redeemable pro rata through the vault's own path.
 *
 *  3. NO GENERAL-PURPOSE CALLDATA FORWARDING. NOT FOR ANYONE. NOT FOR ADMIN.
 *     ERC-6551's `execute()` runs arbitrary calldata as the TBA. Since the
 *     vault owns the NFT, the vault — and only the vault — resolves as that
 *     owner, so a "forward this calldata to a TBA the vault owns" function
 *     would be a universal drain wearing a helper's hat. There is no such
 *     function here, for any role.
 *
 *     THE HONEST ENGINEERING NOTE, stated plainly because it matters:
 *     `execute()` is the ONLY mechanism by which a TBA's ERC-20 balance can
 *     move at all — the TBA *is* the token holder, so `IERC20.transfer` has to
 *     originate from the TBA's own address. There is no alternative primitive
 *     in ERC-6551. What this contract therefore does is the narrowest possible
 *     version of that: it calls `execute()` with calldata it CONSTRUCTS ITSELF
 *     via `abi.encodeCall`, from an allowlisted asset address and a
 *     contract-fixed destination, with `value = 0` and `operation = 0` (CALL,
 *     never delegatecall) hardcoded. No `bytes` parameter appears in any
 *     external function signature in this file. Grep it: there is exactly one
 *     `execute(` call site per primitive, each with a fixed-shape
 *     `abi.encodeCall` and no caller-influenced bytes anywhere in it. A caller
 *     chooses only WHICH allowlisted asset to sweep, never what happens to it.
 *
 *  ══ WHY THE TBA ADDRESS IS DERIVED, NOT BELIEVED (v2) ═════════════════════
 *  `tbaAddress` is caller-supplied. Authenticating it with `token()` and
 *  `owner()` alone is authenticating an address by ASKING THAT ADDRESS: any
 *  contract deployed anywhere can implement both views, answer correctly, and
 *  then do as it pleases when `execute()` reaches it — a sweep "from held NFT
 *  #7's account" that in truth touched an attacker's contract that merely
 *  claimed to be it.
 *
 *  ERC-6551 removes the need to trust the claim at all: a genuine account's
 *  address is a deterministic CREATE2 function of (implementation, salt,
 *  chainId, tokenContract, tokenId). So this contract asks the REGISTRY —
 *  `IERC6551Registry.account()`, the derivation's own author — for the address
 *  NFT #heldTokenId's account must have, and requires an exact match before any
 *  primitive proceeds. The registry, implementation and salt are all immutable
 *  constructor parameters: the definition of "genuine TBA" cannot be edited
 *  after deployment any more than the sinks can.
 *
 *  The registry is asked rather than the CREATE2 math re-derived locally on
 *  purpose. A local copy is a second implementation of a spec this contract
 *  does not own, free to drift from it; the registry cannot drift from itself.
 *
 *  ══ WHY THE SINKS ARE VALIDATED AT CONSTRUCTION (v2) ══════════════════════
 *  The sinks must be immutable — that is the whole of rule 2's no-claw-back
 *  guarantee, and nothing here softens it: there is still no setter, no queue,
 *  no role, no path of any kind to change either one. But immutability defends
 *  a WRONG sink exactly as faithfully as a right one, so the assurance has to
 *  be bought at construction, where it is still purchasable:
 *
 *    - A sink must be a CONTRACT. A raw EOA sink is a personal wallet with the
 *      word "reserve" written on it, which is precisely what "value lands in
 *      accounted reserves" is meant to exclude. `SinkNotContract` refuses it.
 *    - Whatever code each sink holds is hashed, sized and EMITTED at deploy
 *      time (`SinksValidated`), so the deployer's choice is a public, indexed,
 *      permanently-checkable fact rather than something a reviewer has to be
 *      told. `sinksValidated()` re-checks it any time, forever.
 *
 *  Both are construction-time only. Neither adds a post-deploy redirect, and
 *  no code path anywhere in this file acts on `sinksValidated()`'s answer.
 *
 *  ══ DEPLOYMENT PREREQUISITE, STATED HONESTLY ══════════════════════════════
 *  An ERC-6551 account executes only for its resolved owner (the vault) or for
 *  a caller that owner has explicitly permitted — most reference accounts
 *  expose `setPermissions` for exactly that. So this contract only works once
 *  it is a permitted executor on the TBAs in question. That is a FEATURE of
 *  the separation, not a workaround: granting execute rights to a contract
 *  whose entire external surface is three fixed-shape, allowlisted,
 *  fixed-destination sweeps is safe in a way that granting them to a
 *  general-purpose forwarder never is. Note what is deliberately NOT done to
 *  close this gap: no forwarder was added to either vault. A vault function
 *  that relays calldata to a TBA it owns is the drain this whole design
 *  refuses, and it stays refused even at the cost of an extra setup step.
 *
 *  ══ WHY A PER-ASSET ALLOWLIST, AND WHY TIMELOCKED ═════════════════════════
 *  Never sweep an arbitrary token balance. An arbitrary inbound ERC-20 can be
 *  fee-on-transfer, reentrant, or a balance-lying honeypot; an arbitrary
 *  inbound ERC-721 can revert in `onERC721Received` downstream, or simply
 *  dilute basket accounting with junk. Both are griefing vectors that cost the
 *  attacker one airdrop. So an asset is sweepable only after
 *  `queueAsset` -> full timelock -> `executeAsset`, the same shape every other
 *  allowlist in this codebase uses.
 *
 *  ══ WHY A NEW SCOPED ROLE ═════════════════════════════════════════════════
 *  `ROLE_SWEEP_ALLOWLIST` is a new role rather than a reuse of one of
 *  GlobalIndexVault's four, for two independent reasons:
 *
 *    (a) This is a different contract with a different role registry. Reusing
 *        the *name* of a vault role would imply a shared key across two
 *        deployments and quietly widen that key's blast radius — the exact
 *        thing ScopedRoles.sol exists to prevent.
 *    (b) The capability does not fit any of the four on its merits.
 *        ROLE_CONSTITUENT_ADMISSION decides what the basket is PRICED on;
 *        a sweep allowlist decides what stray value may be COLLECTED, and a
 *        swept asset is never priced as a constituent by this contract.
 *        ROLE_RISK_PARAM is numeric caps. ROLE_PLATFORM_ALLOCATION is the
 *        operator cut, and this contract routes nothing to any operator.
 *
 *  The role is narrow to the point of being boring: it can add or remove
 *  entries on three allowlists, on a timelock, and it can do nothing else. It
 *  cannot move value, cannot redirect a destination, cannot pause a sweep, and
 *  cannot reach a user's redemption. Worst case with the key fully compromised
 *  and the timelock elapsed: an attacker allowlists a hostile asset, and then
 *  discovers that sweeping it moves it to the immutable destination, which is
 *  not them. See "a hostile allowlist buys the attacker nothing" in the suite.
 * ============================================================================
 */

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import {ScopedRoles} from "./ScopedRoles.sol";

/**
 * @notice The REAL public ERC-6551 account interface, view functions only.
 * Used to READ which TBA belongs to which held NFT. Never written to.
 */
interface IERC6551Account {
    function token() external view returns (uint256 chainId, address tokenContract, uint256 tokenId);

    function owner() external view returns (address);
}

/**
 * @notice The REAL ERC-6551 registry interface. `account()` is the registry's
 * OWN canonical CREATE2 derivation: given (implementation, salt, chainId,
 * tokenContract, tokenId) it returns the one and only address at which a
 * genuine token-bound account for that NFT can exist.
 *
 * This is the authoritative answer to "is this really NFT #n's TBA?", and it is
 * why this contract asks the registry rather than reimplementing the CREATE2
 * formula locally: a local reimplementation would be a second, drifting copy of
 * a spec this contract does not own. The registry is the spec.
 */
interface IERC6551Registry {
    function account(
        address implementation,
        bytes32 salt,
        uint256 chainId,
        address tokenContract,
        uint256 tokenId
    ) external view returns (address);
}

/**
 * @notice The ERC-6551 execution interface, deliberately declared as its own
 * one-function type so that every use of it in this file is trivially
 * greppable and reviewable. Calldata passed to it is ALWAYS built by this
 * contract from an allowlisted address plus a contract-fixed destination.
 */
interface IERC6551Executable {
    function execute(address to, uint256 value, bytes calldata data, uint8 operation)
        external
        payable
        returns (bytes memory);
}

/**
 * @notice The ONLY thing this contract asks a vault. One view. No deposit, no
 * redeem, no admin, no parameter — so none exists in this bytecode to be
 * reached by any caller or any bug, exactly as IIndexMint does for the
 * distributor but in the read-only direction.
 */
interface IHeldNftOwner {
    function isTokenHeld(uint256 tokenId) external view returns (bool);
}

/// @notice Uniswap v3/v4-style concentrated-liquidity position manager, the
/// two members this contract needs. `collect` pays a recipient chosen by the
/// caller — which is why this contract hardcodes it to `reserveSink` and
/// exposes no recipient argument.
interface IPositionManager {
    struct CollectParams {
        uint256 tokenId;
        address recipient;
        uint128 amount0Max;
        uint128 amount1Max;
    }

    function collect(CollectParams calldata params)
        external
        payable
        returns (uint256 amount0, uint256 amount1);

    function ownerOf(uint256 tokenId) external view returns (address);
}

contract TBAValueSweeper is ReentrancyGuard, ScopedRoles {
    /// @notice Generation marker so the client never has to sniff bytecode.
    /// v2 adds (a) registry-derived TBA address verification and (b) sink
    /// construction-time contract validation with a published attestation.
    uint256 public constant SWEEPER_VERSION = 2;

    /**
     * @notice The allowlist administration role. Adds/removes sweepable asset
     * contracts and position managers, on a timelock, and does nothing else.
     * See the header for why this is a new role and not one of the vault's.
     */
    bytes32 public constant ROLE_SWEEP_ALLOWLIST = "sweep.allowlist";

    enum AssetKind {
        None,
        ERC20,
        ERC721,
        PositionManager
    }

    /// @notice The NFT collection whose token IDs the vault custodies.
    IERC721 public immutable collection;

    /// @notice The vault that holds the NFTs, seen through a read-only,
    /// one-view lens.
    IHeldNftOwner public immutable vault;

    /**
     * @notice Where every swept ERC-20 and every collected LP fee lands.
     * IMMUTABLE. This is the whole of rule 2: there is no setter, no queued
     * change, and no role that can move it, so credited value can never be
     * redirected after the fact. In production this is the accounted-reserve /
     * dividend sink (e.g. IndexDividendDistributor), which is push-only.
     */
    address public immutable reserveSink;

    /**
     * @notice Where every swept ERC-721 lands — the "swept miscellany"
     * holding. IMMUTABLE, and required at construction to be a DIFFERENT
     * address from the vault, so a swept junk NFT can never be commingled with
     * the basket's priced constituent accounting. That separation is
     * structural, not a convention someone has to remember.
     */
    address public immutable miscellanySink;

    /**
     * @notice The ERC-6551 registry whose `account()` view is treated as the
     * ONLY authority on which address is a given NFT's token-bound account.
     * IMMUTABLE — a mutable registry would be a mutable definition of "genuine
     * TBA", i.e. the same hole in slower motion.
     */
    IERC6551Registry public immutable accountRegistry;

    /// @notice The account implementation the registry deploys behind. Part of
    /// the derivation domain, so a TBA at the right (collection, tokenId) but
    /// built on a DIFFERENT implementation derives to a different address and
    /// is rejected.
    address public immutable accountImplementation;

    /// @notice The registry salt this deployment recognises. Same reasoning:
    /// one deployment, one canonical account per NFT, no ambiguity.
    bytes32 public immutable accountSalt;

    /**
     * @notice The code hashes each sink had at construction, recorded so the
     * deployer's choice is a published, checkable fact rather than a trust
     * assumption. See `sinksValidated()`.
     */
    bytes32 public immutable reserveSinkCodehash;
    bytes32 public immutable miscellanySinkCodehash;

    /// @notice Timelock delay, immutable, shared by allowlist entries and by
    /// ScopedRoles reassignment — so a role rotation can never be scheduled on
    /// a shorter clock than an allowlist change.
    uint256 public immutable timelockDelay;

    uint256 private constant MIN_TIMELOCK = 1 days;
    uint256 private constant MAX_TIMELOCK = 30 days;

    struct QueuedAsset {
        AssetKind kind;
        bool allow;
        bool pending;
        uint64 eta;
    }

    /// @notice kind => asset contract => sweepable.
    mapping(AssetKind => mapping(address => bool)) public allowed;
    /// @notice kind => asset contract => pending timelocked change.
    mapping(AssetKind => mapping(address => QueuedAsset)) public queuedAssets;

    event AssetQueued(AssetKind indexed kind, address indexed asset, bool allow, uint64 eta);
    event AssetApplied(AssetKind indexed kind, address indexed asset, bool allow);
    event AssetCancelled(AssetKind indexed kind, address indexed asset);
    event SweptERC20(
        uint256 indexed heldTokenId,
        address indexed tba,
        address indexed asset,
        uint256 amount
    );
    event SweptERC721(
        uint256 indexed heldTokenId,
        address indexed tba,
        address indexed asset,
        uint256 assetTokenId
    );
    event CollectedLpFees(
        uint256 indexed heldTokenId,
        address indexed positionManager,
        uint256 positionTokenId,
        uint256 amount0,
        uint256 amount1
    );

    /**
     * @notice Emitted exactly once, at construction, recording precisely what
     * the deployer pointed this sweeper at: both sinks, the code hash and code
     * size each contained AT THAT MOMENT, and the registry/implementation/salt
     * triple that defines a genuine TBA here.
     *
     * The sinks stay immutable — this adds no redirect path of any kind. What
     * it adds is that a wrong or hostile sink is impossible to choose SILENTLY:
     * the choice is on-chain, in the deployment receipt, before one wei has
     * ever been swept.
     */
    event SinksValidated(
        address indexed reserveSink,
        address indexed miscellanySink,
        bytes32 reserveCodehash,
        bytes32 miscellanyCodehash,
        uint256 reserveCodeSize,
        uint256 miscellanyCodeSize
    );

    event RegistryBound(address indexed registry, address indexed implementation, bytes32 salt);

    error BadParam();
    /// @notice A sink with no code. An EOA sink defeats the entire point of
    /// "value lands in accounted reserves, not somebody's personal wallet",
    /// and it is refused at construction rather than discovered later.
    error SinkNotContract(address sink);
    /// @notice `tbaAddress` is not the address the registry derives for this
    /// held NFT. The fake-TBA close.
    error TbaNotRegistryDerived(address supplied, address derived);
    error NotAllowlisted(address asset);
    error NothingQueued();
    error TimelockNotElapsed();
    error TokenNotHeldByVault(uint256 heldTokenId);
    error TbaNotBoundToHeldToken();
    error TbaOwnerMismatch();
    error WrongChain();
    error NothingToSweep();
    error PositionNotOwnedByTba();
    error ExecuteFailed();
    error SweepDidNotLand();

    /**
     * @param collection_ the NFT collection the vault custodies.
     * @param vault_ the custodying vault (read-only from here).
     * @param reserveSink_ immutable destination for ERC-20s and LP fees.
     * @param miscellanySink_ immutable destination for swept ERC-721s. Must
     *        differ from `vault_` — non-commingling, enforced at construction.
     * @param timelockDelay_ delay for allowlist entries and role rotations.
     * @param roles_ [ROLE_ADMIN, ROLE_SWEEP_ALLOWLIST].
     * @param registry_ the ERC-6551 registry that defines, canonically, which
     *        address is a given NFT's token-bound account.
     * @param implementation_ the account implementation that registry deploys.
     * @param salt_ the registry salt for this deployment's accounts.
     */
    constructor(
        IERC721 collection_,
        IHeldNftOwner vault_,
        address reserveSink_,
        address miscellanySink_,
        uint256 timelockDelay_,
        address[2] memory roles_,
        IERC6551Registry registry_,
        address implementation_,
        bytes32 salt_
    ) {
        if (
            address(collection_) == address(0) ||
            address(vault_) == address(0) ||
            reserveSink_ == address(0) ||
            miscellanySink_ == address(0) ||
            address(registry_) == address(0) ||
            implementation_ == address(0)
        ) revert BadParam();
        // A registry or an implementation with no code cannot possibly be the
        // authority this contract is about to trust for every sweep.
        if (address(registry_).code.length == 0 || implementation_.code.length == 0) {
            revert BadParam();
        }
        // The non-commingling rule, made structural.
        if (miscellanySink_ == address(vault_)) revert BadParam();
        // A sweep destination that is this contract would be custody, and
        // custody is the thing rule 2 forbids.
        if (reserveSink_ == address(this) || miscellanySink_ == address(this)) revert BadParam();
        if (timelockDelay_ < MIN_TIMELOCK || timelockDelay_ > MAX_TIMELOCK) revert BadParam();

        // ══ SINK VALIDATION, CONSTRUCTION-TIME ONLY ═════════════════════════
        // The sinks must stay immutable — that immutability is exactly what
        // makes swept value un-clawable-back, and nothing below weakens it.
        // But immutability protects a WRONG sink just as faithfully as a right
        // one, so the assurance has to be paid for up front, here, once:
        //
        //   (1) a sink must be a CONTRACT. An EOA sink is a personal wallet
        //       wearing the word "reserve", and it is the single most likely
        //       way this deployment could be silently wrong. Refused outright.
        //   (2) whatever code each sink holds is HASHED, SIZED AND PUBLISHED
        //       in the deployment receipt, so "which sink, containing what"
        //       stops being a claim and becomes a verifiable on-chain fact.
        //
        // There is deliberately no post-construction path to revisit either.
        uint256 reserveSize = reserveSink_.code.length;
        uint256 miscSize = miscellanySink_.code.length;
        if (reserveSize == 0) revert SinkNotContract(reserveSink_);
        if (miscSize == 0) revert SinkNotContract(miscellanySink_);

        collection = collection_;
        vault = vault_;
        reserveSink = reserveSink_;
        miscellanySink = miscellanySink_;
        timelockDelay = timelockDelay_;
        accountRegistry = registry_;
        accountImplementation = implementation_;
        accountSalt = salt_;

        bytes32 rHash = reserveSink_.codehash;
        bytes32 mHash = miscellanySink_.codehash;
        reserveSinkCodehash = rHash;
        miscellanySinkCodehash = mHash;

        _initRole(ROLE_ADMIN, roles_[0]);
        _initRole(ROLE_SWEEP_ALLOWLIST, roles_[1]);

        emit SinksValidated(reserveSink_, miscellanySink_, rHash, mHash, reserveSize, miscSize);
        emit RegistryBound(address(registry_), implementation_, salt_);
    }

    function _timelockDelay() internal view override returns (uint256) {
        return timelockDelay;
    }

    function _isKnownRole(bytes32 role) internal pure override returns (bool) {
        return role == ROLE_ADMIN || role == ROLE_SWEEP_ALLOWLIST;
    }

    // ══ Allowlist administration — timelocked, and nothing else ═════════════

    /**
     * @notice Queue an allowlist change. ROLE_SWEEP_ALLOWLIST only, lands no
     * sooner than `timelockDelay` from now.
     *
     * @dev Note what this cannot do, in either direction: it cannot move a
     * token, cannot redirect a sink, cannot reach a redemption, and cannot
     * un-credit anything already swept. Removing an asset from the allowlist
     * stops FUTURE sweeps of it and has no retroactive effect whatsoever.
     */
    function queueAsset(AssetKind kind, address asset, bool allow)
        external
        onlyRole(ROLE_SWEEP_ALLOWLIST)
    {
        if (kind == AssetKind.None || asset == address(0)) revert BadParam();
        uint64 eta = uint64(block.timestamp + timelockDelay);
        queuedAssets[kind][asset] = QueuedAsset({kind: kind, allow: allow, pending: true, eta: eta});
        emit AssetQueued(kind, asset, allow, eta);
    }

    /// @notice Apply a queued allowlist change once the delay has elapsed.
    /// Permissionless after the eta, exactly as ScopedRoles.executeRole is.
    function executeAsset(AssetKind kind, address asset) external {
        QueuedAsset memory q = queuedAssets[kind][asset];
        if (!q.pending) revert NothingQueued();
        if (block.timestamp < q.eta) revert TimelockNotElapsed();
        delete queuedAssets[kind][asset];
        allowed[kind][asset] = q.allow;
        emit AssetApplied(kind, asset, q.allow);
    }

    /// @notice Withdraw a queued allowlist change. Grants no capability — the
    /// only thing it can prevent is a change this same role scheduled.
    function cancelAsset(AssetKind kind, address asset)
        external
        onlyRole(ROLE_SWEEP_ALLOWLIST)
    {
        if (!queuedAssets[kind][asset].pending) revert NothingQueued();
        delete queuedAssets[kind][asset];
        emit AssetCancelled(kind, asset);
    }

    // ══ Primitive 1 — stranded ERC-20 inside a held NFT's TBA ══════════════

    /**
     * @notice Sweep an allowlisted ERC-20's ENTIRE balance out of the TBA of a
     * vault-held NFT, straight into the immutable reserve sink. Permissionless.
     *
     * The calldata handed to `execute` is built right here by `abi.encodeCall`
     * from (allowlisted asset, immutable sink, measured balance). Nothing the
     * caller supplies reaches it. `value = 0`, `operation = 0` (CALL).
     *
     * DOUBLE-SWEEP IS SAFE. The amount is the TBA's measured balance at call
     * time, and the credit is the sink's measured delta — so a second sweep
     * with nothing left reverts `NothingToSweep` before any state or any
     * external write happens. There is no counter to double-increment and no
     * "credited" bookkeeping here at all; the sink's own balance IS the
     * accounting, which is what makes double-credit unrepresentable rather
     * than merely guarded.
     *
     * FEE-ON-TRANSFER AND LYING TOKENS. The event reports the sink's ACTUAL
     * received delta, never the nominal amount — the same Balancer-STA
     * discipline as GlobalIndexVault._pullCredited. A token that moves zero
     * while claiming success reverts `SweepDidNotLand` instead of emitting a
     * fictional credit.
     */
    function sweepTBAERC20(uint256 heldTokenId, address tbaAddress, address assetContract)
        external
        nonReentrant
        returns (uint256 credited)
    {
        if (!allowed[AssetKind.ERC20][assetContract]) revert NotAllowlisted(assetContract);
        _requireTbaOfHeldToken(heldTokenId, tbaAddress);

        uint256 amount = IERC20(assetContract).balanceOf(tbaAddress);
        if (amount == 0) revert NothingToSweep();

        address sink = reserveSink;
        uint256 before = IERC20(assetContract).balanceOf(sink);

        // The ONLY execute() call site of primitive 1. Fixed shape, fixed
        // destination, self-built calldata, no caller bytes.
        _execute(tbaAddress, assetContract, abi.encodeCall(IERC20.transfer, (sink, amount)));

        credited = IERC20(assetContract).balanceOf(sink) - before;
        if (credited == 0) revert SweepDidNotLand();
        emit SweptERC20(heldTokenId, tbaAddress, assetContract, credited);
    }

    // ══ Primitive 2 — stranded ERC-721 inside a held NFT's TBA ═════════════

    /**
     * @notice Sweep an allowlisted ERC-721 out of the TBA of a vault-held NFT
     * into the SEPARATE swept-miscellany holding. Permissionless.
     *
     * Lands in `miscellanySink`, never the vault, so a swept NFT is never
     * commingled with the basket's priced constituent accounting — it is
     * captured value held plainly, not a new basket member that silently
     * changes what a share is worth.
     *
     * `safeTransferFrom` (the 3-arg form) is used, as specified, which means a
     * receiver that reverts in `onERC721Received` blocks its OWN sweep. That
     * is contained: it reverts this one call for this one asset and cannot
     * touch a different allowlisted asset's sweep, because there is no shared
     * mutable state between sweeps to corrupt and no loop for one bad element
     * to abort. The suite proves that containment directly.
     */
    function sweepTBAERC721(
        uint256 heldTokenId,
        address tbaAddress,
        address assetContract,
        uint256 assetTokenId
    ) external nonReentrant {
        if (!allowed[AssetKind.ERC721][assetContract]) revert NotAllowlisted(assetContract);
        _requireTbaOfHeldToken(heldTokenId, tbaAddress);

        if (IERC721(assetContract).ownerOf(assetTokenId) != tbaAddress) revert NothingToSweep();

        address sink = miscellanySink;

        // The ONLY execute() call site of primitive 2. Fixed shape, fixed
        // destination, self-built calldata, no caller bytes.
        _execute(
            tbaAddress,
            assetContract,
            abi.encodeWithSignature(
                "safeTransferFrom(address,address,uint256)",
                tbaAddress,
                sink,
                assetTokenId
            )
        );

        // Verified, not assumed: a token that "succeeded" without moving does
        // not get an event saying it moved.
        if (IERC721(assetContract).ownerOf(assetTokenId) != sink) revert SweepDidNotLand();
        emit SweptERC721(heldTokenId, tbaAddress, assetContract, assetTokenId);
    }

    // ══ Primitive 3 — concentrated-liquidity LP positions ══════════════════

    /**
     * @notice Collect the uncollected fees accrued INSIDE a Uniswap-v3/v4-style
     * position owned by a held NFT's TBA, paying them straight to the immutable
     * reserve sink. Permissionless.
     *
     * WHY THIS EXISTS SEPARATELY FROM PRIMITIVE 2. A concentrated-liquidity
     * position accrues fees inside the position itself, so sweeping the
     * position NFT alone leaves the accrued fees behind — moving the wrapper
     * and abandoning the value. This collects first. The position NFT itself
     * may then be swept via primitive 2, if and only if the position manager
     * is ALSO allowlisted as an ERC721; that is a separate, separately-queued
     * allowlist decision on purpose.
     *
     * The `recipient` is hardcoded to `reserveSink`. There is no recipient
     * argument on this function, so a permissionless caller cannot direct one
     * wei of collected fees anywhere but the sink — which is the whole reason
     * `collect` could not simply be exposed.
     *
     * FUNGIBLE v2-STYLE LP TOKENS NEED NOTHING HERE. They are plain ERC-20s;
     * allowlist the pair address and primitive 1 already covers them.
     */
    function sweepLpPositionFees(
        uint256 heldTokenId,
        address tbaAddress,
        address positionManager,
        uint256 positionTokenId
    ) external nonReentrant returns (uint256 amount0, uint256 amount1) {
        if (!allowed[AssetKind.PositionManager][positionManager]) {
            revert NotAllowlisted(positionManager);
        }
        _requireTbaOfHeldToken(heldTokenId, tbaAddress);

        // The position must actually belong to THIS TBA. Without this, an
        // allowlisted manager plus any TBA would let a caller trigger a
        // collect on somebody else's position.
        if (IPositionManager(positionManager).ownerOf(positionTokenId) != tbaAddress) {
            revert PositionNotOwnedByTba();
        }

        // The ONLY execute() call site of primitive 3. Self-built calldata,
        // recipient pinned to the immutable sink, both maxima at type max so
        // the call takes everything owed and nothing is left as dust.
        bytes memory ret = _execute(
            tbaAddress,
            positionManager,
            abi.encodeCall(
                IPositionManager.collect,
                (
                    IPositionManager.CollectParams({
                        tokenId: positionTokenId,
                        recipient: reserveSink,
                        amount0Max: type(uint128).max,
                        amount1Max: type(uint128).max
                    })
                )
            )
        );

        if (ret.length >= 64) {
            (amount0, amount1) = abi.decode(ret, (uint256, uint256));
        }
        if (amount0 == 0 && amount1 == 0) revert NothingToSweep();
        emit CollectedLpFees(heldTokenId, positionManager, positionTokenId, amount0, amount1);
    }

    // ══ Views ══════════════════════════════════════════════════════════════

    /// @notice Is `asset` sweepable under `kind` right now.
    function isAllowed(AssetKind kind, address asset) external view returns (bool) {
        return allowed[kind][asset];
    }

    /**
     * @notice The two immutable destinations, published so any caller can
     * verify before sweeping that neither is them.
     */
    function sinks() external view returns (address reserve, address miscellany) {
        return (reserveSink, miscellanySink);
    }

    /**
     * @notice The canonical TBA address this contract will accept for
     * `heldTokenId`, derived by the registry. Published so anyone can check,
     * off-chain and before spending gas, exactly which address is sweepable —
     * and so the answer never has to be taken from the account itself.
     */
    function expectedTba(uint256 heldTokenId) external view returns (address) {
        return
            accountRegistry.account(
                accountImplementation,
                accountSalt,
                block.chainid,
                address(collection),
                heldTokenId
            );
    }

    /**
     * @notice Are both sinks still exactly the contracts they were at
     * construction. A pure observation — nothing in this contract can act on
     * it, and no answer it gives can redirect anything, because the sinks are
     * immutable either way. It exists so that "the sinks are what the deployer
     * attested to" is continuously checkable rather than a one-time promise.
     */
    function sinksValidated()
        external
        view
        returns (bool reserveOk, bool miscellanyOk, bytes32 reserveCodehash, bytes32 miscellanyCodehash)
    {
        reserveCodehash = reserveSinkCodehash;
        miscellanyCodehash = miscellanySinkCodehash;
        reserveOk = reserveSink.codehash == reserveCodehash && reserveSink.code.length != 0;
        miscellanyOk =
            miscellanySink.codehash == miscellanyCodehash &&
            miscellanySink.code.length != 0;
    }

    function capabilities()
        external
        pure
        returns (
            bool pushOnly,
            bool holdsCustody,
            bool canBlockRedemption,
            bool forwardsArbitraryCalldata,
            uint256 version
        )
    {
        // All four are structural facts, not settings: there is no transfer
        // function, no vault authority, and no `bytes` parameter in any
        // external signature in this file.
        return (true, false, false, false, SWEEPER_VERSION);
    }

    // ══ Internals ══════════════════════════════════════════════════════════

    /**
     * @dev Prove that `tba` is the token-bound account OF `heldTokenId`, and
     * that `heldTokenId` really is in the vault. Three independent checks,
     * each of which alone would be a hole:
     *
     *   1. `IERC6551Account.token()` — the TBA's own claim about which NFT
     *      binds it — must name THIS chain, THIS collection and THIS token id.
     *      Without the chainId check, a cross-chain-bound account matches.
     *   2. The collection must report the VAULT as `ownerOf(heldTokenId)`.
     *      This is the check that stops sweeping from a TBA whose NFT the
     *      vault does not hold: an attacker's own NFT's TBA fails here.
     *   3. `IERC6551Account.owner()` must resolve to the vault too. Defence in
     *      depth against a non-standard account whose ownership resolution
     *      disagrees with (1)+(2).
     *
     * Plus the vault's own `isTokenHeld` view, so a token sitting at the vault
     * address without being part of its held set is not sweepable either.
     *
     * All four are `view`. Nothing here writes to the TBA.
     */
    function _requireTbaOfHeldToken(uint256 heldTokenId, address tba) private view {
        if (tba == address(0)) revert BadParam();

        (uint256 chainId, address tokenContract, uint256 tokenId) = IERC6551Account(tba).token();
        if (chainId != block.chainid) revert WrongChain();
        if (tokenContract != address(collection) || tokenId != heldTokenId) {
            revert TbaNotBoundToHeldToken();
        }

        address vaultAddr = address(vault);
        if (collection.ownerOf(heldTokenId) != vaultAddr) revert TokenNotHeldByVault(heldTokenId);
        if (!vault.isTokenHeld(heldTokenId)) revert TokenNotHeldByVault(heldTokenId);
        if (IERC6551Account(tba).owner() != vaultAddr) revert TbaOwnerMismatch();

        // ══ THE CHECK THAT MAKES THE THREE ABOVE UNFAKEABLE ═════════════════
        // Everything above this line is a SELF-REPORT: `token()` and `owner()`
        // are views on the very address being authenticated, so a contract
        // deployed anywhere at all can implement both and answer whatever gets
        // it past them — and then behave however it likes when `execute()` is
        // called on it. A fake would sail through 1-3 and misattribute a sweep
        // to a held NFT it has nothing to do with.
        //
        // ERC-6551 makes that unnecessary: a genuine account address is a pure
        // CREATE2 function of (implementation, salt, chainId, tokenContract,
        // tokenId), so the right address can be DERIVED rather than believed.
        // We ask the registry itself, which owns that derivation, and require
        // an exact match before any sweep primitive touches the account.
        //
        // Note the derivation is fed `heldTokenId` — the id the caller is
        // claiming and that the vault was just proven to hold — never anything
        // the supplied address told us about itself. The self-reported values
        // cannot steer their own verification.
        address derived = accountRegistry.account(
            accountImplementation,
            accountSalt,
            block.chainid,
            address(collection),
            heldTokenId
        );
        if (tba != derived) revert TbaNotRegistryDerived(tba, derived);
    }

    /**
     * @dev The single execute() helper. `data` is ALWAYS built by a caller
     * inside this file from allowlisted + immutable inputs; this function is
     * `private`, so no external actor can reach it with bytes of their own.
     * `value` is 0 and `operation` is 0 (CALL — never delegatecall, which
     * would let a target rewrite the TBA itself).
     */
    function _execute(address tba, address target, bytes memory data)
        private
        returns (bytes memory)
    {
        return IERC6551Executable(tba).execute(target, 0, data, 0);
    }
}
