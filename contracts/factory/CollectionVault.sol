// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/security/ReentrancyGuard.sol";
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

    constructor(
        IERC721 collection_,
        IERC20 paymentToken_,
        string memory name_,
        string memory symbol_,
        uint256 mintFeeWei_,
        uint256 redeemFeeWei_,
        uint256 swapFeeBps_,
        address upstreamSink_,
        address treasury_,
        uint256 mintRedeemSinkBps_,
        uint256 timelockDelay_
    ) ERC20(name_, symbol_) {
        if (mintFeeWei_ > MAX_MINT_FEE_WEI || redeemFeeWei_ > MAX_REDEEM_FEE_WEI || swapFeeBps_ > MAX_SWAP_FEE_BPS) {
            revert FeeTooHigh();
        }
        if (treasury_ == address(0) || upstreamSink_ == address(0)) revert ZeroAddress();
        if (mintRedeemSinkBps_ < FLOOR_SINK_SPLIT_BPS || mintRedeemSinkBps_ > CEIL_SINK_SPLIT_BPS) {
            revert SplitOutOfRange();
        }
        collection = collection_;
        paymentToken = paymentToken_;
        mintFeeWei = mintFeeWei_;
        redeemFeeWei = redeemFeeWei_;
        swapFeeBps = swapFeeBps_;
        upstreamSink = upstreamSink_;
        treasury = treasury_;
        mintRedeemSinkBps = mintRedeemSinkBps_;
        timelockDelay = timelockDelay_;
    }

    // ── Deposit / redeem, Stream A ─────────────────────────────────────────

    function deposit(uint256 tokenId) external nonReentrant {
        _pullFee(mintFeeWei);
        collection.safeTransferFrom(msg.sender, address(this), tokenId);
        _addHeldToken(tokenId);
        _mint(msg.sender, SHARE_UNIT);
        (uint256 sinkCut, uint256 treasuryCut) = _routeStreamA(mintFeeWei);
        _noteMintRedeemSignals(sinkCut, int256(mintFeeWei));
        emit Deposited(msg.sender, tokenId, sinkCut, treasuryCut);
    }

    function redeem(uint256 tokenId) external nonReentrant {
        if (heldTokenIndex[tokenId] == 0) revert TokenNotHeld();
        _pullFee(redeemFeeWei);
        _burn(msg.sender, SHARE_UNIT);
        _removeHeldToken(tokenId);
        collection.safeTransferFrom(address(this), msg.sender, tokenId);
        (uint256 sinkCut, uint256 treasuryCut) = _routeStreamA(redeemFeeWei);
        _noteMintRedeemSignals(sinkCut, -int256(redeemFeeWei));
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
    function _compoundXToken(uint256 wethIn) private {
        if (wethIn == 0) return;
        if (!poolOpen || shareReserve == 0 || paymentReserve == 0) {
            accruedFees += wethIn;
            emit XTokenCompoundSkipped(wethIn);
            return;
        }
        paymentReserve += wethIn;
        emit XTokenCompounded(wethIn, paymentReserve);
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
        return (shares * paymentReserve) / shareReserve;
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
    function _noteSwapSignals(uint256 feeDerivedVolumeWei) private {
        if (weightModule == address(0)) return;
        try IWeightModuleSignals(weightModule).noteDepth(address(this), paymentReserve) {} catch {}
        try IWeightModuleSignals(weightModule).noteVolume(address(this), feeDerivedVolumeWei) {} catch {}
    }

    // ── Constant-product pool, Stream B ────────────────────────────────────

    function buyShares(uint256 amountIn, uint256 minSharesOut) external nonReentrant returns (uint256 sharesOut) {
        if (!poolOpen) revert PoolNotOpen();
        if (shareReserve == 0 || paymentReserve == 0) revert EmptyVault();
        if (amountIn == 0) revert InsufficientOutput();

        uint256 before = paymentToken.balanceOf(address(this));
        paymentToken.safeTransferFrom(msg.sender, address(this), amountIn);
        uint256 credited = paymentToken.balanceOf(address(this)) - before;

        uint256 sinkCut = _swapFeeSinkCut(credited);
        uint256 netIn = credited - sinkCut; // fee-that-stays-local is priced in below, same as V3

        uint256 inNet = (netIn * (BPS_DENOMINATOR - swapFeeBps)) / BPS_DENOMINATOR;
        sharesOut = (inNet * shareReserve) / (paymentReserve + inNet);
        if (sharesOut == 0 || sharesOut < minSharesOut) revert InsufficientOutput();

        paymentReserve += netIn;
        shareReserve -= sharesOut;
        _transfer(address(this), msg.sender, sharesOut);

        if (sinkCut > 0) {
            paymentToken.safeTransfer(upstreamSink, sinkCut);
            emit SweptToSink(sinkCut);
        }
        _noteSwapSignals(credited);
        emit Bought(msg.sender, credited, sharesOut, sinkCut);
    }

    function sellShares(uint256 sharesIn, uint256 minAmountOut) external nonReentrant returns (uint256 amountOut) {
        if (!poolOpen) revert PoolNotOpen();
        if (shareReserve == 0 || paymentReserve == 0) revert EmptyVault();
        if (sharesIn == 0) revert InsufficientOutput();

        uint256 inNet = (sharesIn * (BPS_DENOMINATOR - swapFeeBps)) / BPS_DENOMINATOR;
        uint256 grossOut = (inNet * paymentReserve) / (shareReserve + inNet);
        if (grossOut == 0) revert InsufficientOutput();

        uint256 sinkCut = _swapFeeSinkCut(grossOut);
        amountOut = grossOut - sinkCut;
        if (amountOut < minAmountOut) revert InsufficientOutput();

        _transfer(msg.sender, address(this), sharesIn);
        shareReserve += sharesIn;
        paymentReserve -= grossOut;

        paymentToken.safeTransfer(msg.sender, amountOut);
        if (sinkCut > 0) {
            paymentToken.safeTransfer(upstreamSink, sinkCut);
            emit SweptToSink(sinkCut);
        }
        _noteSwapSignals(grossOut);
        emit Sold(msg.sender, sharesIn, amountOut, sinkCut);
    }

    /// @dev The swap fee itself is `amount * swapFeeBps / BPS`; exactly half
    /// of THAT fee (SWAP_SINK_SPLIT_BPS = 5000) is the sink's cut. The other
    /// half stays embedded in the pool's own reserve pricing (standard AMM
    /// fee-compounding — see buyShares/sellShares using the FULL swapFeeBps
    /// discount for pricing while only the sink's half is ever transferred
    /// out).
    function _swapFeeSinkCut(uint256 amount) private view returns (uint256) {
        uint256 fee = (amount * swapFeeBps) / BPS_DENOMINATOR;
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
        lpToken = new CollectionVaultLP(
            string.concat("LP ", name()),
            string.concat("LP-", symbol()),
            address(this)
        );
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
        uint256 totalLp = lpToken.totalSupply();
        paymentOut = (lpIn * paymentReserve) / totalLp;
        sharesOut = (lpIn * shareReserve) / totalLp;
        if (paymentOut < minPaymentOut || sharesOut < minSharesOut) revert InsufficientLpRemoveOutput();

        lpToken.burn(msg.sender, lpIn);
        paymentReserve -= paymentOut;
        shareReserve -= sharesOut;

        paymentToken.safeTransfer(msg.sender, paymentOut);
        _transfer(address(this), msg.sender, sharesOut);
        emit LiquidityRemoved(msg.sender, lpIn, paymentOut, sharesOut);
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
    function donateReserves(uint256 wethIn) external nonReentrant {
        if (!poolOpen) revert PoolNotOpen();
        if (wethIn == 0) revert NothingToDonate();
        paymentToken.safeTransferFrom(msg.sender, address(this), wethIn);
        paymentReserve += wethIn;
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
