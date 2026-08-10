// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import {CollectionVaultLP} from "./CollectionVaultLP.sol";

/// @dev Minimal interface for PR1's `WeightModule` signal calls
/// (`contracts/energy/IWeightModule.sol`), inlined for the same reason.
interface IWeightModuleSignals {
    function noteFee(address vault, uint256 amountWei) external;
    function noteMintPressure(address vault, int256 netDeltaWei) external;
    function noteDepth(address vault, uint256 reserveWethWei) external;
    function noteVolume(address vault, uint256 feeDerivedVolumeWei) external;
}

/**
 * ============================================================================
 *  CollectionVault — factory-deployed, one per collection, implementing
 *  DESIGN-N-VAULT-FACTORY-AND-VALUE-ACCRUAL-2026-08-06.md section 7.2.
 *
 *  SCOPE OF THIS PASS: section 7.2's two mandatory fee-routing streams and the
 *  push-then-opportunistic-reconcile mechanism. Explicitly NOT built here:
 *  §7.10 (dedicated pool), §7.3 (dividend hybrid), §7.5 (continuous weight
 *  curve), §7.6 (generalized vesting), §7.7 (buyback).
 *
 *  PATTERN PROVENANCE — mirrors MarketplankVaultV3.sol (this repo) exactly
 *  where that pattern applies:
 *    - fee ceilings (MAX_MINT_FEE_WEI / MAX_REDEEM_FEE_WEI / MAX_SWAP_FEE_BPS)
 *      are copied VERBATIM (same values), see MarketplankVaultV3.sol:176-179.
 *    - immutable-constructor-param style, MarketplankVaultV3.sol:151-159.
 *    - accruedFees / withdrawFees() pull pattern, MarketplankVaultV3.sol:638-642.
 *
 *  DEVIATION FROM V3, DELIBERATE: V3's fees and pool are ETH-denominated. This
 *  vault's fees and pool are denominated in an ERC-20 `paymentToken` instead.
 *  This is required by the push-then-reconcile mechanism itself: the Diamond's
 *  existing `syncConstituentBalance`/`reconcile` machinery (IndexBootstrapFacet)
 *  only ever credits a constituent's reserve from an ERC-20 balance delta —
 *  there is no native-ETH constituent type in the Diamond today. Routing the
 *  sink cut as a plain ERC-20 transfer to the Diamond's own address is what
 *  makes this mandatory-routing mechanism land as a directly, permissionlessly
 *  reconcilable surplus rather than stranded, unaccounted ETH. `paymentToken`
 *  is expected to be a token the Diamond already tracks as a constituent (e.g.
 *  WETH), so a sweep instantly becomes redeemable NAV.
 *
 *  MANDATORY ROUTING, PRECISELY (design doc §7.2)
 *  ------------------------------------------------
 *  Stream A — mint/redeem fees. Artist-selectable split between the vault's
 *  own treasury and the upstream sink, FLOOR 810 bps (8.1%) to the sink,
 *  ceiling `CEIL_SINK_SPLIT_BPS` (protocol-wide bound, same bounded-range
 *  shape as IndexFacetBase.CEIL_ECOSYSTEM_SPLIT_BPS). Changeable ONLY via the
 *  same timelocked queue/execute pair as the treasury address.
 *
 *  Stream B — swap fees, default 100 bps (== MAX_SWAP_FEE_BPS, already-vetted
 *  ceiling, reused verbatim, not a new risk parameter). Split exactly 50/50
 *  between the pool's own reserve (fee-compounding, deepens local liquidity)
 *  and the sink. This 50/50 split is `SWAP_SINK_SPLIT_BPS`, a PROTOCOL-WIDE
 *  CONSTANT baked into every factory vault at construction — never
 *  creator-settable, matching the "mandatory routing fraction" requirement.
 *
 *  PUSH-THEN-OPPORTUNISTIC-RECONCILE
 *  -----------------------------------
 *  Every sink cut is pushed with a PLAIN `IERC20.transfer` to `upstreamSink`,
 *  atomically, in the same transaction as the triggering fee event. A plain
 *  ERC-20 transfer executes no receiver code, so it cannot revert this
 *  vault's own transaction even if the sink side has a problem — the same
 *  isolation MarketplankVaultV3 already guarantees today, extended across
 *  the vault/index boundary. This vault NEVER calls into the index's logic.
 * ============================================================================
 */
