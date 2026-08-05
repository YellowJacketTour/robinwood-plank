// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * ============================================================================
 *  GlobalIndexVault — the Grand Exchange basket
 *
 *  NOT FOR DEPLOYMENT. This contract is the code-and-tests realisation of
 *  docs/marketplank/SPEC-PLANK-CHECKS-AND-INDEX.md §2 and
 *  docs/marketplank/SPEC-GLOBAL-INDEX-ULTIMATE-FORM.md. Per §2.6 it may not go
 *  to any network until it clears the same external audit
 *  MarketplankVaultV3.sol cleared. hardhat.config.ts has no default network on
 *  purpose; keep it that way.
 *
 *  WHAT THIS IS
 *  ------------
 *  An ERC-20 share token representing a claim on a basket of N constituents.
 *  A constituent is any ERC-20 that also has an IIndexPriceSource (in practice
 *  a MarketplankVaultV3 v-token priced by its own vault's real reserves), and
 *  optionally PLANK priced through a PLANK/ETH pool wearing the identical
 *  interface — never a privileged direct price.
 *
 *  THE FIVE LOAD-BEARING GUARANTEES
 *  --------------------------------
 *  1. REDEMPTION IS STRICT PRO-RATA IN-KIND, and that is the only free path.
 *     `redeemProRata` pays `floor(s * R_k / (S + V))` of EVERY
 *     constituent k, computed with an identical expression for every k in the
 *     same transaction. There is no valuation step, so there is nothing to
 *     sandwich and nothing to cherry-pick (§1 of the ultimate-form doc; Set
 *     Protocol / Balancer proportional-exit model). Every division floors, so
 *     rounding dust always stays with the vault — never a systematic
 *     dust-to-last-redeemer transfer.
 *
 *  2. THE SINGLE-ASSET EXIT IS A CONVENIENCE PRICED AT WHAT IT COSTS.
 *     `redeemSingleAsset` computes the same pro-rata payout VIRTUALLY, then
 *     internally swaps the other legs into the requested asset at the vault's
 *     own band prices and charges a Curve-style imbalance fee that scales with
 *     how imbalanced the withdrawal leaves the basket. The fee is retained in
 *     reserves, i.e. paid to the holders who stayed. `mintSingleAsset` is the
 *     symmetric deposit-side operation.
 *
 *  3. NAV IS A BAND, NEVER A POINT. Every constituent is priced by a
 *     per-block-capped, time-weighted, checkpointed price band (`priceBand`).
 *     Redemption values what you give up at NAV_low and what you receive at
 *     NAV_high; minting does the reverse. The spread is what pays for
 *     uncertainty, and it is why round-trip manipulation is unprofitable
 *     (Pyth's own documented "settle at the conservative edge" practice).
 *
 *  4. NO ROLE EVER HAS A WITHDRAWAL PATH OVER POOLED RESERVES. There is no
 *     function on this contract — privileged or not — that moves a
 *     constituent balance to the admin, the treasury, or any address other
 *     than a share-burning redeemer. Admin power is strictly over FUTURE
 *     parameter values and is timelocked. This is §2.8's anchor rule, and
 *     GlobalIndexVault.audit.test.ts enumerates the ABI and proves it.
 *
 *  5. PLANK'S CONCENTRATION CAN NEVER REACH BASKET ADMIN. This contract has no
 *     reference to PLANK, to PlankGauge, or to any gauge state anywhere in its
 *     authorisation logic. Gauge direction is bought by burning, in a wholly
 *     separate contract (PlankGauge.sol) with no hook into this one, holding
 *     its own pushed funds and never this vault's (ultimate-form §5.1 — the
 *     most important closed gap, and it is closed by keeping it closed).
 *
 *  ORACLE TRADEOFF, STATED PLAINLY
 *  -------------------------------
 *  The ultimate-form doc points at Uniswap v4's Truncated Oracle hook. This
 *  contract cannot assume v4 hook infrastructure exists on the target chain,
 *  so it approximates the same behaviour with an on-chain checkpoint
 *  accumulator it owns outright: a permissionless `checkpoint()` records a
 *  cumulative price-seconds accumulator, and each new observation is CLAMPED
 *  to within `priceCapBps` of the previous one. That reproduces the truncated
 *  oracle's defining property (bounded per-observation movement, so a
 *  single-block spike cannot be priced in) without depending on v4. What it
 *  does NOT reproduce: v4's hook fires on every pool interaction, whereas this
 *  needs someone to call `checkpoint()`. That is why the stale-observation
 *  circuit breaker (§2.9) exists and why NAV_low collapses a silent
 *  constituent to zero rather than trusting a frozen price.
 *
 *  WHY THERE IS NO FEE SWEEP, NO BUYBACK HOOK, AND NOTHING TO AUTOMATE
 *  ------------------------------------------------------------------
 *  Every fee this contract charges (the imbalance fee on the two single-asset
 *  paths) is RETAINED IN RESERVES. It is never swept, routed, or paid out to
 *  anyone — it simply raises per-share backing for the holders who stayed.
 *
 *  That is a deliberate choice, and it is what makes the classic "the accrued
 *  balance is too small to act on" problem not exist here. Protocols that
 *  externalise value (sweep a floor, add LP, run a buyback) have to answer:
 *  what happens when the accrued amount is below the gas + slippage floor? The
 *  state-of-the-art answers are (a) a threshold-gated keeper TRIGGER rather
 *  than a calendar — Yearn's `harvestTrigger()`, Curve's fee burner: a public
 *  view returning false until proceeds exceed cost, polled off-chain, gas paid
 *  only when true; (b) for NFT floors, accumulate the fractional unit (the
 *  v-token) and convert to a physical NFT only on crossing 1.0, which is what
 *  NFTX does and which removes the minimum entirely; (c) for LP, a
 *  single-sided out-of-range range order rather than a swap-half zap, since a
 *  zap pays price impact twice and is worst precisely at small size; and (d)
 *  batching many small streams into one solver-auctioned intent, which is the
 *  same primitive §4/§5.4 already chose for rebalancing.
 *
 *  None of those belong INSIDE this contract. Each is an externalisation path,
 *  and every externalisation path is a candidate violation of §2.8's anchor
 *  rule that has to be argued individually. In-place accrual needs no keeper,
 *  no trigger, no minimum size, and no new privileged caller — so that is what
 *  this contract does, and anything that must leave the vault belongs in a
 *  separately-audited contract that holds its own funds, never this one's.
 *
 *  ROUNDING DOCTRINE (§2.9, Balancer V2 composable-stable precedent)
 *  ----------------------------------------------------------------
 *  Every rounding decision in this contract resolves in the vault's favour:
 *  amounts the vault RECEIVES ceil, amounts the vault PAYS floor, values of
 *  things the user GIVES use the band low, values of things the user RECEIVES
 *  use the band high. Where the specs left an edge ambiguous, the choice made
 *  is the one that favours existing holders, and it is commented at the site.
 * ============================================================================
 */

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IIndexPriceSource} from "./IIndexPriceSource.sol";