contract CollectionVault is ERC20, ReentrancyGuard, IERC721Receiver {
    using SafeERC20 for IERC20;

    uint256 public constant VAULT_VERSION = 1;

    IERC721 public immutable collection;
    IERC20 public immutable paymentToken;

    /// @notice Flat fees, fixed forever at deployment. Same ceilings as
    /// MarketplankVaultV3.sol:176-179, verbatim.
    uint256 public immutable mintFeeWei;
    uint256 public immutable redeemFeeWei;
    /// @notice AMM swap fee in bps. Default 100 == MAX_SWAP_FEE_BPS.
    uint256 public immutable swapFeeBps;

    /// @notice The Diamond's own address (or a designated collection point).
    /// Immutable: set once at construction, never a live cross-contract call
    /// target on the hot path — see header.
    address public immutable upstreamSink;

    // ── PHASE 2: the predicate (DESIGN-HONEST-INDEX-2026-08-09 §2) ─────────
    //
    // `1 NFT -> 1e18 S` is a CLAIM ABOUT FUNGIBILITY. Audit C-5 measured what
    // happens when the claim is false and nothing enforces it: 0.02 ETH of
    // flat fees converts a 1 ETH NFT into a 3 ETH one, in one transaction,
    // with no AMM and no flash loan, because `deposit` accepts ANY tokenId and
    // `redeem` hands out ANY held tokenId for the same 1e18 S.
    //
    // WE DO NOT PRICE THE OPTION — WE REMOVE IT. The alternative (an NFTX-v3
    // style dwell-decaying redeem premium) is the single most bug-prone
    // surface in NFTX's history: Spearbit's v3 core audit found THREE
    // Critical/High issues in that one mechanism (C-2/C-6 depositor-slot theft
    // via a same-tokenId round trip, H-3 `removeLiquidity` applying no premium
    // bound at all) and signed off only conditionally — "whether it be set too
    // lax the stealing within it is still possible". Charging zero premium
    // structurally immunises us against that entire family. Adopting one
    // imports it. So instead we make the fungibility claim TRUE: a vault is
    // `(collection, predicate)`, and junk-for-treasure extraction requires
    // intra-vault variance which the predicate collapses.
    //
    // IMMUTABILITY IS THE WHOLE SECURITY ARGUMENT. There is deliberately NO
    // setter for this value, and there never may be one. A mutable predicate
    // lets a vault owner attract deposits against a tight, high-value band and
    // then widen it to admit floor junk — which is a rug wearing a parameter's
    // clothing, and strictly worse than the C-5 it would claim to fix, because
    // it is unilateral rather than merely open. `immutable` puts that
    // guarantee in the bytecode, not in a policy.
    //
    // `eligibilityRoot == bytes32(0)` MEANS OPEN — ANY tokenId of the
    // collection is eligible, exactly the pre-Phase-2 behaviour. This is kept
    // deliberately and named plainly rather than hidden: an open vault is
    // EXACTLY the vault that gets sniped, and C-5 is its live, priced risk. We
    // permit it because that failure is honest and locally contained, which is
    // the design's §2 claim in full: a vault with a sloppy predicate gets
    // sniped, so its `S` depreciates, so its LPs leave, so its depth falls, so
    // its weight falls, so it stops receiving energy. Nothing about that
    // reaches any OTHER vault or the index, whose exposure to any one vault is
    // capped by realizable exit capacity regardless (§1.2/§3.3). Fungibility
    // becomes a market-priced property instead of a hidden liability — which
    // is the only reason it is safe to leave the door open at all.
    //
    // LEAF ENCODING: `keccak256(bytes.concat(keccak256(abi.encode(tokenId))))`
    // — the standard OpenZeppelin double-hashed leaf. The second hash is not
    // decoration: it makes a leaf preimage 64 bytes long and therefore
    // impossible to confuse with an internal node, which is the classic
    // second-preimage forgery against a naive single-hashed merkle tree.
    // Verification is `MerkleProof.verify` (sorted-pair), already a dependency.
    bytes32 public immutable eligibilityRoot;

    /// @notice PROTOCOL-WIDE constant: 50% of every swap fee routes to the
    /// sink. Not creator-settable, not governance-settable per-vault.
    uint256 public constant SWAP_SINK_SPLIT_BPS = 5_000;

    /// @notice CORRECTED per DESIGN-CAKE-EAT-IT-SHARE-ATOM-2026-08-08.md §2/§4
    /// (supersedes the PR4 dual vToken+xToken design): 25% of every Stream A
    /// (mint/redeem) fee is carved out BEFORE the existing Stream A
    /// sink/treasury split and donated DIRECTLY into this vault's own
    /// `paymentReserve` — raising `convertToAssets` for every `S` holder
    /// automatically, with no separate stake contract or second token. The
    /// existing Stream A split math (`mintRedeemSinkBps`, `FLOOR_SINK_SPLIT_BPS`) is
    /// UNCHANGED — it now simply operates on the post-carve-out residual
    /// instead of the gross fee. Stream B (swap fees) is untouched by this
    /// carve-out; it keeps its own existing 50/50 split exactly as shipped.
    /// PROTOCOL-WIDE constant, not creator-settable, matching
    /// `SWAP_SINK_SPLIT_BPS`'s own shape.
    uint256 public constant XTOKEN_COMPOUND_BPS = 2_500;

    uint256 private constant BPS_DENOMINATOR = 10_000;
    uint256 private constant SHARE_UNIT = 1e18;

    /// @dev Wei fee ceilings — verbatim from MarketplankVaultV3.
    uint256 private constant MAX_MINT_FEE_WEI = 0.05 ether;
    uint256 private constant MAX_REDEEM_FEE_WEI = 0.05 ether;
    uint256 private constant MAX_SWAP_FEE_BPS = 100;

    /// @notice Floor: no path, artist or governance, can route less than 8.1%
    /// of Stream A to the sink.
    uint256 public constant FLOOR_SINK_SPLIT_BPS = 810;
    /// @notice Ceiling on Stream A's sink split — same bounded-range shape as
    /// IndexFacetBase.CEIL_ECOSYSTEM_SPLIT_BPS (3_000 there); kept local here
    /// since this is a per-vault-family bound, not a diamond-wide one.
    uint256 public constant CEIL_SINK_SPLIT_BPS = 3_000;

    /// @notice Same timelock delay for every mutation this vault allows.
    uint256 public immutable timelockDelay;

    /// @notice The ONLY mutable address. Starts at the value chosen at
    /// construction; changeable only through queueTreasury/executeTreasury.
    address public treasury;
    /// @notice Stream A's current sink split (bps). Chosen once at
    /// construction (>= floor, <= ceiling), thereafter only through the
    /// identical timelock as treasury.
    uint256 public mintRedeemSinkBps;

    struct Queued {
        uint256 value;
        uint64 eta;
        bool pending;
    }
    Queued public queuedTreasury;
    Queued public queuedMintRedeemSinkBps;

    /// @notice PR1: this vault's `WeightModule`, notified of mint, redeem,
    /// swap, and depth signals so the L2 index's InventoryBuyAdapter has real
    /// activity to weight against. Set-once-only, guarded by `treasury` and
    /// an `AlreadySet` revert (WeightModule is a protocol-wide singleton
    /// deployed independently of any one vault).
    address public weightModule;

    uint256[] private heldTokenIds;
    mapping(uint256 => uint256) private heldTokenIndex;

    uint256 public paymentReserve;
    uint256 public shareReserve;
    bool public poolOpen;
    uint256 private constant MIN_INITIAL_LIQUIDITY = 1e3;

    /// @notice DESIGN-COLLECTION-VAULT-NATIVE-LP-AND-ZAP-MINT-2026-08-08.md §3.1:
    /// real, permissionless community liquidity ADDITIVE to the constant-
    /// product pool above. `paymentReserve`/`shareReserve` remain the ONE
    /// source of truth `buyShares`/`sellShares` price against — this layer
    /// only changes WHO can deposit/withdraw into those same two numbers.
    /// Deployed once, lazily, at `openPool()`.
    CollectionVaultLP public lpToken;

    /// @notice Same dead address this repo already uses for
    /// `IndexFacetBase.SEED_LOCK_ADDR` / the buyback lock — nobody holds its
    /// key. The ENTIRE genesis LP mint (100% of the pool at the moment
    /// `openPool()` is called, i.e. the treasury's seeded floor) is minted
    /// directly here and nowhere else, so there is no window in which
    /// `treasury` ever custodies a withdrawable LP position.
    address public constant LP_LOCK_ADDR = 0x000000000000000000000000000000000000dEaD;

    // ── PHASE 4: donation vesting + LP dwell (audit C-3) ──────────────────
    //
    // THE BUG. `_compoundXToken` credited `paymentReserve += wethIn`
    // INSTANTLY and UNVESTED, while `addLiquidity`/`removeLiquidity` charged
    // no fee and imposed no lock. The round trip was provably lossless, so an
    // attacker added liquidity immediately before a donation and removed
    // immediately after: `AuditJitLp.poc.test.ts` measured EXACTLY 5.0 of a
    // 10.0 donation, share delta 0, one block, zero risk. The index side of
    // this same codebase already vests routed value over 300 blocks
    // (`IndexFacetBase._addReserveVest`); the lesson had been learned in one
    // place and not the other.
    //
    // WHY BOTH HALVES, NOT ONE. Spearbit's NFTX v3 core audit rates this exact
    // attack Critical (C-8) and High (H-1), and NFTX shipped the bug class
    // THREE times across two versions (C4-2021-05 H-4 -> C4-2021-12
    // M-07/M-13 -> Spearbit H-1). The fix that finally held required a
    // flash-loan-resistant fee AND a timelock — not one or the other. The
    // reason is structural, and it is worth stating because it dictates the
    // shape below:
    //   * A vest alone bounds the capture but does not zero it. A vest makes
    //     the donation arrive as a ramp; an attacker who is willing to dwell
    //     merely collects the slice that ramped in during their dwell. Free
    //     entry and exit means that slice is pure profit at any dwell > 0.
    //   * A dwell lock alone kills the ATOMIC attack but not the multi-block
    //     one: with an unvested step credit, an attacker who happens to be
    //     inside the lock window when a donation lands still takes their full
    //     pro-rata cut of the whole step for free.
    // Together they compose into a bound rather than a speed bump: the dwell
    // forces the attacker to hold for `LP_MIN_DWELL_BLOCKS`, the vest caps
    // what can possibly have arrived in that time at
    // `dwell / DONATION_VEST_BLOCKS` of the donation, and the exit fee — which
    // is still near its maximum at the minimum dwell, by construction, because
    // both decay over the SAME window — charges more than that slice is worth.
    //
    // WHY A DRIP AND NOT AN OVERLAY. The index vests by keeping a SEPARATE
    // `unvested` ledger and subtracting it at read time (`_reserveNetOfVest`).
    // That is correct for `c.reserve`, which is a passive balance. It is the
    // WRONG shape for an AMM reserve, and audit H-1 is the proof: the index's
    // own overlay was bypassed outright because `redeemSingleAsset` simply
    // forgot to apply `_reserveNetOfVest`, and 18.18 tokens of unvested value
    // walked out the neighbouring door. An overlay is only as strong as the
    // completeness of its call-site audit, and `paymentReserve` is read at
    // NINE sites here (both swap legs, both quote legs, both liquidity legs,
    // `convertToAssets`, `noteDepth`, `openPool`) — every one of which would
    // have to remember, forever, including in code not yet written, on a
    // contract with no upgrade path.
    //
    // So instead the donation is held OUTSIDE the AMM in `pendingDonation` and
    // MOVED INTO `paymentReserve` block by block. `paymentReserve` stays the
    // single source of truth for pricing, payout and LP claim alike, so every
    // reader is correct by construction and no future call site can bypass
    // anything. The state-changing entry points call `_drip()` first; the view
    // functions add `_drippable()` instead, which is the same number by
    // construction (after `_drip()`, `_drippable()` is zero), so a quote and
    // the trade it quotes cannot disagree.
    //
    // HONEST CONSEQUENCES, STATED RATHER THAN GLOSSED:
    //  1. `k = paymentReserve * shareReserve` now rises as a RAMP rather than
    //     a STEP. Nothing about constant-product breaks — `k` was never
    //     invariant here anyway, since every swap fee and every donation
    //     already grew it — but the price of `S` improves gradually instead of
    //     instantly. That gradualness IS the mechanism.
    //  2. Between donation and full drip, the vault's `paymentToken` balance
    //     exceeds `paymentReserve`. That is a solvency SURPLUS, never a
    //     deficit: every payout is computed from `paymentReserve`, so the
    //     contract can always honour it. The surplus is exactly
    //     `pendingDonation + accruedFees`, both of which are tracked.
    //  3. A donation is therefore capturable by whoever holds `S`/LP DURING
    //     the drip window rather than by whoever holds it in the donation's
    //     own block. Rewarding presence-over-time instead of presence-at-an-
    //     instant is the entire point: it is the property a flash loan cannot
    //     buy.
    //  4. `pendingDonation` is never refundable to the donor and never
    //     withdrawable by anyone — it can only ever move into
    //     `paymentReserve`. No new admin surface is created.
    /// @notice Mirrors `IndexFacetBase.STREAM_VEST_BLOCKS` at the same value,
    /// deliberately: a fee donation into a vault pool and a routed credit into
    /// a constituent reserve are the same economic event and should not have
    /// two different, independently-wrong windows.
    uint256 public constant DONATION_VEST_BLOCKS = 300;

    /// @notice Minimum blocks LP must be held before `removeLiquidity`. This
    /// is the TIMELOCK half. It makes the atomic add->donate->remove sandwich
    /// not merely unprofitable but IMPOSSIBLE — a hard revert, which is the
    /// only guarantee that does not depend on getting an economic parameter
    /// right. 8 blocks is ~96s on mainnet: long enough that the attacker holds
    /// real inventory risk across blocks they do not control, short enough
    /// that it is not a meaningful tax on a genuine liquidity provider.
    uint256 internal constant LP_MIN_DWELL_BLOCKS = 8;

    /// @notice Exit fee at zero dwell, decaying LINEARLY to zero over
    /// `DONATION_VEST_BLOCKS`. This is the FLASH-LOAN-RESISTANT-FEE half.
    /// Deliberately decayed over the SAME window as the donation vest so the
    /// two are algebraically coupled: an LP who has been present long enough
    /// for a donation to have fully arrived pays exactly nothing to leave,
    /// while an LP who arrived at the last possible moment pays essentially
    /// the full fee on their WHOLE position to collect a
    /// `dwell/300` sliver of one donation. 100 bps == the vault's own
    /// already-vetted `MAX_SWAP_FEE_BPS`; not a new risk parameter.
    uint256 internal constant LP_EXIT_FEE_MAX_BPS = 100;

    /// @notice Payment-token value donated to this pool but not yet recognised
    /// into `paymentReserve`. Held by this contract; can only move INTO
    /// `paymentReserve`.
    uint256 public pendingDonation;
    /// @dev Block the current drip window was last committed at.
    uint64 private dripLast;
    /// @dev Block the current drip window completes at. Re-armed by every new
    /// donation, exactly as `IndexFacetBase._addVest` re-arms its own — a
    /// fresh donation restarts the clock on the whole pending balance. This is
    /// the conservative direction (it slows recognition, never accelerates it)
    /// and it keeps the accounting to three slots instead of a queue.
    uint64 private dripEnd;

    /// @notice Block at which each account last RECEIVED LP. Written on mint
    /// and on every transfer-in via `onLpReceived`, so the dwell clock cannot
    /// be laundered by moving LP to a fresh address before removing — the
    /// obvious defeat of a naive per-caller lock, given `CollectionVaultLP` is
    /// a freely transferable ERC-20.
    mapping(address => uint256) public lpEntryBlock;

    event DonationVested(uint256 amount, uint256 pendingTotal, uint64 endBlock);
    event DonationDripped(uint256 amount, uint256 paymentReserveAfter);
    event LpExitFeeCharged(address indexed provider, uint256 feeBps, uint256 paymentFee, uint256 shareFee);

    error LpDwellNotMet();
    error NotLpToken();
    error NotEligible();
    error ProofRequired();

    event GenesisFloorLocked(uint256 lpAmount, uint256 paymentReserve, uint256 shareReserve);
    event LiquidityAdded(address indexed provider, uint256 paymentIn, uint256 sharesIn, uint256 lpOut);
    event LiquidityRemoved(address indexed provider, uint256 lpIn, uint256 paymentOut, uint256 sharesOut);

    error PoolNotYetOpenForLp();
    error ZeroLiquidityInput();
    error InsufficientLpOutput();
    error InsufficientLpRemoveOutput();

    /// @notice ETH... no: paymentToken fees awaiting a withdrawFees() pull,
    /// exactly MarketplankVaultV3's accruedFees/withdrawFees pattern.
    uint256 public accruedFees;

    event Deposited(address indexed from, uint256 indexed tokenId, uint256 sinkCut, uint256 treasuryCut);
    event Redeemed(address indexed to, uint256 indexed tokenId, uint256 sinkCut, uint256 treasuryCut);
    event Bought(address indexed buyer, uint256 amountIn, uint256 sharesOut, uint256 sinkCut);
    event Sold(address indexed seller, uint256 sharesIn, uint256 amountOut, uint256 sinkCut);
    event PoolOpened(uint256 paymentReserve, uint256 shareReserve);
    event FeesWithdrawn(uint256 amount);
    event TreasuryQueued(address next, uint64 eta);
    event TreasuryApplied(address previous, address next);
    event MintRedeemSinkBpsQueued(uint256 value, uint64 eta);
    event MintRedeemSinkBpsApplied(uint256 previous, uint256 value);
    event SweptToSink(uint256 amount);
    event WeightModuleSet(address indexed module);
    event XTokenCompounded(uint256 wethIn, uint256 paymentReserveAfter);
    event XTokenCompoundSkipped(uint256 wethIn);
    event ReservesDonated(address indexed donor, uint256 wethIn);

    error FeeTooHigh();
    error IncorrectFee();
    error TokenNotHeld();
    error InsufficientOutput();
    error NotTreasury();
    error EmptyVault();
    error AlreadyHeld();
    error PoolNotOpen();
    error PoolAlreadyOpen();
    error NothingToSeed();
    error InsufficientLiquidity();
    error NoFees();
    error SplitOutOfRange();
    error NothingQueued();
    error TimelockNotElapsed();
    error ZeroAddress();
    error AlreadySet();
    error NothingToDonate();

    /**
     * @notice Every construction-time parameter, as ONE struct.
     *
     * WHY A STRUCT RATHER THAN LOOSE ARGUMENTS: adding `eligibilityRoot` as a
     * twelfth loose constructor parameter pushed solc 0.8.24's LEGACY ABI
     * DECODER over its stack limit ("Variable headStart is 1 slot too deep")
     * — the identical wall `hardhat.config.ts` documents for `Diamond` and
     * `IndexDeployer`. Their escape was a per-file `viaIR` override; this
     * one's is cheaper and does not fork the compiler settings for a whole
     * file: a single struct argument is decoded into MEMORY, so exactly one
     * pointer lives on the stack instead of twelve values. Bytecode for every
     * other contract in the repo is untouched, which a compiler-setting
     * override cannot claim.
     *
     * It also makes the factory's `abi.encode` call site self-documenting —
     * eleven positional values, two of which are addresses and four of which
     * are `uint256`, is exactly the shape in which a silent argument
     * transposition ships to an immutable contract.
     */
    struct VaultConfig {
        IERC721 collection;
        IERC20 paymentToken;
        string name;
        string symbol;
        uint256 mintFeeWei;
        uint256 redeemFeeWei;
        uint256 swapFeeBps;
        address upstreamSink;
        address treasury;
        uint256 mintRedeemSinkBps;
        uint256 timelockDelay;
        bytes32 eligibilityRoot;
    }

    constructor(VaultConfig memory cfg) ERC20(cfg.name, cfg.symbol) {
        if (
            cfg.mintFeeWei > MAX_MINT_FEE_WEI || cfg.redeemFeeWei > MAX_REDEEM_FEE_WEI
                || cfg.swapFeeBps > MAX_SWAP_FEE_BPS
        ) {
            revert FeeTooHigh();
        }
        if (cfg.treasury == address(0) || cfg.upstreamSink == address(0)) revert ZeroAddress();
        if (cfg.mintRedeemSinkBps < FLOOR_SINK_SPLIT_BPS || cfg.mintRedeemSinkBps > CEIL_SINK_SPLIT_BPS) {
            revert SplitOutOfRange();
        }
        collection = cfg.collection;
        paymentToken = cfg.paymentToken;
        mintFeeWei = cfg.mintFeeWei;
        redeemFeeWei = cfg.redeemFeeWei;
        swapFeeBps = cfg.swapFeeBps;
        upstreamSink = cfg.upstreamSink;
        treasury = cfg.treasury;
        mintRedeemSinkBps = cfg.mintRedeemSinkBps;
        timelockDelay = cfg.timelockDelay;
        // No validation, and no setter anywhere in this file: any 32 bytes is
        // a legal commitment, and `bytes32(0)` is the explicit "open vault"
        // sentinel documented at the declaration. See that comment for why the
        // absence of a setter is the entire security property.
        eligibilityRoot = cfg.eligibilityRoot;
    }

    // ── Deposit / redeem, Stream A ─────────────────────────────────────────

    /// @notice Deposit an eligible `tokenId` and mint exactly 1e18 `S`.
    /// @dev Convenience entry point for OPEN vaults (`eligibilityRoot == 0`).
    /// On a predicate vault this reverts with `ProofRequired` — deliberately a
    /// distinct error from `NotEligible`, so an integrator that forgot to
    /// supply a proof gets a different diagnosis from one whose token is
    /// genuinely out of band.
    function deposit(uint256 tokenId) external nonReentrant {
        if (eligibilityRoot != bytes32(0)) revert ProofRequired();
        _deposit(tokenId);
    }

    /// @notice Deposit `tokenId` against this vault's immutable predicate.
    /// @param proof merkle proof that `tokenId` is in `eligibilityRoot`'s set.
    /// Ignored (and may be empty) when the vault is open.
    function depositWithProof(uint256 tokenId, bytes32[] calldata proof) external nonReentrant {
        bytes32 root = eligibilityRoot;
        if (root != bytes32(0)) {
            // Double-hashed leaf: see `eligibilityRoot`'s declaration for why
            // the inner hash is load-bearing rather than cosmetic.
            bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(tokenId))));
            if (!MerkleProof.verify(proof, root, leaf)) revert NotEligible();
        }
        _deposit(tokenId);
    }

    /// @notice Whether `tokenId` may be deposited, given `proof`. Pure
    /// predicate check with no side effects, so a frontend can refuse a
    /// doomed transaction instead of burning the user's gas on a revert.
    function isEligible(uint256 tokenId, bytes32[] calldata proof) external view returns (bool) {
        bytes32 root = eligibilityRoot;
        if (root == bytes32(0)) return true;
        return MerkleProof.verify(proof, root, keccak256(bytes.concat(keccak256(abi.encode(tokenId)))));
    }

    function _deposit(uint256 tokenId) private {
        _pullFee(mintFeeWei);
        collection.safeTransferFrom(msg.sender, address(this), tokenId);
        _addHeldToken(tokenId);
        _mint(msg.sender, SHARE_UNIT);
        (uint256 sinkCut, uint256 treasuryCut) = _routeStreamA(mintFeeWei);
        _noteMintRedeemSignals(sinkCut, int256(sinkCut));
        emit Deposited(msg.sender, tokenId, sinkCut, treasuryCut);
    }

    /// @notice Redeem exactly 1e18 `S` for any held `tokenId` of the caller's
    /// choosing. Caller choice is SAFE here, without a premium, without
    /// randomness and without depositor bookkeeping, precisely because
    /// `eligibilityRoot` collapsed the intra-vault variance that made choice
    /// worth anything — see that declaration. On an OPEN vault this is the
    /// C-5 free option, priced and accepted, and locally contained.
    function redeem(uint256 tokenId) external nonReentrant {
        if (heldTokenIndex[tokenId] == 0) revert TokenNotHeld();
        _pullFee(redeemFeeWei);
        _burn(msg.sender, SHARE_UNIT);
        _removeHeldToken(tokenId);
        collection.safeTransferFrom(address(this), msg.sender, tokenId);
        (uint256 sinkCut, uint256 treasuryCut) = _routeStreamA(redeemFeeWei);
        _noteMintRedeemSignals(sinkCut, -int256(sinkCut));
        emit Redeemed(msg.sender, tokenId, sinkCut, treasuryCut);
    }

    /// @dev Pulls exactly `fee` of paymentToken from the caller into this
    /// vault, using the observed-balance-delta discipline (never trusts the
    /// nominal amount).
    function _pullFee(uint256 fee) private {
        if (fee == 0) return;
        uint256 before = paymentToken.balanceOf(address(this));
        paymentToken.safeTransferFrom(msg.sender, address(this), fee);
        uint256 credited = paymentToken.balanceOf(address(this)) - before;
        if (credited != fee) revert IncorrectFee();
    }

    /// @dev Pre-split carve-out (ONESHOT §4.4, corrected per
    /// DESIGN-CAKE-EAT-IT-SHARE-ATOM-2026-08-08.md §2/§4): `XTOKEN_COMPOUND_BPS`
    /// of `fee` is donated into this vault's own `paymentReserve` FIRST; the
    /// UNCHANGED Stream A
    /// split (sink vs. treasury, same `mintRedeemSinkBps` math as always)
    /// then runs on the residual only. Conservation: `compoundCut + sinkCut +
    /// treasuryCut == fee` exactly (see `_compoundXToken`'s own fallback —
    /// nothing is ever stranded, only redirected to `accruedFees` if the
    /// pool isn't open yet).
    function _routeStreamA(uint256 fee) private returns (uint256 sinkCut, uint256 treasuryCut) {
        if (fee == 0) return (0, 0);
        uint256 compoundCut = (fee * XTOKEN_COMPOUND_BPS) / BPS_DENOMINATOR;
        uint256 residual = fee - compoundCut;
        _compoundXToken(compoundCut);

        sinkCut = (residual * mintRedeemSinkBps) / BPS_DENOMINATOR;
        treasuryCut = residual - sinkCut;
        if (sinkCut > 0) {
            paymentToken.safeTransfer(upstreamSink, sinkCut);
            emit SweptToSink(sinkCut);
        }
        accruedFees += treasuryCut;
    }

    /// @dev CORRECTED MODEL (DESIGN-CAKE-EAT-IT-SHARE-ATOM-2026-08-08.md §2/§4/
    /// §10 — supersedes the PR4 dual vToken+xToken design): `wethIn` of
    /// already-collected fee revenue is credited DIRECTLY into this vault's
    /// own `paymentReserve`, with NO shares bought and NO shares removed from
    /// `shareReserve`. This is exactly `donateReserves`'s own single-sided,
    /// receipt-free mechanism (see that function's header for the full
    /// rationale), reused here for the fee path instead of a third-party
    /// donor: `k = paymentReserve * shareReserve` rises, so the AMM price of
    /// every existing S holder's share (`paymentReserve / shareReserve`,
    /// exposed via `convertToAssets` below) rises too — automatically, for
    /// every holder, with zero staking step and zero second token. Contrast
    /// with the deleted PR4 `InventoryStake` path, which bought shares OUT of
    /// `shareReserve` and diverted them to a separate xToken wrapper: that
    /// design routed compounding only to opted-in stakers; this one routes it
    /// to `S` itself. Falls back to ordinary `accruedFees` only if the pool
    /// isn't open yet (nothing is ever stranded).
    ///
    /// PHASE 4 / AUDIT C-3: the credit is no longer INSTANT. It is handed to
    /// `_addDonationVest`, which parks it in `pendingDonation` and drips it
    /// into `paymentReserve` over `DONATION_VEST_BLOCKS`. Everything the
    /// paragraph above says about `k` rising and every holder benefiting
    /// remains exactly true — it now happens as a ramp rather than a step, so
    /// that the value accrues to whoever is PRESENT OVER THE WINDOW rather
    /// than to whoever is present in one block, which is the only version of
    /// the property a flash loan cannot buy.
    function _compoundXToken(uint256 wethIn) private {
        if (wethIn == 0) return;
        if (!poolOpen || shareReserve == 0 || paymentReserve == 0) {
            accruedFees += wethIn;
            emit XTokenCompoundSkipped(wethIn);
            return;
        }
        _addDonationVest(wethIn);
        emit XTokenCompounded(wethIn, paymentReserve);
    }

    // ── Donation vesting: the drip (audit C-3, half 1) ─────────────────────

    /// @dev How much of `pendingDonation` has become recognisable since the
    /// window was last committed. Pure function of storage and `block.number`,
    /// structurally the complement of `IndexFacetBase._reserveUnvestedOf`
    /// (that one reports what is still LOCKED; this one reports what is now
    /// RELEASED, because here the released part must actually be moved).
    function _drippable() private view returns (uint256) {
        uint256 p = pendingDonation;
        if (p == 0) return 0;
        uint64 end_ = dripEnd;
        if (block.number >= end_) return p;
        uint64 last_ = dripLast;
        // `last_ < end_` always holds: `_addDonationVest` writes them together
        // as (n, n + DONATION_VEST_BLOCKS) with DONATION_VEST_BLOCKS > 0.
        // Same-block re-entry therefore drips exactly zero, which is the
        // atomic-sandwich case.
        return (p * (block.number - last_)) / (end_ - last_);
    }

    /// @dev Commit the elapsed portion into the live AMM reserve. Called at
    /// the head of EVERY state-changing entry point that reads or writes
    /// `paymentReserve`, so `paymentReserve` is always fully up to date by the
    /// time any pricing math touches it.
    function _drip() private {
        uint256 d = _drippable();
        if (d == 0) return;
        pendingDonation -= d;
        dripLast = uint64(block.number);
        paymentReserve += d;
        emit DonationDripped(d, paymentReserve);
    }

    /// @dev Park `amount` and re-arm the window over the whole pending
    /// balance. Commits the elapsed portion first so no already-earned value
    /// is retroactively re-locked by a later donation.
    function _addDonationVest(uint256 amount) private {
        if (amount == 0) return;
        _drip();
        pendingDonation += amount;
        dripLast = uint64(block.number);
        dripEnd = uint64(block.number + DONATION_VEST_BLOCKS);
        emit DonationVested(amount, pendingDonation, dripEnd);
    }

    /// @dev `paymentReserve` as every VIEW must see it: including the portion
    /// that a state-changing call in this same block would commit first. Views
    /// and trades therefore agree exactly, so a quote can never be off by the
    /// drip.
    function _pr() private view returns (uint256) {
        return paymentReserve + _drippable();
    }

    /// @notice `paymentReserve` as the next state-changing call in this block
    /// will see it — i.e. including the already-elapsed drip. THIS, not the
    /// raw `paymentReserve` storage slot, is the number an integrator should
    /// price against; the raw slot lags by up to one call.
    function effectivePaymentReserve() external view returns (uint256) {
        return _pr();
    }


    /// @notice DESIGN-CAKE-EAT-IT-SHARE-ATOM-2026-08-08.md §2.3: the
    /// `convertToAssets`-equivalent for this vault's own share `S`, priced off
    /// this vault's own constant-product reserves (no oracle, no second
    /// token). Returns how much `paymentToken` `shares` of `S` are currently
    /// worth via the AMM — genuinely rises as `_compoundXToken` donates fee
    /// revenue into `paymentReserve`, for every `S` holder automatically.
    /// Returns 0 before the pool is open (no reserve to price against yet).
    function convertToAssets(uint256 shares) public view returns (uint256) {
        if (shareReserve == 0) return 0;
        return (shares * _pr()) / shareReserve;
    }

    // ── Realizable value (DESIGN-HONEST-INDEX-2026-08-09 §1.2/§1.3) ────────
    //
    // THE honest-accounting primitive, and the reason this protocol does not
    // repeat NFTX v1 "D2".
    //
    // `convertToAssets` above reports the SPOT mark, `shares * paymentReserve
    // / shareReserve`. That is what a stake is worth only in the limit of an
    // infinitesimal exit. It systematically overstates what a real position
    // can actually realize, and the overstatement grows with position size:
    // selling `s` shares into a pool holding `y` realizes only `y/(y+s)` of
    // the spot mark, so a position the size of the pool's own share reserve
    // is worth exactly HALF its mark.
    //
    // Marking constituents at spot while promising redemption against them is
    // precisely the illusion that killed D2. Every SETTLEMENT price in this
    // system therefore quotes these functions, never `convertToAssets` — which
    // survives for display and for callers who genuinely want the spot mark.
    //
    // Both return 0 rather than reverting when the pool cannot trade, so a
    // caller can treat "no realizable value" as a number instead of an
    // exception. Both mirror `sellShares`/`buyShares` wei-for-wei, including
    // both fee legs; they assume `paymentToken` is not fee-on-transfer, which
    // is already an invariant of this vault (`_pullFee` reverts on mismatch).

    /// @notice The payment token `sellShares(sharesIn, 0)` would pay RIGHT
    /// NOW — impact-inclusive and fee-inclusive — without executing it.
    /// @dev Quoting the index's ENTIRE holding gives the conservative
    /// "liquidate everything" figure; quoting a redeemer's pro-rata slice
    /// gives what that specific exit can honestly realize.
    function quoteSellShares(uint256 sharesIn) public view returns (uint256 amountOut) {
        if (!poolOpen || shareReserve == 0 || paymentReserve == 0 || sharesIn == 0) return 0;
        uint256 grossOut = (sharesIn * _pr()) / (shareReserve + sharesIn);
        if (grossOut == 0) return 0;
        return grossOut - _swapFee(grossOut);
    }

    /// @notice The shares `buyShares(amountIn, 0)` would deliver right now.
    /// @dev Pricing a protocol buy through this makes an explicit impact
    /// guard unnecessary: the quote ALREADY contains the impact, so there is
    /// no separate threshold left to compute wrongly (see audit C-2, where a
    /// guard that compared against the constant-product output rather than
    /// the marginal price could never fire at any trade size).
    function quoteBuyShares(uint256 amountIn) public view returns (uint256 sharesOut) {
        if (!poolOpen || shareReserve == 0 || paymentReserve == 0 || amountIn == 0) return 0;
        uint256 inNet = amountIn - _swapFee(amountIn);
        return (inNet * shareReserve) / (_pr() + inNet);
    }

    /// @notice Realizable value of `sharesIn` as a fraction of its spot mark,
    /// in bps — the honest "how much of the displayed number is real?" ratio.
    /// 10000 means fully realizable; 5000 means the mark is double the truth.
    /// @dev Exit-capacity caps and the solvency tier of the fee waterfall are
    /// both expressed against this, so illiquidity is a measured quantity
    /// rather than an assumption.
    function realizableBps(uint256 sharesIn) external view returns (uint256) {
        uint256 mark = convertToAssets(sharesIn);
        if (mark == 0) return 0;
        return (quoteSellShares(sharesIn) * BPS_DENOMINATOR) / mark;
    }

    /// @dev Best-effort WeightModule signal push, deposit/redeem side. Wrapped
    /// in `try/catch` — exactly `DividendAdapter`'s own "never brick the hot
    /// path over a downstream, non-load-bearing signal" doctrine — so a
    /// misconfigured or not-yet-wired `weightModule` can NEVER revert a
    /// user's mint or redeem.
    function _noteMintRedeemSignals(uint256 matureFeeWei, int256 pressureWei) private {
        if (weightModule == address(0)) return;
        try IWeightModuleSignals(weightModule).noteFee(address(this), matureFeeWei) {} catch {}
        try IWeightModuleSignals(weightModule).noteMintPressure(address(this), pressureWei) {} catch {}
    }

    /// @dev Best-effort WeightModule signal push, swap side. Same try/catch
    /// doctrine as `_noteMintRedeemSignals`.
    ///
    /// PHASE 3 / AUDIT H-4 + H-6: `feeDerivedVolumeWei` is now the SINK CUT —
    /// the portion of the fee that irreversibly leaves this vault to
    /// `upstreamSink` — and NOT the gross notional (`credited`/`grossOut`)
    /// this used to pass, nor even the gross fee. Two independent reasons,
    /// both from the design's §3:
    ///   * §3.2 — the `IWeightModule` interface always DOCUMENTED "fee", and
    ///     the implementation measured notional. The doc was simply false, and
    ///     gross notional is free to manufacture: a self-trade round trip
    ///     generates unbounded notional at the cost of the spread alone.
    ///   * §3.1, the `R <= C` bound — weight may only be bought with value the
    ///     buyer cannot take back. The treasury cut returns to a
    ///     vault-chosen address and the compounded cut stays in this vault's
    ///     own pool; both are recoverable by the vault's operator, which is
    ///     exactly how audit H-4 bought 12.5% of all fee flow for ~0.004 WETH.
    ///     Only the sink cut is unrecoverable, so only the sink cut may count.
    ///     Faking the signal then costs precisely what it earns.
    /// `_noteMintRedeemSignals` was already passing `sinkCut` for `noteFee`;
    /// this makes the swap side consistent with it.
    function _noteSwapSignals(uint256 feeDerivedVolumeWei) private {
        if (weightModule == address(0)) return;
        try IWeightModuleSignals(weightModule).noteDepth(address(this), paymentReserve) {} catch {}
        try IWeightModuleSignals(weightModule).noteVolume(address(this), feeDerivedVolumeWei) {} catch {}
    }

    // ── Constant-product pool, Stream B ────────────────────────────────────

    function buyShares(uint256 amountIn, uint256 minSharesOut) external nonReentrant returns (uint256 sharesOut) {
        if (!poolOpen) revert PoolNotOpen();
        _drip();
        if (shareReserve == 0 || paymentReserve == 0) revert EmptyVault();
        if (amountIn == 0) revert InsufficientOutput();

        uint256 before = paymentToken.balanceOf(address(this));
        paymentToken.safeTransferFrom(msg.sender, address(this), amountIn);
        uint256 credited = paymentToken.balanceOf(address(this)) - before;

        // Full fee applied ONCE, on `credited`. Only the sink's half ever
        // leaves; the retained half is never subtracted from `netIn`, so it
        // stays in the vault and compounds into `paymentReserve` below.
        uint256 fee = _swapFee(credited);
        uint256 sinkCut = _swapSinkCut(fee);
        uint256 inNet = credited - fee; // single-discount, priced into the curve
        uint256 netIn = credited - sinkCut; // physically retained (>= inNet)

        sharesOut = (inNet * shareReserve) / (paymentReserve + inNet);
        if (sharesOut == 0 || sharesOut < minSharesOut) revert InsufficientOutput();

        paymentReserve += netIn;
        shareReserve -= sharesOut;
        _transfer(address(this), msg.sender, sharesOut);

        if (sinkCut > 0) {
            paymentToken.safeTransfer(upstreamSink, sinkCut);
            emit SweptToSink(sinkCut);
        }
        _noteSwapSignals(sinkCut);
        emit Bought(msg.sender, credited, sharesOut, sinkCut);
    }

    function sellShares(uint256 sharesIn, uint256 minAmountOut) external nonReentrant returns (uint256 amountOut) {
        if (!poolOpen) revert PoolNotOpen();
        _drip();
        if (shareReserve == 0 || paymentReserve == 0) revert EmptyVault();
        if (sharesIn == 0) revert InsufficientOutput();

        uint256 grossOut = (sharesIn * paymentReserve) / (shareReserve + sharesIn);
        if (grossOut == 0) revert InsufficientOutput();

        // Full fee applied ONCE, on `grossOut`. Only the sink's half ever
        // leaves; the retained half (fee - sinkCut) is simply never
        // subtracted from `paymentReserve`, so it compounds into the pool.
        uint256 fee = _swapFee(grossOut);
        uint256 sinkCut = _swapSinkCut(fee);
        amountOut = grossOut - fee; // single-discount
        if (amountOut < minAmountOut) revert InsufficientOutput();

        _transfer(msg.sender, address(this), sharesIn);
        shareReserve += sharesIn;
        paymentReserve -= (amountOut + sinkCut);

        paymentToken.safeTransfer(msg.sender, amountOut);
        if (sinkCut > 0) {
            paymentToken.safeTransfer(upstreamSink, sinkCut);
            emit SweptToSink(sinkCut);
        }
        _noteSwapSignals(sinkCut);
        emit Sold(msg.sender, sharesIn, amountOut, sinkCut);
    }

    /// @dev The FULL swap fee, applied exactly ONCE per trade: `amount *
    /// swapFeeBps / BPS`. Game-theory audit fix: buyShares/sellShares and
    /// their quote mirrors used to apply this fee twice — once folded into
    /// the constant-product pricing input/output, and again via
    /// `_swapFeeSinkCut` computed on an amount that had already been
    /// fee-discounted — compounding to an effective ~1.5x the documented
    /// rate. Both call sites now compute `fee` here ONCE and derive
    /// `sinkCut` from that SAME `fee`, never from a second independent
    /// `amount * swapFeeBps / BPS` on an already-adjusted base.
    function _swapFee(uint256 amount) private view returns (uint256) {
        return (amount * swapFeeBps) / BPS_DENOMINATOR;
    }

    /// @dev Exactly half of `_swapFee(amount)` (SWAP_SINK_SPLIT_BPS = 5000)
    /// — the portion that physically leaves to `upstreamSink`. The other
    /// half stays in the vault, embedded in the pool's own reserve (standard
    /// AMM fee-compounding): callers add back what they did NOT subtract for
    /// the sink, so the retained half is never separately transferred, just
    /// never removed.
    function _swapSinkCut(uint256 fee) private pure returns (uint256) {
        return (fee * SWAP_SINK_SPLIT_BPS) / BPS_DENOMINATOR;
    }

    // ── WeightModule wiring, set-once-only ──────────────────────────────────

    /// @notice Wire this vault's `WeightModule` (PR1, protocol-wide
    /// singleton). Callable once, ever, by `treasury`.
    function setWeightModule(address module_) external {
        if (msg.sender != treasury) revert NotTreasury();
        if (module_ == address(0)) revert ZeroAddress();
        if (weightModule != address(0)) revert AlreadySet();
        weightModule = module_;
        emit WeightModuleSet(module_);
    }

    // ── Bootstrap ──────────────────────────────────────────────────────────

    function seedLiquidity(uint256 amount) external nonReentrant {
        if (msg.sender != treasury) revert NotTreasury();
        if (poolOpen) revert PoolAlreadyOpen();
        paymentToken.safeTransferFrom(msg.sender, address(this), amount);
        paymentReserve += amount;
    }

    function seedShares(uint256 shares) external nonReentrant {
        if (msg.sender != treasury) revert NotTreasury();
        if (poolOpen) revert PoolAlreadyOpen();
        if (shares == 0) revert NothingToSeed();
        _transfer(msg.sender, address(this), shares);
        shareReserve += shares;
    }

    function openPool() external nonReentrant {
        if (msg.sender != treasury) revert NotTreasury();
        if (poolOpen) revert PoolAlreadyOpen();
        if (paymentReserve == 0 || shareReserve == 0) revert EmptyVault();
        if (paymentReserve < MIN_INITIAL_LIQUIDITY || shareReserve < MIN_INITIAL_LIQUIDITY) {
            revert InsufficientLiquidity();
        }
        poolOpen = true;
        emit PoolOpened(paymentReserve, shareReserve);

        // ── Native-LP genesis floor (DESIGN-COLLECTION-VAULT-NATIVE-LP-AND-
        // ZAP-MINT-2026-08-08.md §3.1, requirement 2): deploy this vault's LP
        // receipt and mint the ENTIRE genesis LP supply straight to
        // LP_LOCK_ADDR. This is simultaneously (a) the "permanently-locked
        // protocol floor" and (b) first-depositor/inflation-attack
        // protection on the LP token itself — every `addLiquidity` call after
        // this point prices against a nonzero, treasury-sized `lpToken`
        // supply that no depositor (community or attacker) ever controlled
        // the creation of.
        // Fixed metadata, `vault` immutable as the real identity — see
        // `CollectionVaultLP`'s constructor for the EIP-170 arithmetic that
        // forced this and why it costs nothing.
        lpToken = new CollectionVaultLP(address(this));
        uint256 genesisLp = _sqrt(paymentReserve * shareReserve);
        lpToken.mint(LP_LOCK_ADDR, genesisLp);
        emit GenesisFloorLocked(genesisLp, paymentReserve, shareReserve);
    }

    /// @notice Permissionless, balanced two-sided liquidity add, ADDITIVE to
    /// the constant-product pool `buyShares`/`sellShares` already price
    /// against (DESIGN-COLLECTION-VAULT-NATIVE-LP-AND-ZAP-MINT-2026-08-08.md
    /// §3.1, requirement 3). Caller supplies `paymentIn`; the matching `S`
    /// amount is DERIVED from the pool's own current ratio (never a
    /// caller-nominal figure), so the deposit is always balanced by
    /// construction — no separate slippage-prone two-parameter quote needed.
    /// LP minted is proportional to the REAL, observed-delta-pulled
    /// `paymentIn` relative to the pool's `paymentReserve` at the moment of
    /// the call, exactly mirroring the genesis floor's own pricing.
    function addLiquidity(uint256 paymentIn, uint256 minLpOut)
        external
        nonReentrant
        returns (uint256 lpOut, uint256 sharesIn)
    {
        if (!poolOpen) revert PoolNotYetOpenForLp();
        if (paymentIn == 0) revert ZeroLiquidityInput();
        // Recognise elapsed donation BEFORE pricing the deposit, so a joiner
        // pays the honest, already-ramped-in price for the pool they are
        // buying into rather than the pre-drip one.
        _drip();

        uint256 totalLp = lpToken.totalSupply();
        sharesIn = (paymentIn * shareReserve) / paymentReserve;
        lpOut = (paymentIn * totalLp) / paymentReserve;
        if (sharesIn == 0 || lpOut == 0 || lpOut < minLpOut) revert InsufficientLpOutput();

        uint256 before = paymentToken.balanceOf(address(this));
        paymentToken.safeTransferFrom(msg.sender, address(this), paymentIn);
        uint256 credited = paymentToken.balanceOf(address(this)) - before;
        if (credited != paymentIn) revert IncorrectFee();

        _spendAllowance(msg.sender, address(this), sharesIn);
        _transfer(msg.sender, address(this), sharesIn);

        paymentReserve += paymentIn;
        shareReserve += sharesIn;
        lpToken.mint(msg.sender, lpOut);
        emit LiquidityAdded(msg.sender, paymentIn, sharesIn, lpOut);
    }

    /// @notice Permissionless removal, the exact counterpart to
    /// `addLiquidity` (requirement 3): burns `lpIn` of the CALLER's OWN LP
    /// balance (never anyone else's — `lpToken.burn` is only ever invoked
    /// here, with `msg.sender` as the account, so this contract holds no
    /// arbitrary admin-burn power) and returns their exact proportional
    /// share of CURRENT reserves, including every fee-driven `k` increase
    /// (Stream B's local half via `buyShares`/`sellShares`, and Stream A's
    /// `XTOKEN_COMPOUND_BPS` carve-out via `_compoundXToken`) accrued since
    /// their deposit — the identical "fee-into-k" mechanism Uniswap v2 LPs
    /// already rely on, now real for this vault's own pool.
    function removeLiquidity(uint256 lpIn, uint256 minPaymentOut, uint256 minSharesOut)
        external
        nonReentrant
        returns (uint256 paymentOut, uint256 sharesOut)
    {
        if (lpIn == 0) revert ZeroLiquidityInput();

        // ── AUDIT C-3, half 2: dwell requirement + decaying exit fee ───────
        uint256 feeBps = _exitFeeBps(msg.sender); // reverts inside the dwell
        _drip();
        {
            uint256 totalLp = lpToken.totalSupply();
            paymentOut = (lpIn * paymentReserve) / totalLp;
            sharesOut = (lpIn * shareReserve) / totalLp;
        }
        uint256 paymentFee = (paymentOut * feeBps) / BPS_DENOMINATOR;
        uint256 shareFee = (sharesOut * feeBps) / BPS_DENOMINATOR;

        // CEI: burn and update reserves before any outbound movement. The
        // reserve decrements use the GROSS payment figure and the NET share
        // figure, because the two fee legs are retained differently:
        //   * the share fee simply never leaves `shareReserve` — shares are
        //     not vestable value, they are the pool's other side, so leaving
        //     them in place is the whole retention;
        //   * the payment fee leaves `paymentReserve` and immediately re-enters
        //     via `_addDonationVest`, so it is subject to the SAME drip as
        //     every other donation. Crediting it instantly would have
        //     re-created C-3 in miniature: a second JIT LP could sandwich the
        //     exit fee of the first.
        lpToken.burn(msg.sender, lpIn);
        paymentReserve -= paymentOut;
        shareReserve -= (sharesOut - shareFee);

        paymentOut -= paymentFee;
        sharesOut -= shareFee;
        // Slippage bounds are checked against what the caller ACTUALLY
        // receives, not the pre-fee figure — a bound that ignores the fee is a
        // bound that does not bind.
        if (paymentOut < minPaymentOut || sharesOut < minSharesOut) revert InsufficientLpRemoveOutput();

        if (paymentFee > 0 || shareFee > 0) {
            _addDonationVest(paymentFee);
            emit LpExitFeeCharged(msg.sender, feeBps, paymentFee, shareFee);
        }

        paymentToken.safeTransfer(msg.sender, paymentOut);
        _transfer(address(this), msg.sender, sharesOut);
        emit LiquidityRemoved(msg.sender, lpIn, paymentOut, sharesOut);
    }

    /// @notice The exit fee `provider` would pay to remove liquidity right
    /// now, in bps, reverting with `LpDwellNotMet` if they are still inside
    /// the minimum dwell. Public so an LP can see the cost of leaving before
    /// they send the transaction.
    /// @dev `lpEntryBlock` is written on MINT and on every TRANSFER-IN (see
    /// `onLpReceived`), so neither routing the position through a fresh
    /// address nor buying LP on a secondary market resets the clock in an
    /// attacker's favour. Decayed over `DONATION_VEST_BLOCKS` deliberately —
    /// see `LP_EXIT_FEE_MAX_BPS`.
    function _exitFeeBps(address provider) private view returns (uint256) {
        uint256 held = block.number - lpEntryBlock[provider];
        if (held < LP_MIN_DWELL_BLOCKS) revert LpDwellNotMet();
        if (held >= DONATION_VEST_BLOCKS) return 0;
        return (LP_EXIT_FEE_MAX_BPS * (DONATION_VEST_BLOCKS - held)) / DONATION_VEST_BLOCKS;
    }

    /// @notice Minimum LP amount an inbound transfer must carry to restart
    /// the recipient's dwell clock. Below this, `onLpReceived` is a no-op.
    /// Closes a griefing vector (game-theory audit finding): without a
    /// floor, ANY inbound transfer — including an attacker-initiated 1-wei
    /// send the recipient never asked for and cannot refuse — reset the
    /// clock, letting anyone force a victim back to the full decayed exit
    /// fee and `LP_MIN_DWELL_BLOCKS` wait at near-zero cost. A floor forces
    /// the attacker to permanently give up real LP value per griefing
    /// attempt instead of dust.
    uint256 internal constant LP_GRIEF_RESET_FLOOR = 1e12;

    /// @notice Callback from this vault's own `CollectionVaultLP` on every
    /// mint and transfer-in of at least `LP_GRIEF_RESET_FLOOR`. Restarts
    /// `to`'s dwell clock.
    /// @dev Guarded to the LP token address only, so nobody can reset anyone
    /// else's clock. Restarting (rather than, say, taking a weighted average)
    /// is the conservative direction: it can only ever make an exit MORE
    /// expensive, never less, so there is no configuration of transfers that
    /// launders a fresh position into a cheap exit. The cost is that a
    /// long-standing LP who tops up above the floor restarts their own clock
    /// — accepted deliberately, because the alternative (per-lot accounting)
    /// is an unbounded loop on a hot path, and because the fee it exposes
    /// them to is bounded by 1% and decays to nothing.
    function onLpReceived(address to, uint256 amount) external {
        if (msg.sender != address(lpToken)) revert NotLpToken();
        if (amount < LP_GRIEF_RESET_FLOOR) return;
        lpEntryBlock[to] = block.number;
    }

    /// @dev Babylonian method, verbatim standard Uniswap-v2-style integer
    /// sqrt, used only for the one-time genesis LP mint.
    function _sqrt(uint256 y) private pure returns (uint256 z) {
        if (y > 3) {
            z = y;
            uint256 x = y / 2 + 1;
            while (x < z) {
                z = x;
                x = (y / x + x) / 2;
            }
        } else if (y != 0) {
            z = 1;
        }
    }

    /// @notice PR6 (ONESHOT §5.2 LP-renounce strategy (b) / SPEC §5): a
    /// PERMISSIONLESS, single-sided, permanent donation of `paymentToken`
    /// straight into `paymentReserve`. Unlike `seedLiquidity` (treasury-only,
    /// pre-open, mints nothing but is only usable BEFORE `openPool`), this is
    /// callable by anyone, anytime the pool is open, repeatedly.
    ///
    /// WHY SINGLE-SIDED (WETH-only), NOT A BALANCED TWO-ASSET ADD. This
    /// vault's pool is an internal constant-product AMM with NO LP token —
    /// `shareReserve`/`paymentReserve` are plain state, and this vault's own
    /// ERC-20 supply (`shareReserve` accounting) already represents 100% of
    /// the claims that will ever exist against this pool. A donor adding
    /// `wethIn` here receives NOTHING back — no LP token, no vault share, no
    /// receipt of any kind — so `k = paymentReserve * shareReserve` rises
    /// while every EXISTING share's redeemable claim on `paymentReserve`
    /// grows with it, permanently and non-reversibly. This is the strongest
    /// possible form of "no admin withdraw of renounced LP" (ONESHOT §6.6):
    /// there is no position, ticket, or shares minted to donate, so there is
    /// nothing whose withdrawal a future admin/governance call could ever
    /// gate — not even a hypothetical one, since no code path in this
    /// contract ever reduces `paymentReserve` except the ordinary, universal
    /// `sellShares` AMM exit already open to every shareholder equally.
    ///
    /// PHASE 4 / AUDIT C-3: the credit is VESTED via `_addDonationVest`, not
    /// applied instantly. A third-party donation is exactly as snipeable as a
    /// fee-derived one — `AuditJitLp.poc.test.ts` used this very function as
    /// its donation source — so it gets exactly the same treatment. Nothing
    /// above changes: the donor still receives nothing back, `k` still rises
    /// permanently and irreversibly, and no code path can ever return the
    /// donation to them. It simply arrives over `DONATION_VEST_BLOCKS`.
    function donateReserves(uint256 wethIn) external nonReentrant {
        if (!poolOpen) revert PoolNotOpen();
        if (wethIn == 0) revert NothingToDonate();
        paymentToken.safeTransferFrom(msg.sender, address(this), wethIn);
        _addDonationVest(wethIn);
        emit ReservesDonated(msg.sender, wethIn);
    }

    function withdrawFees() external nonReentrant {
        uint256 amount = accruedFees;
        if (amount == 0) revert NoFees();
        accruedFees = 0;
        paymentToken.safeTransfer(treasury, amount);
        emit FeesWithdrawn(amount);
    }

    // ── Treasury: the ONLY mutable address, timelocked ─────────────────────

    function queueTreasury(address next) external {
        if (msg.sender != treasury) revert NotTreasury();
        if (next == address(0)) revert ZeroAddress();
        uint64 eta = uint64(block.timestamp + timelockDelay);
        queuedTreasury = Queued({value: uint256(uint160(next)), eta: eta, pending: true});
        emit TreasuryQueued(next, eta);
    }

    function executeTreasury() external {
        Queued memory q = queuedTreasury;
        if (!q.pending) revert NothingQueued();
        if (block.timestamp < q.eta) revert TimelockNotElapsed();
        delete queuedTreasury;
        address prev = treasury;
        treasury = address(uint160(q.value));
        emit TreasuryApplied(prev, treasury);
    }

    // ── Stream A split: artist-selectable within [FLOOR, CEIL], timelocked ─

    function queueMintRedeemSinkBps(uint256 next) external {
        if (msg.sender != treasury) revert NotTreasury();
        if (next < FLOOR_SINK_SPLIT_BPS || next > CEIL_SINK_SPLIT_BPS) revert SplitOutOfRange();
        uint64 eta = uint64(block.timestamp + timelockDelay);
        queuedMintRedeemSinkBps = Queued({value: next, eta: eta, pending: true});
        emit MintRedeemSinkBpsQueued(next, eta);
    }

    function executeMintRedeemSinkBps() external {
        Queued memory q = queuedMintRedeemSinkBps;
        if (!q.pending) revert NothingQueued();
        if (block.timestamp < q.eta) revert TimelockNotElapsed();
        // Re-checked at execution, not just at queue time — same doctrine as
        // IndexGovernanceFacet.executeParam's hard-ceiling re-check.
        if (q.value < FLOOR_SINK_SPLIT_BPS || q.value > CEIL_SINK_SPLIT_BPS) revert SplitOutOfRange();
        delete queuedMintRedeemSinkBps;
        uint256 prev = mintRedeemSinkBps;
        mintRedeemSinkBps = q.value;
        emit MintRedeemSinkBpsApplied(prev, q.value);
    }

    // ── Views ──────────────────────────────────────────────────────────────

    function heldTokenCount() external view returns (uint256) {
        return heldTokenIds.length;
    }

    function isTokenHeld(uint256 tokenId) external view returns (bool) {
        return heldTokenIndex[tokenId] != 0;
    }

    // ── Internals ──────────────────────────────────────────────────────────

    function _addHeldToken(uint256 tokenId) private {
        if (heldTokenIndex[tokenId] != 0) revert AlreadyHeld();
        heldTokenIds.push(tokenId);
        heldTokenIndex[tokenId] = heldTokenIds.length;
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