contract GlobalIndexVault is ERC20, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice Generation marker so the client never has to sniff bytecode.
    uint256 public constant INDEX_VERSION = 1;

    uint256 private constant BPS = 10_000;
    uint256 private constant WAD = 1e18;

    /**
     * @dev OpenZeppelin's ERC-4626 virtual-shares/assets offset, applied to
     * THIS vault's own share token — the second of the two nesting layers
     * §2.9 explicitly requires be defended independently. Each constituent
     * vault defends its own layer separately; neither substitutes for the
     * other. 10**3 virtual shares against 1 virtual asset unit makes the
     * classic first-depositor donation attack cost 10**3x what it could
     * extract, and the locked seed (see `openIndex`) closes the residue.
     */
    uint256 private constant VIRTUAL_SHARES = 10 ** 3;
    uint256 private constant VIRTUAL_ASSETS = 1;

    /// @dev Bounded so every constituent loop is gas-safe and un-strandable.
    uint256 private constant MAX_CONSTITUENTS = 32;

    /// @dev Ring buffer depth for each constituent's price observations.
    uint256 private constant OBS_SLOTS = 8;

    /// @dev A seed floor stronger than UniV2's 1000-wei MINIMUM_LIQUIDITY.
    uint256 private constant MIN_SEED_SHARES = 1e6;

    /**
     * @notice Where the seed shares are locked at open, permanently.
     * @dev V3 locks its seed at `lpBalance[address(0)]`, which it can do
     * because its LP ledger is an internal mapping. This vault's shares are a
     * real ERC-20 and OpenZeppelin's `_mint` refuses address(0), so the seed
     * is minted to the canonical dead address instead. Same guarantee, same
     * one-way property: nobody holds its key, no function on this contract
     * moves shares out of it, and total supply is therefore never zero while
     * the basket is live.
     */
    address public constant SEED_LOCK = 0x000000000000000000000000000000000000dEaD;

    // ── Hard, contract-level parameter ceilings ────────────────────────────
    // §2.5/§2.8: a timelock bounds WHEN a bad change lands, never HOW BAD it
    // can be. These ceilings are compile-time constants — no admin, no
    // timelock, and no future governance can raise them.
    uint256 private constant MIN_TIMELOCK_DELAY = 48 hours;
    uint256 private constant MAX_TIMELOCK_DELAY = 30 days;
    uint256 private constant MIN_CONCENTRATION_CAP_BPS = 1_000; // 10%
    uint256 private constant MAX_CONCENTRATION_CAP_BPS = 5_000; // 50%
    uint256 private constant CEIL_IMBALANCE_FEE_BPS = 1_000; // 10%, absolute
    uint256 private constant CEIL_BAND_BPS = 2_000; // 20% band widening
    uint256 private constant CEIL_PRICE_CAP_BPS = 2_000; // 20% per observation
    uint256 private constant MIN_RAMP_DURATION = 7 days;
    uint256 private constant MAX_RAMP_DURATION = 365 days;
    /// @dev Absolute ceiling on the platform/operator share allocation. 5%.
    /// Compile-time, so no admin and no timelock can raise it.
    uint256 private constant CEIL_PLATFORM_ALLOCATION_BPS = 500;
    /// @dev Value the allocation is born at. 2% — the low end of the range
    /// index products actually charge, and chosen at the low end deliberately:
    /// an operator cut is the one parameter in this contract whose default
    /// should favour the depositor, since the depositor is the party who did
    /// not vote on it. It is inert until a treasury is appointed anyway.
    uint256 private constant DEFAULT_PLATFORM_ALLOCATION_BPS = 200;

    // ── Types ──────────────────────────────────────────────────────────────

    struct Observation {
        uint64 timestamp;
        uint192 price; // ETH wei per WAD of token, already movement-capped
        uint256 cumulative; // price-seconds accumulator
    }

    struct Constituent {
        IIndexPriceSource source;
        uint64 rampStart;
        uint64 rampDuration;
        uint256 rawTargetWeightBps; // pre-curve intent, informational
        uint256 metric; // fee revenue + locked LP, timelocked input to √ curve
        uint256 reserve; // credited balance, NEVER balanceOf()
        bool listed;
        bool active; // false = weight target 0, but reserves still redeemable
        uint8 obsCount;
        uint8 obsHead;
        Observation[OBS_SLOTS] obs;
    }

    struct Params {
        uint256 concentrationCapBps;
        uint256 baseImbalanceFeeBps;
        uint256 imbalanceSlopeBps;
        uint256 maxImbalanceFeeBps;
        uint256 bandBps;
        uint256 priceCapBps;
        uint256 minCheckpointInterval;
        uint256 staleAfter;
        uint256 persistenceCheckpoints;
        uint256 persistenceToleranceBps;
        uint256 largeOpValueWei;
        uint256 rampDuration;
    }

    struct QueuedParam {
        uint256 value;
        uint64 eta;
        bool pending;
    }

    struct QueuedListing {
        IIndexPriceSource source;
        uint256 rawTargetWeightBps;
        uint64 eta;
        bool pending;
        bool isRemoval;
    }

    // ── Storage ────────────────────────────────────────────────────────────

    /// @notice Timelock delay, fixed at deploy. Not itself changeable — a
    /// mutable timelock delay is a timelock that can be shortened to zero.
    uint256 public immutable timelockDelay;

    /// @notice Sets FUTURE parameters only. Has no withdrawal path, ever.
    address public admin;

    /// @notice Seeds the basket before it opens; zero privilege after (§2.1).
    address public immutable seeder;

    /// @notice One-way. While false only seeding works; once true, forever.
    bool public indexOpen;

    Params public params;

    address[] private constituentList;
    mapping(address => Constituent) private constituents;

    mapping(bytes32 => QueuedParam) public queuedParams;
    mapping(address => QueuedListing) public queuedListings;
    QueuedParam public queuedAdmin;
    QueuedParam public queuedPlatformTreasury;

    /**
     * @notice PLATFORM/OPERATOR SHARE ALLOCATION (§2.8-compatible dilution).
     *
     * On every mint, `platformAllocationBps` of the shares that mint would
     * have produced are minted to `platformTreasury` INSTEAD of to the
     * depositor. The total share count minted is bit-for-bit what it would
     * have been with the parameter at zero, so:
     *
     *   - existing holders' NAV-per-share is EXACTLY unaffected. This is the
     *     load-bearing difference from the naive implementation, which mints
     *     the operator's cut ON TOP and silently taxes everyone who already
     *     held. That version would be a withdrawal path over pooled reserves
     *     wearing a different hat, and §2.8 forbids it.
     *   - the depositor still pays full value in and receives shares for
     *     (1 - bps) of it. That is the whole cost, it is on-chain, and it is
     *     bounded by a compile-time ceiling no governance can raise.
     *   - reserves are never touched. Nothing is ever transferred to the
     *     treasury; it receives SHARES, redeemable only through the same
     *     strict pro-rata path as everybody else's.
     *
     * INERT BY DEFAULT: with `platformTreasury` unset (address(0)) the whole
     * mechanism is skipped and every mint behaves exactly as it did before
     * this parameter existed. Turning it on requires a timelocked treasury
     * appointment, and the bps itself is separately timelocked and ceilinged.
     */
    address public platformTreasury;
    uint256 public platformAllocationBps;

    // ── Events ─────────────────────────────────────────────────────────────

    event ConstituentQueued(address indexed token, uint64 eta, bool removal);
    event ConstituentListed(address indexed token, address source, uint256 rawWeightBps);
    event ConstituentDeactivated(address indexed token);
    event ConstituentDelisted(address indexed token);
    event ParamQueued(bytes32 indexed key, uint256 value, uint64 eta);
    event ParamApplied(bytes32 indexed key, uint256 value);
    event AdminQueued(address indexed next, uint64 eta);
    event AdminApplied(address indexed next);
    event Seeded(address indexed token, uint256 amount);
    event IndexOpened(uint256 lockedSeedShares);
    event Checkpointed(address indexed token, uint256 price);
    event MintedProRata(address indexed to, uint256 shares);
    event RedeemedProRata(address indexed from, uint256 shares);
    event MintedSingle(address indexed to, address indexed token, uint256 amountIn, uint256 shares);
    event RedeemedSingle(address indexed from, address indexed token, uint256 shares, uint256 amountOut);
    event MetricUpdated(address indexed token, uint256 metric);

    // ── Errors ─────────────────────────────────────────────────────────────

    error NotAdmin();
    error NotSeeder();
    error IndexNotOpen();
    error IndexAlreadyOpen();
    error AlreadyListed();
    error NotListed();
    error TooManyConstituents();
    error BadParam();
    error NothingQueued();
    error TimelockNotElapsed();
    error ZeroAmount();
    error SlippageExceeded();
    error ConcentrationCapExceeded();
    error ReserveWouldEmpty();
    error CheckpointTooSoon();
    error NoPriceData();
    error StalePrice();
    error PersistenceCheckFailed();
    error ReservesOutstanding();
    error BadBatch();
    error ShortDelivery();
    error ConstituentExiting();
    error AllocationCapExceeded();

    // ── Construction ───────────────────────────────────────────────────────

    constructor(
        string memory name_,
        string memory symbol_,
        address admin_,
        address seeder_,
        uint256 timelockDelay_,
        Params memory params_
    ) ERC20(name_, symbol_) {
        if (admin_ == address(0) || seeder_ == address(0)) revert BadParam();
        if (timelockDelay_ < MIN_TIMELOCK_DELAY || timelockDelay_ > MAX_TIMELOCK_DELAY) {
            revert BadParam();
        }
        admin = admin_;
        seeder = seeder_;
        timelockDelay = timelockDelay_;
        _validateParams(params_);
        params = params_;
        platformAllocationBps = DEFAULT_PLATFORM_ALLOCATION_BPS; // inert: no treasury yet
    }

    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAdmin();
        _;
    }

    modifier whenOpen() {
        if (!indexOpen) revert IndexNotOpen();
        _;
    }

    // ══ Bootstrap ═════════════════════════════════════════════════════════
    //
    // Mirrors MarketplankVaultV3's openPool() exactly: the seeder has real
    // power only BEFORE the basket opens, and none the instant it does. The
    // seed shares are minted to address(0) permanently, so total supply is
    // never zero while the basket is live — which is what makes the
    // first-depositor inflation attack structurally impossible on top of the
    // virtual-shares offset, rather than merely expensive.

    /// @notice List a constituent before open. Seeder only, bootstrap only.
    function seedConstituent(
        IERC20 token,
        IIndexPriceSource source,
        uint256 rawTargetWeightBps
    ) external nonReentrant {
        if (msg.sender != seeder) revert NotSeeder();
        if (indexOpen) revert IndexAlreadyOpen();
        _list(address(token), source, rawTargetWeightBps, uint64(block.timestamp), 0);
    }

    /// @notice Move constituent tokens into the basket before open. No claim
    /// is minted for them — the seed is donated, same as V3's seedShares.
    function seedDeposit(IERC20 token, uint256 amount) external nonReentrant {
        if (msg.sender != seeder) revert NotSeeder();
        if (indexOpen) revert IndexAlreadyOpen();
        Constituent storage c = _get(address(token));
        uint256 credited = _pullCredited(token, msg.sender, amount);
        c.reserve += credited;
        _observe(address(token), c, true);
        emit Seeded(address(token), credited);
    }

    /**
     * @notice Open the basket for public use. Seeder only. ONE-WAY.
     * @dev Requires every listed constituent to hold a strictly positive
     * reserve and at least one price observation, so no leg is born silent.
     */
    function openIndex(uint256 seedShares) external nonReentrant {
        if (msg.sender != seeder) revert NotSeeder();
        if (indexOpen) revert IndexAlreadyOpen();
        if (seedShares < MIN_SEED_SHARES) revert BadParam();
        uint256 n = constituentList.length;
        if (n == 0) revert NotListed();
        for (uint256 i = 0; i < n; i++) {
            Constituent storage c = constituents[constituentList[i]];
            if (c.reserve == 0 || c.obsCount == 0) revert ZeroAmount();
            c.rampStart = uint64(block.timestamp);
            c.rampDuration = 0; // genesis constituents start at full weight
        }
        indexOpen = true;
        _mint(SEED_LOCK, seedShares); // permanently locked, unredeemable
        emit IndexOpened(seedShares);
    }

    // ══ Oracle: capped, checkpointed, banded ══════════════════════════════

    /**
     * @notice Record one price observation for a constituent. Permissionless
     * — anyone may call, and the honest party always wants to, because a
     * stale constituent is valued at zero on the redemption side.
     * @dev The new observation is CLAMPED to +/- priceCapBps of the previous
     * one. This is the truncated-oracle property: a flash-loaned spike of any
     * magnitude enters the record as at most one capped step, and reverting it
     * in the same block costs the attacker the whole round trip for nothing.
     */
    function checkpoint(address token) public {
        Constituent storage c = _get(token);
        _observe(token, c, false);
    }

    /// @notice Checkpoint every listed constituent. Convenience, same rules.
    function checkpointAll() external {
        uint256 n = constituentList.length;
        for (uint256 i = 0; i < n; i++) {
            address t = constituentList[i];
            Constituent storage c = constituents[t];
            if (block.timestamp >= uint256(_last(c).timestamp) + params.minCheckpointInterval) {
                _observe(t, c, false);
            }
        }
    }

    function _observe(address token, Constituent storage c, bool bootstrap) private {
        uint256 spot = _spotPrice(c.source);
        if (spot == 0) revert NoPriceData();

        if (c.obsCount == 0) {
            c.obs[0] = Observation({
                timestamp: uint64(block.timestamp),
                price: uint192(spot),
                cumulative: 0
            });
            c.obsCount = 1;
            c.obsHead = 0;
            emit Checkpointed(token, spot);
            return;
        }

        Observation memory prev = _last(c);
        if (!bootstrap && block.timestamp < uint256(prev.timestamp) + params.minCheckpointInterval) {
            revert CheckpointTooSoon();
        }
        if (block.timestamp == prev.timestamp) revert CheckpointTooSoon();

        // Per-observation movement cap — the truncated-oracle core.
        uint256 capped = spot;
        uint256 hi = (uint256(prev.price) * (BPS + params.priceCapBps)) / BPS;
        uint256 lo = (uint256(prev.price) * (BPS - params.priceCapBps)) / BPS;
        if (capped > hi) capped = hi;
        if (capped < lo) capped = lo;
        if (capped == 0) capped = 1;

        uint256 dt = block.timestamp - uint256(prev.timestamp);
        uint256 head = (uint256(c.obsHead) + 1) % OBS_SLOTS;
        c.obs[head] = Observation({
            timestamp: uint64(block.timestamp),
            price: uint192(capped),
            cumulative: prev.cumulative + uint256(prev.price) * dt
        });
        c.obsHead = uint8(head);
        if (c.obsCount < OBS_SLOTS) c.obsCount += 1;
        emit Checkpointed(token, capped);
    }

    function _spotPrice(IIndexPriceSource source) private view returns (uint256) {
        uint256 e = source.ethReserve();
        uint256 s = source.shareReserve();
        if (e == 0 || s == 0) return 0;
        return Math.mulDiv(e, WAD, s);
    }

    function _last(Constituent storage c) private view returns (Observation memory) {
        return c.obs[c.obsHead];
    }

    /**
     * @notice The constituent's conservative price BAND and its time-weighted
     * mean, all in ETH wei per WAD of token.
     * @dev low/high are the min/max of the retained observations, then widened
     * by `bandBps`. NAV is never a point estimate anywhere in this contract.
     *
     * STALE / SILENT-CONSTITUENT CIRCUIT BREAKER (§2.9): if the newest
     * observation is older than `staleAfter`, `low` collapses to ZERO while
     * `high` is retained. That is deliberately asymmetric and deliberately
     * harsh: a constituent whose vault was drained or frozen produces no
     * trades and therefore no price signal at all, so a TWAP that has simply
     * gone quiet must never be trusted to VALUE something (low = 0 means it
     * contributes nothing to what you are credited for giving up), while
     * still being expensive to RECEIVE (high retained). A stale leg is always
     * fully redeemable pro-rata in kind — that path uses no prices at all.
     */
    function priceBand(address token)
        public
        view
        returns (uint256 low, uint256 high, uint256 twap)
    {
        Constituent storage c = _get(token);
        if (c.obsCount == 0) return (0, 0, 0);

        uint256 minP = type(uint256).max;
        uint256 maxP = 0;
        uint256 sum = 0;
        uint256 n = c.obsCount;
        for (uint256 i = 0; i < n; i++) {
            uint256 slot = (uint256(c.obsHead) + OBS_SLOTS - i) % OBS_SLOTS;
            uint256 p = uint256(c.obs[slot].price);
            if (p < minP) minP = p;
            if (p > maxP) maxP = p;
            sum += p;
        }
        twap = sum / n;

        low = (minP * (BPS - params.bandBps)) / BPS;
        high = (maxP * (BPS + params.bandBps)) / BPS;

        if (block.timestamp > uint256(_last(c).timestamp) + params.staleAfter) {
            low = 0;
        }
    }

    /**
     * @notice Persistence check (ultimate-form §5.3). Every retained
     * observation must sit within `persistenceToleranceBps` of the TWAP, and
     * there must be at least `persistenceCheckpoints` of them.
     * @dev This is what a sustained, capital-committed push on the thinnest
     * constituent has to survive. The per-observation cap already forces a
     * spike to arrive in steps; this forces those steps to HOLD across
     * independent settlement checkpoints before the basket will price a
     * basket-moving trade against them. Enforced only above
     * `largeOpValueWei`, so ordinary retail flow stays instant.
     *
     * This overload keeps the ORIGINAL fixed-N meaning and is what a UI or an
     * off-chain monitor should read. The size-proportional form the two
     * priced paths actually gate on is `persistenceHoldsFor` — see
     * `requiredCheckpoints`.
     */
    function persistenceHolds(address token) public view returns (bool) {
        return persistenceHoldsFor(token, params.persistenceCheckpoints);
    }

    /**
     * @notice SIZE-PROPORTIONAL PERSISTENCE. How many settled checkpoints an
     * operation worth `ethValue` must see a constituent's band hold across.
     *
     * A fixed N is defeatable by a patient attacker with a simple, cheap
     * plan: hold the pushed price for exactly N checkpoints, take the whole
     * basket-moving trade on checkpoint N, and let the price fall on N+1. The
     * cost of holding is linear in N and the profit is linear in SIZE, so at
     * a fixed N there is always a size at which the attack pays. Making the
     * requirement grow with size removes that: the bigger the extraction, the
     * longer the push has to be financed before it can be cashed.
     *
     *     required = persistenceCheckpoints + floor(ethValue / largeOpValueWei) - 1
     *
     * clamped to [persistenceCheckpoints, OBS_SLOTS].
     *
     * WHY A FLAT ADMIN-SET THRESHOLD AND NOT RECENT VOLUME. The alternative
     * — scale against the constituent's own recent volume — was considered
     * and rejected on the same grounds §2.5 rejects a privileged PLANK price:
     * an on-chain volume figure is a number an attacker can manufacture. Wash
     * trading a thin v-token pool for one window would INFLATE the
     * denominator and therefore SHRINK the number of checkpoints the attacker
     * then has to survive — the metric would actively pay for its own
     * manipulation, and it would do so most on precisely the thin, illiquid
     * constituents this gate exists to protect. `largeOpValueWei` is already
     * a timelocked, ceilinged parameter and it is not forgeable by trading,
     * so the step unit is reused rather than a second, weaker signal invented.
     */
    function requiredCheckpoints(uint256 ethValue) public view returns (uint256) {
        uint256 base = params.persistenceCheckpoints;
        uint256 unit = params.largeOpValueWei;
        if (ethValue < unit) return base; // not a large op at all
        uint256 steps = ethValue / unit; // >= 1
        uint256 required = base + steps - 1;
        return required > OBS_SLOTS ? OBS_SLOTS : required;
    }

    /// @notice `persistenceHolds`, but against an explicit checkpoint count.
    function persistenceHoldsFor(address token, uint256 required) public view returns (bool) {
        Constituent storage c = _get(token);
        if (c.obsCount < required) return false;
        if (block.timestamp > uint256(_last(c).timestamp) + params.staleAfter) return false;

        (, , uint256 twap) = priceBand(token);
        if (twap == 0) return false;
        uint256 tol = (twap * params.persistenceToleranceBps) / BPS;
        uint256 n = c.obsCount;
        for (uint256 i = 0; i < n; i++) {
            uint256 slot = (uint256(c.obsHead) + OBS_SLOTS - i) % OBS_SLOTS;
            uint256 p = uint256(c.obs[slot].price);
            uint256 diff = p > twap ? p - twap : twap - p;
            if (diff > tol) return false;
        }
        return true;
    }

    // ══ NAV ═══════════════════════════════════════════════════════════════

    /// @notice The basket's NAV band in ETH wei. Never one number, anywhere.
    function nav() public view returns (uint256 navLow, uint256 navHigh) {
        uint256 n = constituentList.length;
        for (uint256 i = 0; i < n; i++) {
            address t = constituentList[i];
            (uint256 lo, uint256 hi, ) = priceBand(t);
            uint256 r = constituents[t].reserve;
            navLow += Math.mulDiv(r, lo, WAD);
            navHigh += Math.mulDiv(r, hi, WAD);
        }
    }

    /// @notice Per-constituent share of NAV_low, in bps. Used for the cap.
    function weightBps(address token) public view returns (uint256) {
        (uint256 navLow, ) = nav();
        if (navLow == 0) return 0;
        (uint256 lo, , ) = priceBand(token);
        uint256 v = Math.mulDiv(constituents[token].reserve, lo, WAD);
        return (v * BPS) / navLow;
    }

    /**
     * @notice Target weights: square-root curve over each constituent's
     * manipulation-resistant metric, then the hard concentration cap applied
     * with the excess redistributed pro-rata across the uncapped remainder,
     * then each newly-added constituent's result scaled by its ramp-in
     * progress. §2.7, and the same capped-index methodology UCITS funds and
     * Index Coop use.
     * @dev A view. Nothing on-chain force-trades against it — rebalancing is
     * specified (§2.7, ultimate-form §4/§5.4) as piecewise, solver-auctioned
     * INTENTS, precisely so the trade direction is not published on-chain
     * ahead of the fill. Publishing a target vector is safe; publishing an
     * executable rebalance order is what gets front-run.
     */
    function targetWeightsBps() public view returns (address[] memory tokens, uint256[] memory bps) {
        uint256 n = constituentList.length;
        tokens = new address[](n);
        bps = new uint256[](n);
        uint256[] memory raw = new uint256[](n);
        uint256[] memory factor = new uint256[](n);
        uint256 total;
        for (uint256 i = 0; i < n; i++) {
            tokens[i] = constituentList[i];
            Constituent storage c = constituents[tokens[i]];
            // A ramp factor of zero means "contributes nothing", which covers
            // both a brand-new constituent at t=0 and a fully ramped-out one.
            // It must also be excluded from the normalising total, or a
            // long-dead constituent would silently depress every live leg.
            factor[i] = _rampFactorBps(c);
            if (factor[i] == 0) continue;
            uint256 r = Math.sqrt(c.metric);
            raw[i] = r;
            total += r;
        }
        if (total == 0) return (tokens, bps);

        uint256 cap = params.concentrationCapBps;
        for (uint256 i = 0; i < n; i++) bps[i] = (raw[i] * BPS) / total;

        // Cap-and-redistribute, iterated: capping one constituent inflates the
        // others, which may push a second over the cap. Bounded to n passes.
        for (uint256 pass = 0; pass < n; pass++) {
            uint256 excess;
            uint256 uncapped;
            for (uint256 i = 0; i < n; i++) {
                if (bps[i] > cap) {
                    excess += bps[i] - cap;
                    bps[i] = cap;
                } else if (bps[i] > 0) {
                    uncapped += bps[i];
                }
            }
            if (excess == 0 || uncapped == 0) break;
            for (uint256 i = 0; i < n; i++) {
                if (bps[i] < cap && bps[i] > 0) {
                    bps[i] += (excess * bps[i]) / uncapped;
                }
            }
        }

        // Gradual ramp, in BOTH directions (see `_rampFactorBps`).
        for (uint256 i = 0; i < n; i++) {
            if (factor[i] == BPS) continue;
            bps[i] = (bps[i] * factor[i]) / BPS;
        }
    }

    /**
     * @dev A constituent's target-weight scaling, 0..BPS.
     *
     * RAMP-IN (active): a new constituent reaches its target over a real
     * window, never in one block (§2.7 step 4). A stale constituent's ramp-in
     * is FROZEN at zero progress — §2.9's "freeze further weight ramp-in".
     *
     * RAMP-OUT (deactivated): symmetric, and it was MISSING before. A queued
     * removal used to drop the target weight from full to zero the instant it
     * executed, which is exactly the cliff §2.7 forbids on the way in: it
     * publishes "sell all of this leg, now" to every rebalancing solver in one
     * block, and it does so for the constituent most likely to be illiquid,
     * since illiquidity is usually why it is being removed. Removal is
     * therefore NOT blocked even when the leg holds a large fraction of NAV —
     * blocking it would leave the basket unable to ever exit a broken
     * constituent, and deactivation moves no value in any case (reserves stay
     * fully redeemable pro-rata, which is what `delistEmpty`'s
     * ReservesOutstanding guard already enforces). Instead the target decays
     * linearly to zero over the same `rampDuration`, so the intent is public
     * and gradual and the order is not.
     *
     * Staleness does NOT freeze a ramp-OUT. Freezing it would pin a silent,
     * being-removed constituent at full target weight — the opposite of the
     * conservative direction, and the one case where "freeze on stale" would
     * help an attacker rather than the basket.
     */
    function _rampFactorBps(Constituent storage c) private view returns (uint256) {
        if (c.active) {
            if (c.rampDuration == 0) return BPS;
            uint256 elapsed = block.timestamp - uint256(c.rampStart);
            if (block.timestamp > uint256(_last(c).timestamp) + params.staleAfter) {
                elapsed = 0;
            }
            if (elapsed >= c.rampDuration) return BPS;
            return (elapsed * BPS) / c.rampDuration;
        }
        if (c.rampDuration == 0) return 0;
        uint256 e = block.timestamp - uint256(c.rampStart);
        if (e >= c.rampDuration) return 0;
        return BPS - (e * BPS) / c.rampDuration;
    }

    // ══ Mint ══════════════════════════════════════════════════════════════

    /**
     * @notice Mint `sharesOut` by depositing a pro-rata slice of EVERY
     * constituent. No valuation step, no oracle read, nothing to sandwich.
     * @param maxAmountsIn per-constituent ceiling, index-aligned with
     * `constituents()`. Slippage guard.
     * @dev Every required amount CEILS. The vault always over-collects by at
     * most one base unit per constituent, and that unit stays with the vault.
     */
    function mintProRata(uint256 sharesOut, uint256[] calldata maxAmountsIn)
        external
        nonReentrant
        whenOpen
        returns (uint256[] memory amountsIn)
    {
        if (sharesOut == 0) revert ZeroAmount();
        uint256 n = constituentList.length;
        if (maxAmountsIn.length != n) revert BadBatch();

        uint256 denom = totalSupply() + VIRTUAL_SHARES;
        amountsIn = new uint256[](n);
        for (uint256 i = 0; i < n; i++) {
            address t = constituentList[i];
            Constituent storage c = constituents[t];
            uint256 want = Math.mulDiv(sharesOut, c.reserve + VIRTUAL_ASSETS, denom, Math.Rounding.Up);
            if (want == 0) revert ZeroAmount();
            if (want > maxAmountsIn[i]) revert SlippageExceeded();
            // Credit the ACTUAL delta, never the nominal amount — Balancer
            // STA precedent, §2.9. A fee-on-transfer or rebasing constituent
            // silently breaks basket math otherwise.
            uint256 credited = _pullCredited(IERC20(t), msg.sender, want);
            // ...and then REFUSE the mint if the delta fell short of what the
            // pro-rata slice required. Crediting the true delta alone is not
            // enough: this path mints a fixed `sharesOut`, so accepting a
            // short delivery would mint full shares against a partial deposit
            // and dilute every existing holder's backing by the transfer fee.
            // (Found by the randomized suite, not by inspection — the audit
            // suite now pins it.) The conservative resolution is to reject: a
            // constituent that cannot deliver its nominal amount must be
            // wrapped before it is listed, never absorbed at holders' expense.
            if (credited < want) revert ShortDelivery();
            c.reserve += credited;
            amountsIn[i] = credited;
        }

        _mintWithAllocation(msg.sender, sharesOut);
        emit MintedProRata(msg.sender, sharesOut);
    }

    /**
     * @notice Mint by depositing ONE constituent. The non-pro-rata portion is
     * priced through the vault's own band and charged a Curve-style imbalance
     * fee, symmetric with `redeemSingleAsset`.
     * @dev Deliberately conservative in three independent places: what you
     * deposit is valued at that constituent's band LOW, the basket you are
     * buying into is valued at NAV_HIGH, and the imbalance fee is subtracted
     * from the resulting shares. Where the specs did not pin down whether the
     * deposit side should mirror the redemption side's fee, we mirror it —
     * an asymmetric-fee basket is a basket you can round-trip for free in one
     * direction.
     */
    function mintSingleAsset(
        address token,
        uint256 amountIn,
        uint256 minSharesOut
    ) external nonReentrant whenOpen returns (uint256 sharesOut) {
        if (amountIn == 0) revert ZeroAmount();
        Constituent storage c = _get(token);
        _requireNotExiting(token, c);

        (uint256 lo, , ) = priceBand(token);
        if (lo == 0) revert StalePrice();
        (, uint256 navHigh) = nav();
        if (navHigh == 0) revert NoPriceData();

        uint256 credited = _pullCredited(IERC20(token), msg.sender, amountIn);
        uint256 ethValue = Math.mulDiv(credited, lo, WAD);
        _requirePersistenceIfLarge(token, ethValue);

        // Pro-rata-equivalent shares, floored, against the OVER-stated basket.
        sharesOut = Math.mulDiv(ethValue, totalSupply() + VIRTUAL_SHARES, navHigh + VIRTUAL_ASSETS);
        uint256 feeBps = _mintFeeBps(token, _imbalanceFeeBps(credited, c.reserve));
        sharesOut -= (sharesOut * feeBps) / BPS;
        if (sharesOut == 0) revert ZeroAmount();

        uint256[] memory weightsBefore = _allWeightsBps();
        c.reserve += credited;
        // The slippage guard is checked against what the DEPOSITOR actually
        // receives, not the pre-allocation gross — a guard that can be
        // satisfied by shares the caller never gets is not a guard.
        sharesOut = _mintWithAllocation(msg.sender, sharesOut);
        if (sharesOut < minSharesOut) revert SlippageExceeded();
        _requireCapNotWorsened(weightsBefore);

        emit MintedSingle(msg.sender, token, credited, sharesOut);
    }

    // ══ Redeem ════════════════════════════════════════════════════════════

    /**
     * @notice STRICT PRO-RATA IN-KIND REDEMPTION. Burn `sharesIn`, receive
     * `floor(sharesIn * reserve_k / (totalSupply + VIRTUAL_SHARES))` of every
     * constituent k — the identical expression for every k, in one
     * transaction, with no valuation step anywhere in the path.
     *
     * ASYMMETRIC VIRTUAL-ASSET OFFSET, AND WHY (a rounding-direction decision
     * the specs left open, resolved in the vault's favour per §2.9): the MINT
     * side charges against `reserve_k + VIRTUAL_ASSETS` while the REDEEM side
     * pays against `reserve_k` alone. Carrying the +VIRTUAL_ASSETS through to
     * the payout is the intuitive symmetric choice and it is WRONG — it lets a
     * redemption pay out marginally MORE than a strict pro-rata slice of the
     * real reserve (concretely: reserve 3, burning half the effective supply,
     * pays 2 where strict pro-rata is 1.5), which is a per-share-backing leak
     * to the redeemer of exactly the shape the Balancer V2 composable-stable
     * incident was. Charging the offset on the way in and never crediting it
     * on the way out keeps `out_k * (S + V) <= sharesIn * reserve_k` true for
     * every constituent and every input, which is the property the audit suite
     * asserts directly.
     *
     * This is the free path and the only free path. It is what makes "nobody
     * can extract undue value" true by construction rather than by
     * monitoring: the redeemer never chooses composition, only quantity, so
     * there is nothing to cherry-pick; per-share backing of every constituent
     * is non-decreasing for everyone who stayed; and because the vault never
     * has to choose WHICH asset to liquidate, the Altura "illiquid dregs left
     * for whoever's last" failure mode cannot occur here (ultimate-form §1).
     *
     * The burn/payout logic lives HERE, in the vault, never behind an
     * approved periphery helper — BasketDAO's 2021 incident was an
     * infinite-approval bug in exactly such a wrapper, not in the pro-rata
     * math it wrapped.
     */
    function redeemProRata(uint256 sharesIn, uint256[] calldata minAmountsOut)
        external
        nonReentrant
        whenOpen
        returns (uint256[] memory amountsOut)
    {
        if (sharesIn == 0) revert ZeroAmount();
        uint256 n = constituentList.length;
        if (minAmountsOut.length != n) revert BadBatch();

        uint256 denom = totalSupply() + VIRTUAL_SHARES;
        _burn(msg.sender, sharesIn); // burn first: no reentrancy on a stale supply

        amountsOut = new uint256[](n);
        for (uint256 i = 0; i < n; i++) {
            address t = constituentList[i];
            Constituent storage c = constituents[t];
            // FLOOR, against the REAL reserve (see the asymmetry note above).
            // Dust always stays with the vault, so there is no systematic
            // advantage to redeeming last (ultimate-form §1).
            uint256 out = Math.mulDiv(sharesIn, c.reserve, denom);
            if (out > c.reserve) out = c.reserve; // unreachable given the locked seed; belt and braces
            if (out < minAmountsOut[i]) revert SlippageExceeded();
            if (out > 0) {
                c.reserve -= out;
                IERC20(t).safeTransfer(msg.sender, out);
            }
            amountsOut[i] = out;
        }
        emit RedeemedProRata(msg.sender, sharesIn);
    }

    /**
     * @notice Convenience exit into ONE constituent. Decomposed exactly the
     * way Balancer formalises a non-proportional exit: the same pro-rata burn
     * computed VIRTUALLY, followed by an internal swap of the other legs into
     * the requested asset at the vault's own band prices, charged a
     * Curve-`remove_liquidity_one_coin`-style imbalance fee that scales with
     * how imbalanced the withdrawal leaves the basket.
     * @dev The fee is RETAINED IN RESERVES. It is not routed to a treasury,
     * an admin, or a fee recipient — there is no such path on this contract
     * (§2.8). It accrues to the holders who stayed, which is precisely whose
     * cost the redeemer is being charged for.
     */
    function redeemSingleAsset(
        uint256 sharesIn,
        address token,
        uint256 minAmountOut
    ) external nonReentrant whenOpen returns (uint256 amountOut) {
        if (sharesIn == 0) revert ZeroAmount();
        Constituent storage target = _get(token);

        amountOut = _previewSingleExit(sharesIn, token);
        if (amountOut >= target.reserve) revert ReserveWouldEmpty();
        if (amountOut < minAmountOut) revert SlippageExceeded();

        {
            (uint256 targetLo, , ) = priceBand(token);
            _requirePersistenceIfLarge(token, Math.mulDiv(amountOut, targetLo, WAD));
        }

        uint256[] memory weightsBefore = _allWeightsBps();
        _burn(msg.sender, sharesIn);
        target.reserve -= amountOut;
        IERC20(token).safeTransfer(msg.sender, amountOut);
        // A single-asset exit lowers the TARGET's weight — but by shrinking
        // one leg it mechanically raises every OTHER leg's share of NAV, which
        // is its own way of breaching the cap. The check therefore covers the
        // whole basket, not just the leg the caller named. (Found by the
        // randomized suite: a large exit from one leg pushed a different leg
        // past 40%, and a target-only check waved it through.)
        _requireCapNotWorsened(weightsBefore);

        emit RedeemedSingle(msg.sender, token, sharesIn, amountOut);
    }

    // ══ Timelocked administration ═════════════════════════════════════════
    //
    // EVERY function below affects FUTURE parameter values only. None of them
    // can move a constituent balance. That is §2.8's anchor rule and it is not
    // a convention here — the contract has no code path at all that transfers
    // a reserve anywhere except to a share-burning redeemer.

    function queueParam(bytes32 key, uint256 value) external onlyAdmin {
        uint64 eta = uint64(block.timestamp + timelockDelay);
        queuedParams[key] = QueuedParam({value: value, eta: eta, pending: true});
        emit ParamQueued(key, value, eta);
    }

    function executeParam(bytes32 key) external {
        QueuedParam memory q = queuedParams[key];
        if (!q.pending) revert NothingQueued();
        if (block.timestamp < q.eta) revert TimelockNotElapsed();
        delete queuedParams[key];

        Params memory p = params;
        if (key == "concentrationCapBps") p.concentrationCapBps = q.value;
        else if (key == "baseImbalanceFeeBps") p.baseImbalanceFeeBps = q.value;
        else if (key == "imbalanceSlopeBps") p.imbalanceSlopeBps = q.value;
        else if (key == "maxImbalanceFeeBps") p.maxImbalanceFeeBps = q.value;
        else if (key == "bandBps") p.bandBps = q.value;
        else if (key == "priceCapBps") p.priceCapBps = q.value;
        else if (key == "minCheckpointInterval") p.minCheckpointInterval = q.value;
        else if (key == "staleAfter") p.staleAfter = q.value;
        else if (key == "persistenceCheckpoints") p.persistenceCheckpoints = q.value;
        else if (key == "persistenceToleranceBps") p.persistenceToleranceBps = q.value;
        else if (key == "largeOpValueWei") p.largeOpValueWei = q.value;
        else if (key == "rampDuration") p.rampDuration = q.value;
        else if (key == "platformAllocationBps") {
            // Hard ceiling re-checked HERE, at execution, not at queue time —
            // same doctrine as _validateParams: a timelock bounds when a bad
            // change lands, never how bad it can be.
            if (q.value > CEIL_PLATFORM_ALLOCATION_BPS) revert AllocationCapExceeded();
            platformAllocationBps = q.value;
            emit ParamApplied(key, q.value);
            return;
        } else revert BadParam();

        _validateParams(p); // hard ceilings re-checked at EXECUTION, not queue
        params = p;
        emit ParamApplied(key, q.value);
    }

    /// @notice Update a constituent's weight metric (fee revenue + locked LP).
    /// Timelocked like any other economically significant parameter, and it
    /// only ever changes a target-weight VIEW — it moves no value.
    function queueMetric(address token, uint256 metric) external onlyAdmin {
        _get(token);
        bytes32 key = keccak256(abi.encodePacked("metric", token));
        uint64 eta = uint64(block.timestamp + timelockDelay);
        queuedParams[key] = QueuedParam({value: metric, eta: eta, pending: true});
        emit ParamQueued(key, metric, eta);
    }

    function executeMetric(address token) external {
        bytes32 key = keccak256(abi.encodePacked("metric", token));
        QueuedParam memory q = queuedParams[key];
        if (!q.pending) revert NothingQueued();
        if (block.timestamp < q.eta) revert TimelockNotElapsed();
        delete queuedParams[key];
        constituents[token].metric = q.value;
        emit MetricUpdated(token, q.value);
    }

    function queueListing(
        address token,
        IIndexPriceSource source,
        uint256 rawTargetWeightBps,
        bool isRemoval
    ) external onlyAdmin {
        uint64 eta = uint64(block.timestamp + timelockDelay);
        queuedListings[token] = QueuedListing({
            source: source,
            rawTargetWeightBps: rawTargetWeightBps,
            eta: eta,
            pending: true,
            isRemoval: isRemoval
        });
        emit ConstituentQueued(token, eta, isRemoval);
    }

    /**
     * @notice Apply a queued add/remove after the delay.
     * @dev Removal DEACTIVATES (target weight → 0) but never delists a
     * constituent that still holds reserves — a delisted-with-reserves leg
     * would be value stranded outside the pro-rata payout set, which is the
     * anchor rule violated by omission rather than by theft. Full delisting
     * is only possible once the reserve has been redeemed to zero, and is
     * permissionless at that point.
     */
    function executeListing(address token) external nonReentrant {
        QueuedListing memory q = queuedListings[token];
        if (!q.pending) revert NothingQueued();
        if (block.timestamp < q.eta) revert TimelockNotElapsed();
        delete queuedListings[token];

        if (q.isRemoval) {
            Constituent storage c = _get(token);
            c.active = false;
            // Start the ramp-OUT clock. Without this the target weight fell
            // off a cliff at execution; see `_rampFactorBps`.
            c.rampStart = uint64(block.timestamp);
            c.rampDuration = uint64(params.rampDuration);
            emit ConstituentDeactivated(token);
        } else {
            _list(
                token,
                q.source,
                q.rawTargetWeightBps,
                uint64(block.timestamp),
                uint64(params.rampDuration)
            );
        }
    }

    /// @notice Drop a deactivated, fully-redeemed constituent. Permissionless
    /// and only ever possible when there is nothing left to strand.
    function delistEmpty(address token) external nonReentrant {
        Constituent storage c = _get(token);
        if (c.active) revert BadParam();
        if (c.reserve != 0) revert ReservesOutstanding();
        uint256 n = constituentList.length;
        for (uint256 i = 0; i < n; i++) {
            if (constituentList[i] == token) {
                constituentList[i] = constituentList[n - 1];
                constituentList.pop();
                break;
            }
        }
        delete constituents[token];
        emit ConstituentDelisted(token);
    }

    function queueAdmin(address next) external onlyAdmin {
        if (next == address(0)) revert BadParam();
        uint64 eta = uint64(block.timestamp + timelockDelay);
        queuedAdmin = QueuedParam({value: uint256(uint160(next)), eta: eta, pending: true});
        emit AdminQueued(next, eta);
    }

    function executeAdmin() external {
        QueuedParam memory q = queuedAdmin;
        if (!q.pending) revert NothingQueued();
        if (block.timestamp < q.eta) revert TimelockNotElapsed();
        delete queuedAdmin;
        admin = address(uint160(q.value));
        emit AdminApplied(admin);
    }

    /// @notice Appoint (or retire, with address(0)) the platform treasury that
    /// receives the mint-side allocation. Timelocked like everything else, and
    /// like everything else it grants NO reach over pooled reserves: the
    /// treasury receives shares and redeems them through the identical strict
    /// pro-rata path as any other holder.
    function queuePlatformTreasury(address treasury) external onlyAdmin {
        uint64 eta = uint64(block.timestamp + timelockDelay);
        queuedPlatformTreasury = QueuedParam({
            value: uint256(uint160(treasury)),
            eta: eta,
            pending: true
        });
        emit ParamQueued("platformTreasury", uint256(uint160(treasury)), eta);
    }

    function executePlatformTreasury() external {
        QueuedParam memory q = queuedPlatformTreasury;
        if (!q.pending) revert NothingQueued();
        if (block.timestamp < q.eta) revert TimelockNotElapsed();
        delete queuedPlatformTreasury;
        platformTreasury = address(uint160(q.value));
        emit ParamApplied("platformTreasury", q.value);
    }

    /// @notice The mint-side fee a deposit of `amountIn` into `token` would
    /// pay, directional term included. Shown before signature, per
    /// CONTRIBUTING.md's pre-signature transparency rule.
    function previewMintFeeBps(address token, uint256 amountIn) external view returns (uint256) {
        return _mintFeeBps(token, _imbalanceFeeBps(amountIn, constituents[token].reserve));
    }

    /// @notice Whether `token` is frozen to NEW single-asset deposits because
    /// a removal is queued against it or already executed.
    function isExiting(address token) external view returns (bool) {
        if (!constituents[token].listed) return false;
        if (!constituents[token].active) return true;
        QueuedListing storage q = queuedListings[token];
        return q.pending && q.isRemoval;
    }

    // ══ Views ═════════════════════════════════════════════════════════════

    function constituentCount() external view returns (uint256) {
        return constituentList.length;
    }

    function constituentAt(uint256 i) external view returns (address) {
        return constituentList[i];
    }

    function listConstituents() external view returns (address[] memory) {
        return constituentList;
    }

    function reserveOf(address token) external view returns (uint256) {
        return constituents[token].reserve;
    }

    function constituentInfo(address token)
        external
        view
        returns (
            address source,
            uint256 reserve,
            uint256 metric,
            uint64 rampStart,
            uint64 rampDuration,
            bool listed,
            bool active,
            uint8 obsCount
        )
    {
        Constituent storage c = constituents[token];
        return (
            address(c.source),
            c.reserve,
            c.metric,
            c.rampStart,
            c.rampDuration,
            c.listed,
            c.active,
            c.obsCount
        );
    }

    /// @notice What a pro-rata redemption of `sharesIn` pays today. Pure math
    /// over reserves — no prices, so a UI can show it without an oracle read.
    function previewRedeemProRata(uint256 sharesIn)
        external
        view
        returns (address[] memory tokens, uint256[] memory amounts)
    {
        uint256 n = constituentList.length;
        tokens = new address[](n);
        amounts = new uint256[](n);
        uint256 denom = totalSupply() + VIRTUAL_SHARES;
        for (uint256 i = 0; i < n; i++) {
            tokens[i] = constituentList[i];
            // Mirrors redeemProRata exactly, including the deliberate
            // absence of VIRTUAL_ASSETS on the payout side.
            amounts[i] = Math.mulDiv(sharesIn, constituents[tokens[i]].reserve, denom);
        }
    }

    function previewMintProRata(uint256 sharesOut)
        external
        view
        returns (address[] memory tokens, uint256[] memory amounts)
    {
        uint256 n = constituentList.length;
        tokens = new address[](n);
        amounts = new uint256[](n);
        uint256 denom = totalSupply() + VIRTUAL_SHARES;
        for (uint256 i = 0; i < n; i++) {
            tokens[i] = constituentList[i];
            amounts[i] = Math.mulDiv(
                sharesOut,
                constituents[tokens[i]].reserve + VIRTUAL_ASSETS,
                denom,
                Math.Rounding.Up
            );
        }
    }

    /// @notice What a single-asset exit of `sharesIn` into `token` pays,
    /// imbalance fee already deducted. Shown before signature, per
    /// CONTRIBUTING.md's pre-signature transparency rule.
    function previewRedeemSingleAsset(uint256 sharesIn, address token)
        external
        view
        returns (uint256)
    {
        return _previewSingleExit(sharesIn, token);
    }

    function imbalanceFeeBps(uint256 amount, uint256 against) external view returns (uint256) {
        return _imbalanceFeeBps(amount, against);
    }

    function capabilities()
        external
        pure
        returns (bool proRataInKind, bool bandedNav, bool timelocked, uint256 version)
    {
        return (true, true, true, INDEX_VERSION);
    }

    // ══ Internals ═════════════════════════════════════════════════════════

    function _get(address token) private view returns (Constituent storage c) {
        c = constituents[token];
        if (!c.listed) revert NotListed();
    }

    function _list(
        address token,
        IIndexPriceSource source,
        uint256 rawTargetWeightBps,
        uint64 rampStart,
        uint64 rampDuration
    ) private {
        if (token == address(0) || address(source) == address(0)) revert BadParam();
        if (rawTargetWeightBps > BPS) revert BadParam();
        Constituent storage c = constituents[token];
        if (c.listed) revert AlreadyListed();
        if (constituentList.length >= MAX_CONSTITUENTS) revert TooManyConstituents();

        c.source = source;
        c.rawTargetWeightBps = rawTargetWeightBps;
        c.metric = rawTargetWeightBps; // seeded; refined via queueMetric
        c.rampStart = rampStart;
        c.rampDuration = rampDuration;
        c.listed = true;
        c.active = true;
        constituentList.push(token);
        _observe(token, c, true);
        emit ConstituentListed(token, address(source), rawTargetWeightBps);
    }

    /// @dev Read the ACTUAL balance delta, never the nominal amount (§2.9,
    /// Balancer STA). Returns what was really credited.
    function _pullCredited(IERC20 token, address from, uint256 amount)
        private
        returns (uint256 credited)
    {
        uint256 before = token.balanceOf(address(this));
        token.safeTransferFrom(from, address(this), amount);
        credited = token.balanceOf(address(this)) - before;
        if (credited == 0) revert ZeroAmount();
    }

    /**
     * @dev The single-asset exit, computed exactly as Balancer decomposes a
     * non-proportional exit:
     *   1. the SAME strict pro-rata payout as `redeemProRata`, computed
     *      virtually for every constituent (identical expression, floored);
     *   2. the non-target legs valued at their band LOW (undervalue what the
     *      redeemer gives up) and converted into target units at the target's
     *      band HIGH (overvalue what they receive) — conservative on both
     *      sides of the internal swap, so a round trip is never free;
     *   3. a Curve-`remove_liquidity_one_coin`-style imbalance fee on the
     *      swapped portion only. The pro-rata portion is always free, which is
     *      what keeps the balanced path strictly cheaper than the concentrated
     *      one for every input.
     */
    function _previewSingleExit(uint256 sharesIn, address token)
        private
        view
        returns (uint256 amountOut)
    {
        Constituent storage target = _get(token);
        (, uint256 targetHi, ) = priceBand(token);
        (uint256 targetLo, , ) = priceBand(token);
        if (targetHi == 0 || targetLo == 0) revert StalePrice();

        uint256 denom = totalSupply() + VIRTUAL_SHARES;
        uint256 proRataTarget = Math.mulDiv(sharesIn, target.reserve, denom);

        uint256 otherEth;
        uint256 n = constituentList.length;
        for (uint256 i = 0; i < n; i++) {
            address t = constituentList[i];
            if (t == token) continue;
            (uint256 lo, , ) = priceBand(t);
            uint256 v = Math.mulDiv(sharesIn, constituents[t].reserve, denom);
            otherEth += Math.mulDiv(v, lo, WAD);
        }

        uint256 extra = Math.mulDiv(otherEth, WAD, targetHi);
        uint256 remaining = target.reserve > proRataTarget ? target.reserve - proRataTarget : 0;
        if (remaining == 0) revert ReserveWouldEmpty();
        extra -= (extra * _imbalanceFeeBps(extra, remaining)) / BPS;
        amountOut = proRataTarget + extra;
    }

    /**
     * @dev Curve-flavoured imbalance fee: free at the margin, steeper the more
     * concentrated the ask. `d` is the requested amount as a fraction of what
     * the constituent has left, in bps; the fee is base + slope*d, capped.
     * A withdrawal that takes 100% of the remaining leg pays base + slope.
     */
    function _imbalanceFeeBps(uint256 amount, uint256 against) private view returns (uint256 fee) {
        if (against == 0) return params.maxImbalanceFeeBps;
        uint256 d = (amount * BPS) / against;
        if (d > BPS) d = BPS;
        fee = params.baseImbalanceFeeBps + (params.imbalanceSlopeBps * d) / BPS;
        if (fee > params.maxImbalanceFeeBps) fee = params.maxImbalanceFeeBps;
    }

    /**
     * @dev The hard concentration cap, enforced in the only form an on-chain
     * check honestly can. A constituent's NAV weight also moves when its own
     * market price moves, which no vault operation caused and no vault
     * operation can prevent — so a flat "weight <= cap always" invariant would
     * simply brick the basket the first time a constituent rallied. What IS
     * enforceable, and what actually bounds blast radius, is that no basket
     * OPERATION may push a constituent further over the cap. Above the cap the
     * only permitted operations are ones that reduce the breach.
     */
    function _requireCapNotWorsened(uint256[] memory weightsBefore) private view {
        uint256[] memory now_ = _allWeightsBps();
        uint256 cap = params.concentrationCapBps;
        for (uint256 i = 0; i < now_.length; i++) {
            if (now_[i] > cap && now_[i] > weightsBefore[i]) revert ConcentrationCapExceeded();
        }
    }

    /// @dev Every constituent's share of NAV_low in one O(n) pass. Calling
    /// `weightBps` per leg would be O(n^2) — it recomputes NAV each time.
    function _allWeightsBps() private view returns (uint256[] memory w) {
        uint256 n = constituentList.length;
        w = new uint256[](n);
        uint256[] memory v = new uint256[](n);
        uint256 navLow;
        for (uint256 i = 0; i < n; i++) {
            address t = constituentList[i];
            (uint256 lo, , ) = priceBand(t);
            v[i] = Math.mulDiv(constituents[t].reserve, lo, WAD);
            navLow += v[i];
        }
        if (navLow == 0) return w;
        for (uint256 i = 0; i < n; i++) w[i] = (v[i] * BPS) / navLow;
    }

    /// @dev Above `largeOpValueWei`, a constituent's band must have HELD
    /// across independent checkpoints before the basket prices against it —
    /// and across MORE of them the larger the operation is (see
    /// `requiredCheckpoints`).
    function _requirePersistenceIfLarge(address token, uint256 ethValue) private view {
        if (ethValue < params.largeOpValueWei) return;
        if (!persistenceHoldsFor(token, requiredCheckpoints(ethValue))) {
            revert PersistenceCheckFailed();
        }
    }

    /**
     * @dev RAMP-OUT IS REDEMPTION-ONLY. The instant a removal is QUEUED — not
     * when it executes, the instant it is queued and therefore public — the
     * constituent stops accepting new single-asset deposits. Existing holders
     * keep every exit they had: `redeemProRata` and `redeemSingleAsset` are
     * untouched for the whole ramp-out and beyond.
     *
     * The gap this closes is a real one. Between queue and execution there is
     * a full timelock in which the removal is public knowledge; without this
     * check a constituent that is being removed BECAUSE it is broken stays
     * open for deposits for the entire window, and the last people in hold a
     * leg the basket has already decided to unwind.
     *
     * Deliberately NOT applied to `mintProRata`. That path is strictly
     * proportional: the depositor cannot choose to enter the exiting leg, they
     * enter every leg at the ratio the basket already holds, and refusing it
     * would shut the basket's primary, no-oracle entry point for the whole
     * timelock plus ramp — a liveness cost paid by everyone to prevent a
     * concentration nobody can actually choose. The freeze belongs on the path
     * where "newly enter THIS constituent" is a thing you can ask for.
     */
    function _requireNotExiting(address token, Constituent storage c) private view {
        if (!c.active) revert ConstituentExiting();
        QueuedListing storage q = queuedListings[token];
        if (q.pending && q.isRemoval) revert ConstituentExiting();
    }

    /**
     * @dev Mint `grossShares` in total, splitting off the platform allocation.
     * Returns what `to` actually received.
     *
     * The two `_mint` calls sum to EXACTLY `grossShares`, which is what makes
     * existing holders' NAV-per-share provably unaffected: the denominator
     * moves by the same amount it would have moved with the allocation at
     * zero. Rounding on the cut floors, so an ambiguous base unit goes to the
     * depositor rather than the operator — the conservative direction is the
     * one that favours the party who did not set the parameter.
     */
    function _mintWithAllocation(address to, uint256 grossShares) private returns (uint256) {
        address treasury = platformTreasury;
        uint256 bps = platformAllocationBps;
        if (treasury == address(0) || bps == 0) {
            _mint(to, grossShares);
            return grossShares;
        }
        uint256 cut = (grossShares * bps) / BPS; // floors, in the depositor's favour
        uint256 net = grossShares - cut;
        if (net == 0) revert ZeroAmount();
        _mint(to, net);
        if (cut > 0) _mint(treasury, cut);
        return net;
    }

    /**
     * @dev DIRECTIONAL mint-side imbalance fee, layered on top of the
     * depth-based fee `_imbalanceFeeBps` already charges.
     *
     * A deposit into an UNDERWEIGHT constituent moves the basket toward its
     * target vector, so it is discounted; a deposit into an OVERWEIGHT one
     * moves it away, so it is surcharged. Both are measured against the same
     * `targetWeightsBps()` vector the rest of the contract publishes, so there
     * is no second, private notion of "correct" anywhere.
     *
     * TWO CONSERVATIVE CHOICES, both resolved in existing holders' favour
     * where the spec left the edge open (§2.9 doctrine):
     *
     *  1. The discount FLOORS AT `baseImbalanceFeeBps` and can never reach
     *     zero, let alone go negative. A true negative fee — paying someone to
     *     rebalance — would be a transfer from the pool to a depositor, i.e.
     *     an externalisation path, i.e. exactly the class of thing §2.8's
     *     anchor rule exists to keep off this contract. Rebalancing is
     *     rewarded by charging less, never by paying out.
     *  2. A constituent with a ZERO target weight (ramping in from t=0, or a
     *     leg whose metric is unset) pays the maximum. Unknown is treated as
     *     overweight, never as underweight.
     *
     * The redeem side keeps its existing DEPTH-based fee and is deliberately
     * not changed here: its properties (monotone in size, strictly worse than
     * pro-rata, retained in reserves) are directly asserted by the audit suite
     * and are the reason the single-asset exit is safe. Adding a directional
     * term there is a separate change with its own proofs to redo, and
     * bundling it into this one would put a proven exit path at risk to
     * improve a convenience.
     */
    function _mintFeeBps(address token, uint256 depthFee) private view returns (uint256) {
        (address[] memory tokens, uint256[] memory target) = targetWeightsBps();
        uint256[] memory current = _allWeightsBps();
        uint256 idx = type(uint256).max;
        for (uint256 i = 0; i < tokens.length; i++) {
            if (tokens[i] == token) {
                idx = i;
                break;
            }
        }
        if (idx == type(uint256).max) return params.maxImbalanceFeeBps;

        uint256 t = target[idx];
        if (t == 0) return params.maxImbalanceFeeBps; // unknown target => max
        uint256 cur = current[idx];

        if (cur < t) {
            // UNDERWEIGHT: discount, proportional to how far below target it
            // sits, floored at the base fee.
            uint256 gap = ((t - cur) * BPS) / t; // 0..BPS
            uint256 relief = (depthFee * gap) / BPS;
            uint256 fee = depthFee > relief ? depthFee - relief : 0;
            return fee < params.baseImbalanceFeeBps ? params.baseImbalanceFeeBps : fee;
        }

        // OVERWEIGHT: surcharge on the same slope the depth fee uses, capped.
        uint256 over = ((cur - t) * BPS) / t;
        if (over > BPS) over = BPS;
        uint256 up = depthFee + (params.imbalanceSlopeBps * over) / BPS;
        return up > params.maxImbalanceFeeBps ? params.maxImbalanceFeeBps : up;
    }

    function _validateParams(Params memory p) private pure {
        if (
            p.concentrationCapBps < MIN_CONCENTRATION_CAP_BPS ||
            p.concentrationCapBps > MAX_CONCENTRATION_CAP_BPS
        ) revert BadParam();
        if (p.maxImbalanceFeeBps > CEIL_IMBALANCE_FEE_BPS) revert BadParam();
        if (p.baseImbalanceFeeBps > p.maxImbalanceFeeBps) revert BadParam();
        if (p.imbalanceSlopeBps > CEIL_IMBALANCE_FEE_BPS) revert BadParam();
        if (p.bandBps > CEIL_BAND_BPS) revert BadParam();
        if (p.priceCapBps == 0 || p.priceCapBps > CEIL_PRICE_CAP_BPS) revert BadParam();
        if (p.minCheckpointInterval == 0 || p.minCheckpointInterval > 1 days) revert BadParam();
        if (p.staleAfter < p.minCheckpointInterval * 2 || p.staleAfter > 30 days) revert BadParam();
        if (p.persistenceCheckpoints < 2 || p.persistenceCheckpoints > OBS_SLOTS) revert BadParam();
        if (p.persistenceToleranceBps == 0 || p.persistenceToleranceBps > BPS) revert BadParam();
        if (p.largeOpValueWei == 0) revert BadParam();
        if (p.rampDuration < MIN_RAMP_DURATION || p.rampDuration > MAX_RAMP_DURATION) {
            revert BadParam();
        }
    }
}
