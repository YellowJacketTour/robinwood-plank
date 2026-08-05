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
import {ScopedRoles} from "./ScopedRoles.sol";
import {IndexMath} from "./lib/IndexMath.sol";
import {Observation, Constituent, OBS_SLOTS as TYPES_OBS_SLOTS} from "./lib/IndexTypes.sol";
import {IndexValuation} from "./lib/IndexValuation.sol";
import {IndexOracle} from "./lib/IndexOracle.sol";
import {IndexEligibility} from "./lib/IndexEligibility.sol";
// The parameter SET itself is declared in IndexParams.sol and imported under
// this contract's historical name, so the key-space dispatch can be moved out
// of this bytecode without an encode/decode shim at the boundary. Field order
// and the public `params()` getter's ABI are unchanged.
import {IndexParams, IndexParamSet as Params} from "./lib/IndexParams.sol";

/**
 * @notice The two functions this vault needs from an ecosystem fee sink, and
 * NOTHING else. Deliberately a two-function interface over
 * a sink rather than an import of one: the vault must not
 * acquire a compile-time dependency on — or an ABI-level reach into — a
 * contract that holds its own funds. `reinvestAsset()` is read ONCE, at the
 * timelocked appointment, to pin which constituent this vault is allowed to
 * divert (see `executeEcosystemSink`); `receiveDividendsWrapped` is a PUSH the
 * sink pulls from an allowance, so the vault never hands it an open approval.
 */
interface IEcosystemFeeSink {
    function reinvestAsset() external view returns (address);
    function receiveDividendsWrapped(uint256 amount) external;
}

contract GlobalIndexVault is ERC20, ReentrancyGuard, ScopedRoles {
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

    /// @dev Ring buffer depth. Declared in IndexTypes.sol, where it fixes the
    /// `Constituent.obs` array's storage shape, and re-exported here under the
    /// name the rest of this file has always used.
    uint256 private constant OBS_SLOTS = TYPES_OBS_SLOTS;

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
    // The risk-parameter ceilings themselves now live in IndexParams.sol,
    // next to the validator that enforces them — one file, one set of
    // constants, so a ceiling cannot be raised in one place and left in the
    // other. They are compile-time constants there exactly as they were here.
    /// @dev Absolute ceiling on the platform/operator share allocation. 5%.
    /// Compile-time, so no admin and no timelock can raise it.
    uint256 private constant CEIL_PLATFORM_ALLOCATION_BPS = 500;
    /// @dev Value the allocation is born at. 2% — the low end of the range
    /// index products actually charge, and chosen at the low end deliberately:
    /// an operator cut is the one parameter in this contract whose default
    /// should favour the depositor, since the depositor is the party who did
    /// not vote on it. It is inert until a treasury is appointed anyway.
    uint256 private constant DEFAULT_PLATFORM_ALLOCATION_BPS = 200;

    /**
     * @dev ECOSYSTEM FEE SPLIT — hard ceiling and default.
     *
     * The imbalance fee has always been retained in reserves, where it lifts
     * NAV per share for everyone who stayed. `ecosystemFeeSplitBps` is the
     * fraction of that fee — and ONLY of that fee, never of principal — that
     * is instead booked to a SEGREGATED per-token ledger for the ecosystem
     * sink. The ceiling is 30%, so a supermajority of the fee is retained for
     * NAV appreciation no matter what governance does; the default is 20%.
     *
     * The trade-off is deliberately NOT hidden: with the sink appointed and
     * the split at 20%, existing holders get 80% of the NAV lift they would
     * have got with the whole fee retained. They are never WORSE off than
     * before a priced operation — per-share backing is still non-decreasing on
     * both priced paths, which the audit suite asserts directly — they simply
     * capture less of the upside, and the other 20% pays the holders who
     * staked into the dividend distributor. That is a distribution choice
     * between two groups of holders, made in the open by a timelocked
     * parameter with a compile-time ceiling, not a withdrawal path.
     */
    uint256 private constant CEIL_ECOSYSTEM_SPLIT_BPS = 3_000;
    uint256 private constant DEFAULT_ECOSYSTEM_SPLIT_BPS = 2_000;

    // ── Part D: dynamic HHI-derived concentration cap ──────────────────────
    /// @dev Target basket HHI as a fraction of BPS. 2_000 = HHI 2000/10000 =
    /// 0.20, the level at which US antitrust guidelines call a market
    /// "moderately concentrated" and the same level index methodologies
    /// (UCITS 5/10/40, S&P capped indices) sit near. Timelocked, ceilinged.
    uint256 private constant DEFAULT_TARGET_HHI_BPS = 2_000;
    /// @dev An HHI target of 1.0 is "no constraint"; below ~2% no basket of
    /// realistic size can satisfy it and the cap degenerates to equal weights.
    uint256 private constant MIN_TARGET_HHI_BPS = 200; // 0.02
    uint256 private constant MAX_TARGET_HHI_BPS = BPS; // 1.00, i.e. unconstrained

    // ── Part E: realized-variance persistence calibration ──────────────────
    /// @dev The LONG calibration window. Structurally separate from — and, at
    /// 90 days against a `minCheckpointInterval` measured in minutes, three
    /// to four ORDERS OF MAGNITUDE harder to move than — the short
    /// persistence window it scales. See `realizedVolBps`.
    uint256 private constant VARIANCE_WINDOW = 90 days;
    /// @dev One extra required checkpoint per this much RMS per-checkpoint
    /// move. 100 bps = 1%.
    uint256 private constant VOL_STEP_BPS = 100;
    /// @dev HARD floor and ceiling on the adaptive requirement. Compile-time,
    /// so no admin, no timelock, and no manipulation of the calibration window
    /// can drive the requirement to zero or to infinity. The ceiling is the
    /// ring-buffer depth because a requirement deeper than the retained
    /// history is unsatisfiable and would brick the priced paths outright.
    uint256 private constant MIN_REQUIRED_CHECKPOINTS = 2;
    uint256 private constant MAX_REQUIRED_CHECKPOINTS = OBS_SLOTS;
    /// @dev Gas cap on every eligibility read. A hostile constituent must not
    /// be able to out-of-gas a whole-basket recount.
    uint256 private constant ELIGIBILITY_GAS_CAP = 50_000;

    /**
     * @dev Gas ceiling on ONE fault-tolerant redemption leg. Identical value
     * and identical reasoning to `WrappedIndexShare.PAYOUT_GAS`, which is the
     * implementation this contract's exit door is now a port of: generous for
     * an ERC-20 `transfer` including a blacklist or allowlist check (a plain
     * transfer is ~50k), and low enough that MAX_CONSTITUENTS legs cannot
     * approach a block. The 63/64 rule is what makes the bound real — a
     * hostile constituent cannot consume the gas the remaining legs need. A
     * legitimate token too heavy for this still pays out in full through
     * `claimPending`, which forwards everything it has.
     */
    uint256 private constant PAYOUT_GAS = 250_000;

    // ── Types ──────────────────────────────────────────────────────────────

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

    // ── Scoped administration roles (see ScopedRoles.sol) ──────────────────
    //
    // There is NO blanket admin. Each role below sets FUTURE parameters only,
    // within its own enumerated scope, and none of them — separately or all
    // four colluding — has a withdrawal path or any way to block a redemption.

    /// @notice Admits, removes and re-weights constituents: `queueListing`,
    /// `queueMetric`. Cannot touch risk parameters or the platform cut.
    bytes32 public constant ROLE_CONSTITUENT_ADMISSION = "vault.admission";

    /// @notice Tunes the risk surface: concentration cap, HHI target, fee
    /// band/slope/ceiling, persistence calibration, staleness, ramp duration,
    /// and the two eligibility bars. Cannot admit a constituent and cannot
    /// touch the platform cut.
    bytes32 public constant ROLE_RISK_PARAM = "vault.risk";

    /// @notice The ONLY role over the operator-facing value flow:
    /// `platformAllocationBps` and the `platformTreasury` appointment. Kept
    /// separately keyed precisely because it is the one parameter surface
    /// that redirects newly minted shares to an operator — even though it can
    /// never touch reserves or existing holders' NAV per share.
    bytes32 public constant ROLE_PLATFORM_ALLOCATION = "vault.allocation";

    /// @notice Seeds the basket before it opens; zero privilege after (§2.1).
    address public immutable seeder;

    /// @notice One-way. While false only seeding works; once true, forever.
    bool public indexOpen;

    Params public params;

    address[] private constituentList;
    mapping(address => Constituent) private constituents;

    /**
     * @notice ── THE EXIT DOOR'S FAULT TOLERANCE (round 10, and the single
     * most important guarantee on this contract) ──
     *
     * Guarantee 1 in this file's header says redemption is strict pro-rata
     * in-kind and that no role can block it. That was true of every ROLE and
     * false of every unprivileged party, which is worse: one constituent whose
     * `transfer` reverts — a blacklist landing on one specific holder, a pause,
     * an upgrade — took the ENTIRE redemption down with it, for ALL legs, for
     * that holder, with no recovery. `delistEmpty` needs `reserve == 0` and the
     * only path to zero was the loop that was bricked, so the deadlock closed.
     *
     * The fix is not a new guard and not a new privilege. It is the EXACT
     * fault-tolerant payout pattern `WrappedIndexShare._payout` already proved
     * safe in this codebase, ported here one for one:
     *
     *   1. every leg's amount is computed from PRE-BURN reserves before any
     *      transfer is attempted, so no leg's success or failure can change
     *      another leg's size;
     *   2. the burn happens once, and every reserve is debited, before any
     *      external call — checks-effects-interactions across the whole basket
     *      rather than per leg;
     *   3. each leg is paid through a bounded-gas, NON-REVERTING low-level
     *      call. A leg that fails for any reason at all is credited to
     *      `pendingClaim[holder][token]` and counted in `reservedClaims[token]`
     *      instead of reverting the redemption.
     *
     * WHY THE DEFERRED AMOUNT CANNOT BE REDEEMED TWICE. `reserve` was already
     * debited in step 2, so a deferred leg is out of the pro-rata pool the
     * instant it is deferred — the remaining holders' slice is computed against
     * a reserve that no longer contains it. `reservedClaims` is the SECOND half
     * of that statement: it is the ledger of value that is physically held by
     * this contract but owed to a named holder, and it is what
     * `syncConstituentBalance` subtracts so an unaccounted-balance sweep can
     * never re-credit a deferred claim back into `reserve`. Same role as
     * `WrappedIndexShare.reserved`, same arithmetic.
     *
     * Retry is `claimPending` (loud, full gas) or `claimPendingMany` (batched,
     * tolerant). Neither is gated on listing, on `indexOpen`, or on any role:
     * a credit survives its constituent being deactivated and delisted, which
     * is the whole point of holding it outside `reserve`.
     */
    mapping(address => mapping(address => uint256)) public pendingClaim;

    /// @notice Per-token total of `pendingClaim`, i.e. held-but-owed balance.
    /// Never part of `reserve`, never part of NAV, never redeemable by anyone
    /// but the holder it is credited to.
    mapping(address => uint256) public reservedClaims;

    mapping(bytes32 => QueuedParam) public queuedParams;
    mapping(address => QueuedListing) public queuedListings;
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

    /**
     * @notice SEGREGATED ECOSYSTEM-FEE LEDGER (the MarketplankVaultV3
     * `accruedFees` pattern, applied per-token).
     *
     * V3 solved exactly this problem once already and the solution is copied
     * here rather than reinvented: fees live in their OWN ledger, are added to
     * with `+=` at the instant of collection, are never mixed into the backing
     * reserve, are never counted by any valuation view, and leave only through
     * one permissionless function with a fixed destination.
     *
     * The four properties that make this safe, each asserted by the suite:
     *
     *  1. `ecosystemFeesWei[t]` is NEVER read by `nav()`, `priceBand()`,
     *     `weightBps()`, `_allWeightsBps()` or `targetWeightsBps()`. Those all
     *     read `constituents[t].reserve` and nothing else, unchanged.
     *  2. `redeemProRata` pays `floor(s * reserve_k / (S + V))` against
     *     `reserve_k` alone, exactly as before. A redeemer receives BIT-FOR-BIT
     *     the same amounts whether this ledger holds zero or a fortune. This
     *     is the exit door and this feature does not go near it.
     *  3. Nothing ever moves FROM `reserve` TO this ledger after the fact. The
     *     only writes are at fee-collection time, out of the fee the operation
     *     itself charged, before that fee was ever added to the reserve.
     *  4. Only the constituent pinned by `ecosystemAsset` can ever accrue,
     *     and that is by construction the sink's own `reinvestAsset` — so
     *     every wei booked here is harvestable by anyone, immediately. There
     *     is no "accrued in a token nothing can spend" state to strand.
     *
     * INERT BY DEFAULT: with `ecosystemSink` unset (address(0)) no accrual
     * happens on any path and every priced operation behaves bit-for-bit as it
     * did before this feature existed.
     */
    mapping(address => uint256) public ecosystemFeesWei;

    /// @notice The appointed sink. In practice THIS CONTRACT — it implements
    /// the whole two-function `IEcosystemFeeSink` surface itself, so the
    /// harvest can be pointed here and fund holders' dividends directly with
    /// no second contract in the path. An external sink remains appointable,
    /// and that branch of `harvestEcosystemFees` is unchanged.
    /// Timelocked, and it is a DESTINATION, not a permission: it can call
    /// nothing on this contract and reach no reserve.
    address public ecosystemSink;

    /// @notice The ONE constituent whose imbalance fee may be split, pinned to
    /// `ecosystemSink.reinvestAsset()` at appointment time. See
    /// `executeEcosystemSink` for why this is read once and stored rather than
    /// consulted live.
    address public ecosystemAsset;

    /// @notice Fraction of the imbalance fee diverted to `ecosystemFeesWei`,
    /// in bps. Timelocked, ceilinged at `CEIL_ECOSYSTEM_SPLIT_BPS`.
    uint256 public ecosystemFeeSplitBps;

    /**
     * @notice ── ON-CHAIN DIVIDEND ACCRUAL, TO HOLDERS, WITH NO STAKING ──
     *
     * WHY THIS LIVES HERE AND NOT IN A SECOND CONTRACT (the design decision,
     * and it reverses an earlier one in this repo — deliberately, and with the
     * old argument answered rather than ignored).
     *
     * `IndexDividendDistributor.sol` used to hold this, on two stated grounds.
     * Both are addressed, not waived:
     *
     *  1. "The vault must not be an ETH custodian, because its own suite
     *     asserts it cannot hold ETH at all — no `receive`, no payable path."
     *     That property is UNCHANGED and still asserted. This mechanism is
     *     denominated in an ERC-20, `dividendAsset`, not in raw ETH. There is
     *     still no `receive()` and still no payable function on this contract.
     *     Nothing was traded away, because the fee flow that funds this was
     *     ALREADY WETH-denominated — `harvestEcosystemFees` pushes WETH, and
     *     the old distributor's only reason to hold ETH was that it unwrapped
     *     that WETH on arrival so it could re-pay it as ETH. Unwrapping in
     *     order to pay out something the payer will usually re-wrap is
     *     ceremony, and dropping it removes an ETH custodian from the design
     *     instead of adding one. A holder who wants ETH calls `WETH.withdraw`
     *     themselves; that is one call, trustless, and it was already implicit.
     *
     *  2. "A transfer hook on the share token would hand an admin a share
     *     FREEZE: point the hook at something that reverts and every transfer,
     *     mint and redeem bricks — and a redeem burns shares, so freezing
     *     redemption is the anchor rule violated from the other side."
     *     That objection is exactly right, and it is an objection to a hook
     *     that CALLS OUT to an admin-settable address. This hook calls nothing.
     *     It is arithmetic over this contract's own storage — one SLOAD, two
     *     SSTOREs, no external call, no address to point anywhere, and no
     *     parameter that can make it fail. There is no lever to hand anyone,
     *     which is a stronger statement than "the lever is guarded".
     *
     *     That is also precisely why routing this through a separate contract
     *     is the WORSE option now rather than the safer one: to keep the
     *     accounting correct without staking, SOMETHING has to run on every
     *     balance change, and only the contract that owns the balances can do
     *     that without an external call. A cross-contract hook would put a
     *     third-party call on every transfer of this token — including
     *     third-party DEX trades — and would re-create the freeze lever the
     *     old header rightly refused. Collapsing it inward removes a contract,
     *     removes a trust boundary, and removes the external call at once.
     *
     * THE MECHANISM (EIP-2222 FundsDistributionToken / "magnified dividend per
     * share", the same shape as Compound's checkpointed vote weight).
     *
     * One global accumulator, and one per-holder CORRECTION term:
     *
     *     accumulativeOf(a) = (magnifiedDividendPerShare * balanceOf(a)
     *                          + magnifiedDividendCorrections[a]) / MAGNITUDE
     *     withdrawableOf(a) = accumulativeOf(a) - withdrawnDividends[a]
     *
     * On every balance change of `value`, the hook adds
     * `magnifiedDividendPerShare * value` to the SENDER's correction and
     * subtracts it from the RECEIVER's. That is the whole trick, and what it
     * buys is the property the design is for: `accumulativeOf(a)` is invariant
     * across the transfer itself, so a buyer cannot reach back for a
     * distribution that predates them and a seller keeps every wei that
     * accrued while they held. Mint is the `from == address(0)` case and burn
     * is the `to == address(0)` case of the same identity, so a REDEEMER's
     * accrued dividend survives their shares being burned to zero — the
     * entitlement is for value already earned, not a function of what they
     * still hold.
     *
     * No snapshot. No Merkle root and therefore no publisher to trust — which
     * is a genuine and not merely rhetorical improvement over the rejected
     * root design: there is no off-chain input to this mechanism at all, so
     * there is no party who could publish a wrong one. No staking, so no
     * custody transfer and no illiquidity. No holder list, so nothing iterates
     * and gas is O(1) everywhere. Holders do nothing but hold.
     *
     * THE SEED'S SHARE IS EXCLUDED, EXACTLY. The permanently-locked seed at
     * `SEED_LOCK` can never claim, so crediting it would strand a slice of
     * every distribution forever. The push therefore divides by
     * `totalSupply() - balanceOf(SEED_LOCK)` and immediately cancels the
     * seed's own accrual through the same correction term, in O(1). The
     * conservation identity still closes: the corrections sum to
     * `-magnifiedDividendPerShare * seedBalance`, so the sum of every holder's
     * accumulative is `magnifiedDividendPerShare * eligibleSupply / MAGNITUDE`
     * — which is what was actually received, minus flooring dust.
     *
     * THE CEILING, AND WHY IT IS STRUCTURAL. Every division here floors, so a
     * push credits marginally LESS than it delivered and the remainder stays
     * in this contract forever. Total withdrawable across all holders is
     * therefore bounded above by total received, always, with no admin action
     * and no monitoring — the randomized suite asserts it directly.
     *
     * INERT BY DEFAULT: with `dividendAsset` unset (address(0)) there is no
     * push path at all, the accumulator is permanently zero, and the hook's arithmetic
     * is a no-op on a zero accumulator.
     */
    /// @notice The ERC-20 dividends are denominated in. IMMUTABLE on purpose:
    /// a mutable dividend denomination is a mutable definition of what every
    /// outstanding, already-accrued claim is worth, and retargeting it would
    /// strand claims in the old asset. There is no governance lever over this
    /// and no timelocked key for it — the answer to "who can change what my
    /// accrued dividend is paid in" is nobody.
    address public immutable dividendAsset;

    /**
     * @dev The magnification constant, 2**64.
     *
     * NOT 2**128, and the reason is a real trade rather than a preference. The
     * hook multiplies `magnifiedDividendPerShare` by a transfer amount, and
     * that product must not overflow `int256` — because if it ever could, a
     * legitimate transfer of the share token would revert, which is the one
     * failure this mechanism is forbidden to have. 2**64 buys ~19 decimal
     * digits of sub-wei precision, which is far more than a wei-denominated
     * distribution needs, and it leaves 2**191 of headroom for the product.
     * The remaining headroom is then pinned by two compile-time bounds
     * (`MAX_MAGNIFIED_PER_SHARE`, `MAX_SHARE_SUPPLY`) so the hook's arithmetic
     * is provably in range rather than merely unlikely to leave it.
     */
    uint256 private constant MAGNITUDE = 2 ** 64;

    /// @dev Absolute ceiling on the accumulator. It is what makes the transfer
    /// hook's overflow argument a proof rather than an estimate, and it is
    /// never enforced by REVERTING — see `MAX_PUSH_HEADROOM_DIVISOR`.
    uint256 private constant MAX_MAGNIFIED_PER_SHARE = 2 ** 126;

    /**
     * @dev ── THE ACCUMULATOR CANNOT BE POISONED IN ONE TRANSACTION (round 10)
     *
     * THE FINDING (AuditPoC IDX-01/IDX-01b). `magnifiedDividendPerShare` is
     * monotonically non-decreasing with no reset anywhere, and the ceiling used
     * to be enforced by REVERTING the push. So an unprivileged actor could:
     * mint ONE base unit while the eligible supply was otherwise zero (the seed
     * is excluded by design, so the divisor became exactly 1), push
     * `pot = 2**62` — about 4.6 whole tokens, not a whale and not a flash loan
     * — and land `delta = pot * MAGNITUDE / 1 = 2**126` EXACTLY on the ceiling
     * in a single transaction. They then claimed the whole push straight back,
     * so their net cost was gas. After that every future push reverted forever,
     * and because `harvestEcosystemFees` routes through the same accumulator,
     * the segregated ecosystem-fee ledger was permanently trapped too.
     *
     * THE FIX — two changes, and the first is the one that matters.
     *
     * 1. CAP THE PER-PUSH DELTA AT A FIXED FRACTION OF THE REMAINING HEADROOM,
     *    `room / 2**32`. This is what makes the ONE-TRANSACTION attack
     *    impossible rather than merely expensive: exhausting the accumulator
     *    now takes on the order of 2**32 — over four billion — separate
     *    transactions, which is not a cost, it is an impossibility. It also
     *    inverts the attack's economics outright: the attacker above now has
     *    `2**94` applied instead of `2**126`, so of the `2**62` they pushed
     *    they can claim back only `2**30`. Poisoning went from free to
     *    self-destructive.
     *
     * 2. NEVER REVERT. The unaccommodated REMAINDER of the pot — not the whole
     *    pot, just the fraction that did not fit — is held in
     *    `undistributedDividends` and folded into a future push, which is the
     *    same "carry" discipline `WrappedIndexShare.carry` already uses for the
     *    zero-denominator case and which `undistributedDividends` was already
     *    doing for `eligible == 0`. A legitimate push is therefore never lost
     *    and never refused; at worst it is partially deferred until the
     *    eligible supply grows and the delta it implies is ordinary again. That
     *    is self-healing: the deferral condition is "the implied per-share
     *    amount is astronomically large", which is exactly the condition a
     *    growing supply removes.
     *
     * DOES THE CEILING STILL ARRIVE ORGANICALLY? No, and the arithmetic is
     * worth stating rather than asserting. A real push against a real supply —
     * say one whole token spread over a thousand whole shares — implies a delta
     * around `2**64 / 1000`, roughly `1.8e16`. A single step of headroom at a
     * fresh accumulator is `2**126 / 2**32 = 2**94`, roughly `2e28`: TWELVE
     * ORDERS OF MAGNITUDE larger. Reaching the ceiling by ordinary use would
     * take on the order of `1e21` pushes. So no periodic re-basing or
     * "compaction" mechanism is introduced here, and that is a deliberate
     * choice: a mechanism that could move the accumulator DOWN would have to
     * move every holder's correction term with it, which is O(holders) — the
     * one thing this whole design exists to avoid — and it would be new
     * privileged machinery guarding against a state no honest timeline reaches.
     * The cheap attack is closed; the expensive non-attack is left alone.
     *
     * The `step == 0` fallback (`room` smaller than the divisor, i.e. an
     * accumulator already within `2**-32` of full) is deliberate: at that point
     * there is nothing left to protect, and clamping the step to zero instead
     * would strand every subsequent push in the carry forever.
     */
    uint256 private constant MAX_PUSH_HEADROOM_DIVISOR = 2 ** 32;

    /// @dev Mint-side ceiling on total share supply, for the same reason. At
    /// 2**128 base units this is ~3.4e20 whole shares and is unreachable by
    /// any real deposit; it exists to make the overflow argument a proof
    /// instead of an estimate. It gates MINTS only — it can never block a
    /// transfer, a burn, or a redemption.
    uint256 private constant MAX_SHARE_SUPPLY = 2 ** 128;

    uint256 public magnifiedDividendPerShare;
    /// @dev Implementation detail, deliberately not a public getter: the
    /// meaningful surface is `accumulativeDividendOf` / `withdrawableDividendOf`,
    /// and a raw signed correction term read on its own invites being
    /// misread as a balance.
    mapping(address => int256) private magnifiedDividendCorrections;
    mapping(address => uint256) public withdrawnDividends;

    /// @notice Lifetime totals. `totalDividendsWithdrawn <= totalDividendsReceived`, always.
    uint256 public totalDividendsReceived;
    uint256 public totalDividendsWithdrawn;

    /// @notice Value received but not yet credited to the accumulator. Two
    /// causes, one behaviour: nobody was eligible to be credited
    /// (`eligible == 0`), or the implied per-share delta exceeded this push's
    /// share of the accumulator's remaining headroom (see
    /// `MAX_PUSH_HEADROOM_DIVISOR`). In both cases the value is HELD, never
    /// lost and never reverted, and folds into the next push whose arithmetic
    /// has room for it. There is no input to this contract that can refuse a
    /// dividend push or strand one permanently.
    uint256 public undistributedDividends;


    // ── Part A: oracle-free, self-sourced eligibility bar ──────────────────

    /// @notice Minimum lifetime fee revenue (wei) a constituent must have
    /// collected ITSELF, read through IEligibilitySource. Timelocked.
    uint256 public minEligibilityFeesWei;

    /// @notice Minimum blocks a constituent must have been live for, measured
    /// from its own `firstActivityBlock()`. Timelocked.
    uint256 public minEligibilityBlocks;

    // ── Part D: dynamic HHI-derived concentration cap ──────────────────────

    /// @notice Target basket HHI, as a fraction of BPS (2_000 = 0.20).
    /// Timelocked, and hard-ceilinged at compile time like every other
    /// economically significant parameter.
    uint256 public targetHhiBps;

    /**
     * @notice How many currently-listed, active constituents pass the Part A
     * eligibility bar. CACHED, and recomputed only when the constituent set
     * changes (admission, deactivation, delisting) or when anyone calls
     * `refreshEligibleCount` — never per trade. The cap is O(1) to read on
     * every operation and O(n) to recompute at most a handful of times a year,
     * which is the whole reason it is a stored number and not a live loop.
     */
    uint256 public eligibleConstituentCount;

    // ── Events ─────────────────────────────────────────────────────────────

    event ConstituentQueued(address indexed token, uint64 eta, bool removal);
    event ConstituentListed(address indexed token, address source, uint256 rawWeightBps);
    event ConstituentDeactivated(address indexed token);
    event ConstituentDelisted(address indexed token);
    event ParamQueued(bytes32 indexed key, uint256 value, uint64 eta);
    event ParamApplied(bytes32 indexed key, uint256 value);
    event Seeded(address indexed token, uint256 amount);
    event IndexOpened(uint256 lockedSeedShares);
    event Checkpointed(address indexed token, uint256 price);
    event MintedProRata(address indexed to, uint256 shares);
    event RedeemedProRata(address indexed from, uint256 shares);
    event MintedSingle(address indexed to, address indexed token, uint256 amountIn, uint256 shares);
    event RedeemedSingle(address indexed from, address indexed token, uint256 shares, uint256 amountOut);
    event MetricUpdated(address indexed token, uint256 metric);
    event EligibleCountUpdated(uint256 eligibleCount, uint256 effectiveCapBps);
    event EcosystemFeesHarvested(address indexed token, address indexed sink, uint256 amount);
    event DividendsReceived(address indexed from, uint256 amount, uint256 eligibleSupply);
    event DividendClaimed(address indexed account, uint256 amount);
    event PayoutDeferred(address indexed account, address indexed token, uint256 amount);
    event PendingClaimed(address indexed account, address indexed token, uint256 amount);
    event ConstituentSynced(address indexed token, uint256 credited);
    event DividendsDeferred(uint256 amount, uint256 carried);

    // ── Errors ─────────────────────────────────────────────────────────────

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
    error EcosystemSinkUnset();
    error ApprovalNotConsumed();
    // `DividendAccumulatorFull` was retired in round 10. It was the revert that
    // made the accumulator poisonable — a single cheap push could land the
    // accumulator on its ceiling and every subsequent push, including every
    // ecosystem-fee harvest, reverted with it forever. The ceiling is now
    // enforced by CLAMPING and CARRYING (see MAX_PUSH_HEADROOM_DIVISOR), so
    // there is no longer any input that can refuse a push. The error is removed
    // rather than left declared-and-unreachable: a phantom failure mode in an
    // audited ABI is a lie about what this contract can do.

    // ── Construction ───────────────────────────────────────────────────────

    /**
     * @param roles_ The four scoped role holders, in the fixed order
     *        [ROLE_ADMIN, ROLE_CONSTITUENT_ADMISSION, ROLE_RISK_PARAM,
     *        ROLE_PLATFORM_ALLOCATION]. They MAY be set to the same address —
     *        nothing here can stop a deployer from recreating the very
     *        concentration this design exists to remove — but the contract
     *        treats them as independent from the first block, so separating
     *        them later costs one timelocked `queueRole` per role and no
     *        redeploy.
     */
    constructor(
        string memory name_,
        string memory symbol_,
        address[4] memory roles_,
        address seeder_,
        uint256 timelockDelay_,
        Params memory params_,
        address dividendAsset_
    ) ERC20(name_, symbol_) {
        if (seeder_ == address(0)) revert BadParam();
        if (timelockDelay_ < MIN_TIMELOCK_DELAY || timelockDelay_ > MAX_TIMELOCK_DELAY) {
            revert BadParam();
        }
        // `_initRole` rejects address(0) for each, so a role can never be born
        // unassigned — an unassigned role is an ungoverned parameter.
        _initRole(ROLE_ADMIN, roles_[0]);
        _initRole(ROLE_CONSTITUENT_ADMISSION, roles_[1]);
        _initRole(ROLE_RISK_PARAM, roles_[2]);
        _initRole(ROLE_PLATFORM_ALLOCATION, roles_[3]);
        seeder = seeder_;
        timelockDelay = timelockDelay_;
        dividendAsset = dividendAsset_; // may be address(0): dividends simply off

        IndexParams.validate(params_);
        params = params_;
        platformAllocationBps = DEFAULT_PLATFORM_ALLOCATION_BPS; // inert: no treasury yet
        ecosystemFeeSplitBps = DEFAULT_ECOSYSTEM_SPLIT_BPS; // inert: no sink yet
        targetHhiBps = DEFAULT_TARGET_HHI_BPS;
        // Placeholder bars, deliberately modest and deliberately timelocked:
        // the honest calibration for a real chain is an operational decision,
        // and shipping an aggressive default would gate constituents on a
        // number nobody chose. Note that a constituent failing the bar is
        // never excluded from the basket — the bar only feeds `capBpsFor`.
        minEligibilityFeesWei = 0.1 ether;
        minEligibilityBlocks = 100;
    }

    function _timelockDelay() internal view override returns (uint256) {
        return timelockDelay;
    }

    function _isKnownRole(bytes32 role) internal pure override returns (bool) {
        return
            role == ROLE_ADMIN ||
            role == ROLE_CONSTITUENT_ADMISSION ||
            role == ROLE_RISK_PARAM ||
            role == ROLE_PLATFORM_ALLOCATION;
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

    /// @dev The observation writer, the truncation cap and the variance
    /// accumulator all live in IndexOracle.sol now — see that file's header for
    /// why this particular extraction pays. The event is emitted HERE, under
    /// this contract's address, because a library `emit` would carry the
    /// library's topic set and every indexer keys on the vault.
    function _observe(address token, Constituent storage c, bool bootstrap) private {
        emit Checkpointed(
            token,
            IndexOracle.observe(c, params.priceCapBps, params.minCheckpointInterval, bootstrap)
        );
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
        return IndexOracle.priceBand(_get(token), params.bandBps, params.staleAfter);
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
        return
            IndexMath.requiredCheckpoints(
                ethValue,
                params.persistenceCheckpoints,
                params.largeOpValueWei,
                OBS_SLOTS
            );
    }

    /**
     * @notice A constituent's REALIZED per-checkpoint volatility, in bps: the
     * root-mean-square of its settled checkpoint-to-checkpoint price moves
     * over the long calibration window.
     *
     * WHAT THIS IS, AND — MORE IMPORTANTLY — WHAT IT IS NOT
     * ----------------------------------------------------
     * This is a ROLLING REALIZED-VARIANCE PROXY. It is NOT a Generalized
     * Pareto / extreme-value tail fit, and it must never be described as one.
     * The difference is not cosmetic:
     *
     *   - A GPD maximum-likelihood fit estimates shape and scale parameters
     *     for the distribution of EXCEEDANCES over a threshold, which is what
     *     actually characterises tail risk, and can extrapolate beyond the
     *     worst move ever observed.
     *   - This computes the second moment of ALL moves. It is dominated by the
     *     ordinary middle of the distribution, it says nothing about tail
     *     shape, and it can by construction never anticipate a move larger
     *     than the ones it has seen.
     *
     * So this is STRICTLY LESS STATISTICALLY RIGOROUS than an EVT tail fit,
     * and it is chosen anyway, for one reason: an MLE fit is not practically
     * Solidity-computable. It needs iterative optimisation over logarithms in
     * fixed point, which means it would in practice be computed off-chain and
     * SUBMITTED — reintroducing exactly the oracle-trust problem the rest of
     * this contract refuses everywhere else, on the single parameter that
     * governs how much confirmation a large operation needs. A cruder number
     * this contract computes itself from its own settled observations is worth
     * more than a sharper number it has to be told. That is the whole trade,
     * and it is a trade, not a free win.
     *
     * THE CIRCULARITY DEFENCE. This value scales the SHORT persistence window
     * (a handful of checkpoints, minutes to hours) and is itself measured over
     * a LONG one (VARIANCE_WINDOW = 90 days, thousands of checkpoints). The
     * two are structurally separate — different storage, different cadence,
     * different horizon — and moving the long one is ~3-4 orders of magnitude
     * more expensive than moving the short one, because a single manufactured
     * checkpoint changes the mean of thousands. On top of that,
     * `requiredCheckpointsFor` CLAMPS the result between compile-time floor
     * and ceiling constants, so even an attacker who somehow dominates the
     * whole 90-day window cannot drive the requirement to zero or past the
     * ring-buffer depth. The clamp is the defence that does not depend on the
     * statistics being right.
     *
     * Note also the direction the accumulator is fed from: it records CAPPED
     * observations, so a spike the truncated oracle rejected is not in here.
     */
    function realizedVolBps(address token) public view returns (uint256) {
        return IndexOracle.realizedVol(_get(token));
    }

    /**
     * @notice VARIANCE-CALIBRATED, SIZE-PROPORTIONAL persistence: how many
     * settled checkpoints an operation worth `ethValue` on `token` must see
     * that constituent's band hold across.
     *
     *     required = clamp( requiredCheckpoints(ethValue)
     *                       + realizedVolBps(token) / VOL_STEP_BPS,
     *                       floor, ceiling )
     *
     * WHY MORE VOLATILITY MEANS MORE CONFIRMATION. In a constituent that has
     * historically been quiet, a given price move is a large number of its own
     * standard deviations — it is anomalous, and anomalous is exactly when a
     * short confirmation window is informative. In one that has historically
     * thrashed, the identical move is unremarkable, carries little information,
     * and a short window will happily confirm noise. The requirement therefore
     * rises with measured historical volatility. This is the same instinct as
     * a volatility-scaled band, applied to TIME rather than to price.
     *
     * THE CLAMP IS NOT OPTIONAL AND IS NOT A DETAIL. `floor` is the greater of
     * the timelocked `persistenceCheckpoints` and the compile-time
     * MIN_REQUIRED_CHECKPOINTS; `ceiling` is the compile-time
     * MAX_REQUIRED_CHECKPOINTS (the ring-buffer depth, since a requirement
     * deeper than the retained history is unsatisfiable and would brick both
     * priced paths). Neither is reachable by governance and neither is
     * reachable by anything an attacker can do to the calibration input. The
     * adaptive term can move the requirement WITHIN that box and nowhere else.
     */
    function requiredCheckpointsFor(address token, uint256 ethValue)
        public
        view
        returns (uint256)
    {
        uint256 required = requiredCheckpoints(ethValue) + realizedVolBps(token) / VOL_STEP_BPS;
        uint256 floorReq = params.persistenceCheckpoints;
        if (floorReq < MIN_REQUIRED_CHECKPOINTS) floorReq = MIN_REQUIRED_CHECKPOINTS;
        if (required < floorReq) required = floorReq;
        if (required > MAX_REQUIRED_CHECKPOINTS) required = MAX_REQUIRED_CHECKPOINTS;
        return required;
    }

    /// @notice `persistenceHolds`, but against an explicit checkpoint count.
    function persistenceHoldsFor(address token, uint256 required) public view returns (bool) {
        Params memory p = params;
        return
            IndexOracle.persistenceHoldsFor(
                _get(token),
                required,
                p.bandBps,
                p.staleAfter,
                p.persistenceToleranceBps
            );
    }

    // ══ Part A: eligibility, read from the constituent's own books ════════

    /**
     * @notice Is `constituent` eligible, by its OWN on-chain fee accounting?
     *
     * Reads `IEligibilitySource` directly off the constituent. That interface
     * is a getter over state the constituent vault already maintains for its
     * own purposes — it is not an oracle, not a submission, and not a number
     * any privileged caller here can type in. There is no admin override on
     * this function and no stored per-constituent eligibility flag: the answer
     * is recomputed from the constituent's books every time it is asked.
     *
     * FAILS CLOSED, ALWAYS, AND NEVER REVERTS THE CALLER. The read is a
     * gas-capped low-level `staticcall`, so every failure mode a hostile or
     * merely-old constituent can produce — no code at the address, no such
     * selector, an outright revert, short or undecodable returndata, or an
     * attempt to burn the caller's whole gas budget — resolves to
     * `(false, 0, 0)`. A constituent that does not implement the interface at
     * all is simply not eligible; it does not brick the basket, it does not
     * brick a recount, and it keeps every redemption path it already had.
     *
     * NO WALLET-COUNT SIGNAL EXISTS HERE, ON PURPOSE. See IEligibilitySource's
     * header: address-cardinality is not sybil-resistant without identity, and
     * a bar an attacker can set for themselves is not a bar. Fee revenue is
     * the harder-to-fake proxy, and the claim made for it is bounded — faking
     * it costs real wash volume, continuously, over `minEligibilityBlocks`.
     */
    /// @notice Is `constituent` eligible, by its OWN on-chain fee accounting?
    /// The whole read — the gas cap, the fail-closed decode guards and the two
    /// bars — lives in IndexEligibility.sol; see that file's header for why it
    /// never reverts the caller and why there is no wallet-count signal in it.
    function checkEligibility(address constituent)
        public
        view
        returns (bool eligible, uint256 feesWei, uint256 elapsedBlocks)
    {
        return
            IndexEligibility.checkEligibility(
                constituent,
                minEligibilityFeesWei,
                minEligibilityBlocks,
                ELIGIBILITY_GAS_CAP
            );
    }

    /**
     * @notice Recount eligible constituents and refresh the dynamic cap.
     * PERMISSIONLESS: this moves no value, grants nobody anything, and the
     * honest party always wants it current. Bounded at MAX_CONSTITUENTS reads,
     * each itself gas-capped.
     */
    function refreshEligibleCount() external {
        _recomputeEligibleCount();
    }

    function _recomputeEligibleCount() private {
        uint256 count;
        uint256 n = constituentList.length;
        for (uint256 i = 0; i < n; i++) {
            address t = constituentList[i];
            if (!constituents[t].active) continue;
            (bool ok, , ) = checkEligibility(t);
            if (ok) count++;
        }
        eligibleConstituentCount = count;
        emit EligibleCountUpdated(count, effectiveConcentrationCapBps());
    }

    // ══ Part D: dynamic, HHI-derived concentration cap ════════════════════

    /**
     * @notice The maximum single-constituent weight, in bps, consistent with a
     * basket HHI of `targetHhiBps` across `n` eligible constituents.
     *
     * THE DERIVATION, worked rather than asserted.
     *
     * The Herfindahl-Hirschman Index of a weight vector is HHI = sum_i w_i^2.
     * The binding configuration for a single-name cap is the one that makes a
     * given maximum weight as CHEAP as possible in HHI terms: one constituent
     * at w, and the remaining mass (1 - w) spread perfectly evenly over the
     * other (n - 1). Any other spread of that remainder has a strictly higher
     * sum of squares (by Cauchy-Schwarz / QM-AM), so this is the configuration
     * that admits the largest w for a given HHI. Hence
     *
     *     HHI(w) = w^2 + (n - 1) * ((1 - w) / (n - 1))^2
     *            = w^2 + (1 - w)^2 / (n - 1)
     *
     * Setting HHI(w) = T and writing m = n - 1:
     *
     *     m*w^2 + (1 - w)^2         = T*m
     *     m*w^2 + 1 - 2w + w^2      = T*m
     *     (m + 1)*w^2 - 2w + 1 - T*m = 0
     *     n*w^2 - 2w + (1 - T*(n - 1)) = 0
     *
     * which is a quadratic in w with a = n, b = -2, c = 1 - T*(n-1):
     *
     *     w = [2 +/- sqrt(4 - 4*n*(1 - T*(n-1)))] / (2n)
     *       = [1 +/- sqrt(1 - n*(1 - T*(n-1)))] / n
     *
     * The MAXIMUM feasible weight is the upper root, so the cap is
     *
     *     w = (1 + sqrt(1 - n*(1 - T*(n-1)))) / n                          (*)
     *
     * VERIFICATION, n = 10, T = 0.20:
     *     1 - 10*(1 - 0.2*9) = 1 - 10*(1 - 1.8) = 1 + 8 = 9; sqrt = 3
     *     w = (1 + 3)/10 = 0.40  ->  4000 bps.
     *     Check: 0.4^2 + 0.6^2/9 = 0.16 + 0.04 = 0.20 = T. Exact.
     * VERIFICATION, n = 50, T = 0.20:
     *     1 - 50*(1 - 0.2*49) = 1 - 50*(1 - 9.8) = 1 + 440 = 441; sqrt = 21
     *     w = (1 + 21)/50 = 0.44  ->  4400 bps.
     *     Check: 0.44^2 + 0.56^2/49 = 0.1936 + 0.0064 = 0.20 = T. Exact.
     *
     * AN HONEST CORRECTION TO THE OBVIOUS INTUITION. (*) is INCREASING in n,
     * not decreasing. That is not a bug in the algebra, it is what fixed-HHI
     * means: the more legs there are to absorb the remainder, the less a given
     * large leg costs in sum-of-squares, so a fixed HHI budget buys a LARGER
     * single name. The cap runs from 1/n at the feasibility boundary up to an
     * asymptote of sqrt(T) (0.4472 at T = 0.20) as n grows. The quantity that
     * does fall with n is the AVERAGE weight 1/n, which is a different number.
     * This is stated here because the intuition "more constituents must mean a
     * tighter single-name cap" is natural, widespread, and false, and a
     * contract that silently implemented the intuition instead of the algebra
     * would be wrong in a way nobody would notice.
     *
     * DEGENERATE AND INFEASIBLE CASES.
     *  - n <= 1: a single constituent is trivially 100% of the basket and the
     *    formula's (n-1) denominator is undefined. Cap = 100%.
     *  - T < 1/n: the discriminant goes negative. This is not a numerical
     *    accident either — the MINIMUM achievable HHI for n names is 1/n
     *    (equal weights), so a target below it is unreachable by any
     *    allocation. The tightest honest answer is the equal-weight cap, 1/n,
     *    and that is what is returned. (At T = 0.20 this covers n = 2, 3, 4.)
     *
     * KNOWN, REAL, UNCLOSED GAP: CORRELATION BLINDNESS.
     * HHI measures SIZE concentration and nothing else. Ten constituents at
     * 10% each score a perfect HHI of 0.10 whether they are ten unrelated
     * collections or ten wrappers around the same underlying asset, moving
     * together, drawing down together, and going bid-less together. This cap
     * therefore bounds "how much of the basket is one NAME", not "how much of
     * the basket is one BET", and the two can be arbitrarily far apart. Closing
     * it would need a real correlation estimate over per-constituent price
     * history — a covariance matrix over n series, recomputed as prices move —
     * which this contract cannot compute cheaply or honestly on-chain, and
     * which would reintroduce exactly the off-chain-submission trust problem
     * the rest of this design refuses. It is flagged as open rather than
     * approximated: a correlation check that is cheap enough to run here would
     * be too crude to trust, and trusting a crude one is worse than knowing
     * the gap is there.
     */
    function capBpsFor(uint256 n) public view returns (uint256) {
        return IndexMath.capBpsFor(n, targetHhiBps);
    }

    /**
     * @notice The concentration cap actually enforced right now.
     *
     * `min(capBpsFor(eligibleConstituentCount), params.concentrationCapBps)`.
     *
     * The flat, timelocked `concentrationCapBps` is retained as a HARD
     * BACKSTOP CEILING rather than deleted, and the dynamic cap can only ever
     * bind TIGHTER than it. That is a deliberate conservative choice at an
     * ambiguity the design left open, resolved in existing holders' favour:
     * since `capBpsFor` RISES with n (see the derivation above), letting it
     * replace the flat cap outright would mean admitting constituents could
     * LOOSEN the single-name cap past the level that was audited — an
     * admission path that buys concentration. Taking the minimum means the
     * dynamic term can tighten the basket and can never relax it, and the
     * compile-time ceiling on `concentrationCapBps` (50%) still bounds the
     * whole thing regardless of what any parameter is set to.
     *
     * With no constituent implementing IEligibilitySource the eligible count
     * is zero, `capBpsFor(0)` is 100%, and the effective cap is exactly the
     * flat parameter — i.e. the pre-existing behaviour, unchanged, which is
     * the correct default for a basket that has no eligibility data at all.
     */
    function effectiveConcentrationCapBps() public view returns (uint256) {
        uint256 dyn = capBpsFor(eligibleConstituentCount);
        uint256 flat = params.concentrationCapBps;
        return dyn < flat ? dyn : flat;
    }

    // ══ NAV ═══════════════════════════════════════════════════════════════

    /// @notice The basket's NAV band in ETH wei. Never one number, anywhere.
    function nav() public view returns (uint256 navLow, uint256 navHigh) {
        return
            IndexValuation.navBand(
                constituentList,
                constituents,
                params.bandBps,
                params.staleAfter
            );
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
    /// @notice Target weights: square-root curve over each constituent's
    /// metric, then the hard concentration cap with the excess redistributed,
    /// then each constituent's ramp progress. The whole vector is computed in
    /// IndexValuation.sol — see that file's header for the derivation and for
    /// why a `storage`-pointer library call is the extraction that pays where
    /// a `memory`-array one did not.
    function targetWeightsBps()
        public
        view
        returns (address[] memory tokens, uint256[] memory bps)
    {
        return
            IndexValuation.targetWeightsBps(
                constituentList,
                constituents,
                effectiveConcentrationCapBps(),
                params.staleAfter
            );
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
        return
            IndexMath.rampFactorBps(
                c.active,
                block.timestamp - uint256(c.rampStart),
                c.rampDuration,
                block.timestamp > uint256(_last(c).timestamp) + params.staleAfter
            );
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
        // The fee this mint just charged, expressed in the DEPOSITED token:
        // the depositor was credited shares for `credited * (1 - feeBps)`, so
        // `credited * feeBps` is the fee, and the split is taken out of THAT
        // and nothing else. Whatever is not split off still lands in the
        // reserve and still lifts NAV per share, exactly as before.
        c.reserve += credited - _accrueEcosystem(token, (credited * feeBps) / BPS);
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

        // ── PHASE 1: size and debit EVERY leg, against PRE-PAYOUT reserves.
        // No external call happens anywhere in this loop, so no leg's outcome
        // can move another leg's number and there is no reentrancy surface
        // over a half-updated basket.
        amountsOut = new uint256[](n);
        for (uint256 i = 0; i < n; i++) {
            Constituent storage c = constituents[constituentList[i]];
            // FLOOR, against the REAL reserve (see the asymmetry note above).
            // Dust always stays with the vault, so there is no systematic
            // advantage to redeeming last (ultimate-form §1).
            uint256 out = Math.mulDiv(sharesIn, c.reserve, denom);
            if (out > c.reserve) out = c.reserve; // unreachable given the locked seed; belt and braces
            if (out < minAmountsOut[i]) revert SlippageExceeded();
            c.reserve -= out;
            amountsOut[i] = out;
        }

        // ── PHASE 2: pay. Every leg is attempted; a leg that fails is
        // DEFERRED, never fatal. This is the line that makes "no party,
        // privileged or not, can block an exit" true rather than intended.
        for (uint256 i = 0; i < n; i++) {
            _payOrDefer(constituentList[i], msg.sender, amountsOut[i]);
        }
        emit RedeemedProRata(msg.sender, sharesIn);
    }

    /**
     * @notice Retry ONE deferred redemption leg, at full gas and loudly.
     *
     * Unlike the redemption loop this does NOT swallow a failure: if the
     * restriction is still in force the call reverts and the credit is left
     * exactly where it was. That is the right shape for a deliberate retry —
     * the caller wants to know whether it worked — and it is also the escape
     * hatch for a legitimate constituent whose transfer costs more than
     * `PAYOUT_GAS`.
     *
     * NOT gated on `whenOpen`, on the constituent still being listed, or on
     * any role. A credit is a debt this contract already owes to one named
     * address, and nothing in this contract's governance can stand between
     * them and it.
     */
    function claimPending(address token) external nonReentrant returns (uint256 amount) {
        amount = pendingClaim[msg.sender][token];
        if (amount == 0) revert ZeroAmount();
        pendingClaim[msg.sender][token] = 0;
        reservedClaims[token] -= amount;
        IERC20(token).safeTransfer(msg.sender, amount);
        emit PendingClaimed(msg.sender, token, amount);
    }

    /**
     * @notice Batch-retry several deferred legs. Tolerant, unlike
     * `claimPending`: a leg that still fails is simply re-credited by
     * `_payOrDefer` and ends exactly where it started, and the others still
     * pay. Duplicate entries are harmless — the second sees a zero credit.
     */
    function claimPendingMany(address[] calldata tokens)
        external
        nonReentrant
        returns (uint256 settled)
    {
        for (uint256 i = 0; i < tokens.length; i++) {
            address t = tokens[i];
            uint256 amount = pendingClaim[msg.sender][t];
            if (amount == 0) continue;
            pendingClaim[msg.sender][t] = 0;
            reservedClaims[t] -= amount;
            if (_payOrDefer(t, msg.sender, amount)) {
                settled++;
                emit PendingClaimed(msg.sender, t, amount);
            }
        }
    }

    /**
     * @dev Pay one leg without ever reverting the caller. Returns true on a
     * completed transfer; on ANY failure — a revert, a `false` return, an
     * out-of-gas inside the callee, undecodable returndata, no code at the
     * address — the amount is credited to the user and reserved out of the
     * pro-rata pool, so it is neither lost to them nor double-redeemable by
     * anybody else.
     *
     * Moved, argument for argument, from `WrappedIndexShare._payout`. The
     * bounded gas is what makes it real: the 63/64 rule means a hostile
     * constituent cannot consume the gas the remaining legs need.
     */
    function _payOrDefer(address token, address to, uint256 amount) private returns (bool) {
        if (amount == 0) return true;
        (bool ok, bytes memory data) = token.call{gas: PAYOUT_GAS}(
            abi.encodeWithSelector(IERC20.transfer.selector, to, amount)
        );
        // Accept the two shapes a real ERC-20 returns: nothing, or `true`.
        if (ok && (data.length == 0 || (data.length >= 32 && abi.decode(data, (bool))))) {
            return true;
        }
        pendingClaim[to][token] += amount;
        reservedClaims[token] += amount;
        emit PayoutDeferred(to, token, amount);
        return false;
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

        uint256 feeAmount;
        (amountOut, feeAmount) = _previewSingleExit(sharesIn, token);
        // The split is taken out of `feeAmount` — the fee this exit ALREADY
        // charged and was already retaining — and never out of the payout.
        // `amountOut` above is computed before this line and is not touched
        // by it: the redeemer receives exactly what they would have received
        // with the split at zero, which is the property the suite pins.
        uint256 cut = _accrueEcosystem(token, feeAmount);
        if (amountOut + cut >= target.reserve) revert ReserveWouldEmpty();
        if (amountOut < minAmountOut) revert SlippageExceeded();

        {
            (uint256 targetLo, , ) = priceBand(token);
            _requirePersistenceIfLarge(token, Math.mulDiv(amountOut, targetLo, WAD));
        }

        uint256[] memory weightsBefore = _allWeightsBps();
        _burn(msg.sender, sharesIn);
        target.reserve -= amountOut + cut;
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

    /**
     * @notice Which role may queue `key`. Reverts for anything that is not a
     * recognised parameter.
     *
     * @dev This is load-bearing for role isolation, in two directions:
     *
     *  - it routes `platformAllocationBps` — the one key that redirects value
     *    to an operator — to ROLE_PLATFORM_ALLOCATION, so the risk key cannot
     *    reach it;
     *  - it REJECTS unrecognised keys outright. Without that, any parameter
     *    role could write a `keccak256("metric", token)` key into the shared
     *    `queuedParams` mapping and have `executeMetric` apply it, which
     *    would hand the risk role the admission role's re-weighting power
     *    through the back door. Whitelisting the key space closes that.
     */
    function roleForParamKey(bytes32 key) public pure returns (bytes32) {
        return IndexParams.roleForParamKey(key, ROLE_PLATFORM_ALLOCATION, ROLE_RISK_PARAM);
    }

    function queueParam(bytes32 key, uint256 value) external {
        bytes32 role = roleForParamKey(key);
        if (msg.sender != roleHolder[role]) revert NotRoleHolder(role);
        uint64 eta = uint64(block.timestamp + timelockDelay);
        queuedParams[key] = QueuedParam({value: value, eta: eta, pending: true});
        emit ParamQueued(key, value, eta);
    }

    function executeParam(bytes32 key) external {
        QueuedParam memory q = queuedParams[key];
        if (!q.pending) revert NothingQueued();
        if (block.timestamp < q.eta) revert TimelockNotElapsed();
        delete queuedParams[key];

        // The RISK half of the key space — the twelve fields of `Params` —
        // is dispatched and re-validated in IndexParams. It is one large
        // straight-line chain of 32-byte constant comparisons reached from
        // exactly one place, which is precisely the shape that pays for an
        // external library call (see IndexParams.sol's header). `handled`
        // comes back false for every key outside that set, and those keys are
        // applied HERE because each writes a standalone storage variable and
        // enforces its own ceiling — neither of which a `pure` library can do.
        (Params memory p, bool handled) = IndexParams.applyRiskParam(params, key, q.value);
        if (handled) {
            params = p;
            emit ParamApplied(key, q.value);
            return;
        }

        if (key == "platformAllocationBps") {
            // Hard ceiling re-checked HERE, at execution, not at queue time —
            // same doctrine as IndexParams.validate: a timelock bounds when a
            // bad change lands, never how bad it can be.
            if (q.value > CEIL_PLATFORM_ALLOCATION_BPS) revert AllocationCapExceeded();
            platformAllocationBps = q.value;
        } else if (key == "ecosystemFeeSplitBps") {
            // Same doctrine, same place: the ceiling is re-checked at
            // EXECUTION. A timelock bounds when a bad value lands, never how
            // bad it can be — so no governance, colluding or not, can ever
            // route more than CEIL_ECOSYSTEM_SPLIT_BPS of the fee away from
            // NAV appreciation.
            if (q.value > CEIL_ECOSYSTEM_SPLIT_BPS) revert AllocationCapExceeded();
            ecosystemFeeSplitBps = q.value;
        } else if (key == "ecosystemSink") {
            _applyEcosystemSink(q.value);
        } else if (key == "targetHhiBps") {
            // Part D. Hard ceilings re-checked HERE, at execution, same
            // doctrine as everything else. Note that even a maximally bad
            // value cannot LOOSEN the enforced cap past
            // `params.concentrationCapBps`, because the effective cap is the
            // minimum of the two.
            if (q.value < MIN_TARGET_HHI_BPS || q.value > MAX_TARGET_HHI_BPS) revert BadParam();
            targetHhiBps = q.value;
        } else if (key == "minEligibilityFeesWei") {
            // Part A's two bars need no ceiling: they are MINIMUMS, so setting
            // one absurdly high makes every constituent ineligible, which
            // drives the eligible count to zero, which makes `capBpsFor`
            // return 100%, which is then clamped by the flat cap — i.e. the
            // worst an admin can do is fall back to the pre-existing flat
            // behaviour. Both are timelocked regardless.
            minEligibilityFeesWei = q.value;
        } else if (key == "minEligibilityBlocks") {
            minEligibilityBlocks = q.value;
        } else revert BadParam();

        emit ParamApplied(key, q.value);
    }

    /// @notice Update a constituent's weight metric (fee revenue + locked LP).
    /// Timelocked like any other economically significant parameter, and it
    /// only ever changes a target-weight VIEW — it moves no value.
    function queueMetric(address token, uint256 metric)
        external
        onlyRole(ROLE_CONSTITUENT_ADMISSION)
    {
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
    ) external onlyRole(ROLE_CONSTITUENT_ADMISSION) {
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
            _recomputeEligibleCount(); // the eligible set shrank
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
        _recomputeEligibleCount();
    }

    // Role handover lives in ScopedRoles: `queueRole` / `executeRole`, on the
    // same `timelockDelay` the old single-admin handover used. There is no
    // per-contract shortcut around it here, and no second path that writes
    // `roleHolder`.

    /// @notice Appoint (or retire, with address(0)) the platform treasury that
    /// receives the mint-side allocation. Timelocked like everything else, and
    /// like everything else it grants NO reach over pooled reserves: the
    /// treasury receives shares and redeems them through the identical strict
    /// pro-rata path as any other holder.
    function queuePlatformTreasury(address treasury)
        external
        onlyRole(ROLE_PLATFORM_ALLOCATION)
    {
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

    /**
     * @dev APPOINTING THE ECOSYSTEM SINK. There is no bespoke
     * `queueEcosystemSink` pair: the appointment rides the SAME
     * `queueParam`/`executeParam` timelock every other parameter uses, under
     * key `"ecosystemSink"`, routed by `roleForParamKey` to
     * ROLE_PLATFORM_ALLOCATION and applied by `_applyEcosystemSink` below. One
     * timelock implementation, not two — a second hand-rolled queue is a
     * second place for a timelock bypass to hide, and this contract is also
     * against the EIP-170 size limit.
     *
     * Like every other appointment here it grants the appointee NO reach: the
     * sink cannot call anything on this contract, cannot move a reserve, and
     * cannot block a redemption. It is a destination address and nothing else.
     *
     * @dev WHY THE ASSET IS READ ONCE, AT APPOINTMENT, AND NOT LIVE ON THE
     * HOT PATH.
     * Consulting the sink inside `mintSingleAsset`/`redeemSingleAsset` would
     * put an external call to a third-party contract on both priced paths —
     * a reentrancy surface bought for a value that does not change — and it
     * would let a sink silently retarget which constituent this vault diverts
     * by mutating its own storage. Reading it once, at a timelocked
     * appointment, means retargeting costs a fresh appointment with the full
     * timelock's public notice.
     *
     * @dev WHY THE SCOPE IS "THE SINK'S OWN REINVEST ASSET, AND ONLY IT"
     * (the scoping decision, stated rather than half-implemented). Index
     * constituents are arbitrary ERC-20s; the distributor accepts exactly one
     * — its `reinvestAsset`, the WETH leg. Three options existed: accrue in
     * every constituent and route non-WETH legs through `mintSingleAsset` to
     * convert (an internal priced swap on a fee-harvest path, which is new
     * value-moving machinery with its own proofs to redo); accrue in every
     * constituent and harvest only WETH (which strands the rest in a ledger
     * nothing can spend — an asset trap, and this codebase does not build
     * those); or accrue ONLY in the leg the sink can actually take. The third
     * is chosen. Every wei that can be booked can be harvested by anyone,
     * immediately, and there is no unreachable state. Extending to other legs
     * is a later change with its own conversion proofs, not a silent gap.
     *
     * @dev RETIRING/RETARGETING AND ALREADY-ACCRUED FEES. Pointing the sink at
     * address(0), or at a sink with a different `reinvestAsset`, leaves fees
     * accrued under the OLD asset unharvestable until an appointment restores
     * a sink with that asset. This is not a trap on user assets — the ledger
     * is fee revenue, holds nothing redeemable, and `redeemProRata` is
     * untouched by it — and the timelock gives the full delay of public notice
     * during which anyone at all may call the permissionless harvest first.
     */
    function _applyEcosystemSink(uint256 value) private {
        address sink = address(uint160(value));
        ecosystemSink = sink;
        ecosystemAsset = sink == address(0)
            ? address(0)
            : IEcosystemFeeSink(sink).reinvestAsset();
    }

    /**
     * @notice Push the segregated ecosystem fees to the appointed sink.
     *
     * PERMISSIONLESS, with a FIXED destination — `MarketplankVaultV3`'s
     * `withdrawFees()` pattern, one for one. Anyone may call it; nobody may
     * choose where it goes. There is no recipient argument, no override, and
     * no privileged variant, so this is a trigger, not a rug lever: the worst
     * a caller can do is pay gas to move protocol fee revenue to the address
     * governance appointed under timelock in public.
     *
     * The allowance is granted for exactly `amount` and zeroed immediately
     * after, so this contract never leaves a standing approval over any token
     * balance — including the balance backing `reserve`.
     */
    function harvestEcosystemFees() external nonReentrant returns (uint256 amount) {
        address sink = ecosystemSink;
        if (sink == address(0)) revert EcosystemSinkUnset();
        address asset = ecosystemAsset;
        amount = ecosystemFeesWei[asset];
        if (amount == 0) revert ZeroAmount();
        ecosystemFeesWei[asset] = 0; // effects before interactions
        if (sink == address(this)) {
            // SELF-SINK. The vault is its own `IEcosystemFeeSink`, which is the
            // production shape now that dividend accrual lives here: the tokens
            // are already in this contract's balance, so there is nothing to
            // approve, nothing to pull, and no external call to make. Moving
            // them would be `transferFrom(self, self)` — a no-op that credits a
            // zero delta and would revert. Booking them straight into the
            // accumulator is the same operation with the round trip removed.
            _creditDividends(amount);
        } else {
            IERC20(asset).forceApprove(sink, amount);
            IEcosystemFeeSink(sink).receiveDividendsWrapped(amount);
            // The sink must consume the WHOLE allowance. Asserting it is
            // strictly cheaper than re-approving to zero and strictly stronger
            // than trusting it: this contract can never be left with a standing
            // approval over a token balance, including the balance backing
            // `reserve`. A sink that under-pulls reverts the harvest instead.
            if (IERC20(asset).allowance(address(this), sink) != 0) revert ApprovalNotConsumed();
        }
        emit EcosystemFeesHarvested(asset, sink, amount);
    }

    // ══ Dividends: in, accrued, out ═══════════════════════════════════════

    /**
     * @notice The asset an ecosystem sink is expected to expose. Implementing
     * it — together with `receiveDividendsWrapped` below — makes THIS CONTRACT
     * a valid `IEcosystemFeeSink`, so `ecosystemSink` can be pointed at the
     * vault itself through the ordinary timelock and `harvestEcosystemFees`
     * then funds holders directly with no second contract in the path.
     *
     * The name is the sink interface's, not this contract's preference; it is
     * `dividendAsset` everywhere else here.
     */
    function reinvestAsset() external view returns (address) {
        return dividendAsset;
    }

    /**
     * @notice Push dividends to every share holder, pro rata, permissionlessly.
     *
     * Anyone may call. Making it privileged would buy nothing — a griefer's
     * "attack" is donating money — and would add a key to lose. The pusher in
     * practice is `harvestEcosystemFees`, which is itself permissionless with a
     * fixed destination.
     *
     * Credits the ACTUAL balance delta, never the nominal amount: the same
     * Balancer-STA discipline `_pullCredited` applies on every other inbound
     * path in this contract.
     */
    function receiveDividendsWrapped(uint256 amount) external nonReentrant {
        address asset = dividendAsset;
        if (asset == address(0)) revert BadParam();
        if (amount == 0) revert ZeroAmount();
        uint256 before = IERC20(asset).balanceOf(address(this));
        IERC20(asset).safeTransferFrom(msg.sender, address(this), amount);
        _creditDividends(IERC20(asset).balanceOf(address(this)) - before);
    }

    /**
     * @dev The ONE accumulator write. Shared by the external push and by
     * `harvestEcosystemFees`'s self-sink branch.
     *
     * Note the divisor: `totalSupply()` MINUS the permanently-locked seed, and
     * the seed's own accrual cancelled through its correction term in the same
     * breath. See the module header for why the conservation identity still
     * closes.
     */
    function _creditDividends(uint256 amount) private {
        if (amount == 0) revert ZeroAmount();
        totalDividendsReceived += amount;
        uint256 pot = amount + undistributedDividends;

        uint256 seedBal = balanceOf(SEED_LOCK);
        uint256 eligible = totalSupply() - seedBal;
        if (eligible == 0) {
            // Nobody to credit. Held, never lost, never reverted — the same
            // honest-queryable-state discipline the rest of this file uses.
            undistributedDividends = pot;
            emit DividendsReceived(msg.sender, amount, 0);
            return;
        }
        // Floors. The remainder stays in this contract, which is what makes
        // "total withdrawable <= total received" structural rather than hopeful.
        uint256 delta = Math.mulDiv(pot, MAGNITUDE, eligible);

        // ── THE PER-PUSH HEADROOM CAP. See MAX_PUSH_HEADROOM_DIVISOR for why
        // this, and not a revert, is what closes the one-transaction poisoning
        // attack — and for why the ceiling is unreachable by honest use.
        uint256 room = MAX_MAGNIFIED_PER_SHARE - magnifiedDividendPerShare;
        // `step == 0` means the accumulator is already within 2**-32 of full,
        // at which point there is nothing left to ration and rationing anyway
        // would strand every future push in the carry forever. The residual
        // room is then the whole allowance — still a hard clamp, never a revert.
        uint256 step = room / MAX_PUSH_HEADROOM_DIVISOR;
        if (step == 0) step = room;
        uint256 carried;
        if (delta > step) {
            delta = step;
            // What this delta actually distributes, floored — so the carry is
            // the honest remainder and can never exceed the pot.
            carried = pot - Math.mulDiv(delta, eligible, MAGNITUDE);
        }
        undistributedDividends = carried;
        // In range UNCONDITIONALLY: `delta <= step <= room`. The transfer
        // hook's overflow bound therefore still holds as a proof, which is the
        // property that must survive this change untouched.
        magnifiedDividendPerShare += delta;

        // Cancel the locked seed's accrual, in O(1), so no slice of any
        // distribution is credited to an address that can never claim it.
        if (seedBal > 0) {
            magnifiedDividendCorrections[SEED_LOCK] -= int256(delta * seedBal);
        }
        if (carried > 0) emit DividendsDeferred(pot, carried);
        emit DividendsReceived(msg.sender, amount, eligible);
    }

    /// @notice Everything `account` has ever been credited, claimed or not.
    function accumulativeDividendOf(address account) public view returns (uint256) {
        return
            uint256(
                int256(magnifiedDividendPerShare * balanceOf(account)) +
                    magnifiedDividendCorrections[account]
            ) / MAGNITUDE;
    }

    /**
     * @notice What `account` can claim right now. Always already correct, with
     * no action ever required from them and nothing to prove.
     *
     * This does NOT go to zero when a holder's balance goes to zero. A redeemer
     * who burns every share they own keeps every wei that accrued while they
     * held them, because the burn moved the same quantity into their correction
     * term. The entitlement is for value already earned.
     */
    function withdrawableDividendOf(address account) public view returns (uint256) {
        return accumulativeDividendOf(account) - withdrawnDividends[account];
    }

    /**
     * @notice Claim your own dividend. Permissionless, no proof, no root, no
     * snapshot, no staking — you held the token, so it is already yours.
     *
     * Paying zero is a successful transaction, not an error.
     * Checks-effects-interactions: every state change lands before the
     * transfer, so a re-entrant token finds `withdrawableDividendOf` already
     * zero even with the guard removed. `nonReentrant` is defence in depth on
     * top of that, not the thing holding it up.
     */
    function claimDividend() external nonReentrant returns (uint256 amount) {
        amount = withdrawableDividendOf(msg.sender);
        if (amount == 0) return 0;
        withdrawnDividends[msg.sender] += amount;
        totalDividendsWithdrawn += amount;
        IERC20(dividendAsset).safeTransfer(msg.sender, amount);
        emit DividendClaimed(msg.sender, amount);
    }

    /**
     * @dev THE HOOK. The single point at which a balance change is made not to
     * matter, and the only new code that runs on an ordinary transfer.
     *
     * `magnifiedDividendPerShare * value` is added to the sender's correction
     * and subtracted from the receiver's, which leaves `accumulativeDividendOf`
     * numerically unchanged for both across the move. Mint is `from == 0`,
     * burn is `to == 0`, and a plain transfer is both branches — one identity,
     * three cases, no special-casing anywhere.
     *
     * IT CANNOT REVERT A TRANSFER, AND THAT IS A PROOF, NOT AN INTENTION.
     * There is no external call, no `require`, no revert statement and no
     * division on the transfer path. The only arithmetic that could fault is
     * the multiplication, and it is bounded at both ends by compile-time
     * constants enforced elsewhere: `magnifiedDividendPerShare` can never
     * exceed 2**126 (refused at the push) and `value <= totalSupply()` can
     * never exceed 2**128 (refused at the mint), so the product is at most
     * 2**254 and `int256` holds it. A bug in dividend bookkeeping therefore
     * cannot brick share transferability, which is the transfer-side statement
     * of the same doctrine that makes `redeemProRata` unblockable.
     *
     * The mint bound is checked in the `from == address(0)` branch only. It
     * gates MINTS, so it can never stand between a holder and a transfer, a
     * burn, or a redemption.
     */
    function _afterTokenTransfer(address from, address to, uint256 value) internal override {
        if (from == address(0) && totalSupply() > MAX_SHARE_SUPPLY) revert BadParam();
        int256 correction = int256(magnifiedDividendPerShare * value);
        if (from != address(0)) magnifiedDividendCorrections[from] += correction;
        if (to != address(0)) magnifiedDividendCorrections[to] -= correction;
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
        (uint256 out, ) = _previewSingleExit(sharesIn, token);
        return out;
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
        // The eligible-constituent count changed, so the dynamic cap must be
        // recomputed. Done HERE (admission) rather than per trade, which is
        // what keeps the cap gas-bounded.
        _recomputeEligibleCount();
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
    /**
     * @dev Book the ecosystem share of an ALREADY-CHARGED fee and return it,
     * so the caller can keep the remainder in the reserve. The one and only
     * writer of `ecosystemFeesWei`.
     *
     * Three guards, in the order that matters:
     *  - `token != ecosystemAsset` → zero. No constituent other than the one
     *    the sink can actually take ever accrues, so nothing can strand.
     *  - no sink appointed → zero. The whole feature is inert by default.
     *  - the cut FLOORS, so an ambiguous base unit stays in the reserve with
     *    existing holders rather than going to the sink. Same rounding
     *    doctrine as everywhere else in this file: the party who did not set
     *    the parameter wins the dust.
     *
     * `feeAmount` is always a strict fraction of an amount the operation
     * already moved, and `bps <= CEIL_ECOSYSTEM_SPLIT_BPS < BPS`, so the
     * returned cut is always strictly less than the fee and can never exceed
     * — let alone reach into — principal.
     */
    function _accrueEcosystem(address token, uint256 feeAmount) private returns (uint256 cut) {
        if (ecosystemSink == address(0) || token != ecosystemAsset) return 0;
        uint256 bps = ecosystemFeeSplitBps;
        if (bps == 0 || feeAmount == 0) return 0;
        cut = (feeAmount * bps) / BPS; // floors, in existing holders' favour
        if (cut == 0) return 0;
        ecosystemFeesWei[token] += cut;
    }

    /// @dev The whole decomposition now lives in IndexValuation.sol; `_get`
    /// keeps the NotListed guard on this side of the boundary so an unlisted
    /// token can never reach the library's raw mapping read.
    function _previewSingleExit(uint256 sharesIn, address token)
        private
        view
        returns (uint256 amountOut, uint256 feeAmount)
    {
        _get(token);
        return
            IndexValuation.previewSingleExit(
                constituentList,
                constituents,
                token,
                sharesIn,
                totalSupply() + VIRTUAL_SHARES,
                params
            );
    }

    /**
     * @dev Curve-flavoured imbalance fee: free at the margin, steeper the more
     * concentrated the ask. `d` is the requested amount as a fraction of what
     * the constituent has left, in bps; the fee is base + slope*d, capped.
     * A withdrawal that takes 100% of the remaining leg pays base + slope.
     *
     * DIRECTION SYMMETRY (audited, and the finding stated in full).
     * This is the ONE fee formula, and BOTH priced paths charge it:
     * `mintSingleAsset` (buy side) and `_previewSingleExit` (sell side) each
     * call exactly this function with exactly the same shape of arguments —
     * (the non-pro-rata amount, the depth it is charged against). There is no
     * `isBuy` argument, no direction branch, no second fee table, and no
     * directional multiplier anywhere in it: for identical (amount, against),
     * a buy and a sell are charged the identical number of bps. That is what
     * makes a round trip strictly loss-making rather than free in one
     * direction, and the audit suite asserts it directly.
     *
     * The ONE asymmetry that does exist is `_mintFeeBps`, and it is worth
     * being precise about what kind of asymmetry it is, because "the buy side
     * has an extra term" reads like a directional multiplier and is not one.
     * `_mintFeeBps` adjusts by how far the leg sits from its own TARGET
     * WEIGHT — it discounts a deposit that rebalances and surcharges one that
     * unbalances. It is a function of (current weight, target weight) only.
     * Two consequences: it vanishes identically when a leg is AT target (the
     * gap is zero, so both branches return `depthFee` untouched), and it is
     * not keyed on buy-versus-sell at all — a buy into an overweight leg is
     * surcharged for the same reason and by the same slope as a buy into an
     * underweight leg is discounted.
     *
     * It is deliberately not mirrored onto the redeem side, and that decision
     * is left standing here after re-auditing it. The redeem path's properties
     * (monotone in size, strictly worse than pro-rata, retained in reserves)
     * are asserted directly by the audit suite and are the reason the
     * single-asset exit is safe at all; adding a directional term there is a
     * separate change with its own proofs to redo, and it would have to
     * SURCHARGE an exit that unbalances the basket — i.e. make leaving more
     * expensive — which is the one direction this contract should be most
     * reluctant to move. Charging less to rebalance on the way in is a
     * discount; charging more to leave is a lock-in, and the conservative
     * resolution of that asymmetry favours the holder.
     */
    function _imbalanceFeeBps(uint256 amount, uint256 against) private view returns (uint256 fee) {
        Params memory p = params;
        return
            IndexMath.imbalanceFeeBps(
                amount,
                against,
                p.baseImbalanceFeeBps,
                p.imbalanceSlopeBps,
                p.maxImbalanceFeeBps
            );
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
        // The DYNAMIC cap (Part D), not the flat parameter. `capBpsFor` is
        // O(1) and the eligible count is cached, so this stays one SLOAD and a
        // sqrt on the hot path — the recount is what is gas-bounded to
        // set changes, never this check.
        uint256 cap = effectiveConcentrationCapBps();
        for (uint256 i = 0; i < now_.length; i++) {
            if (now_[i] > cap && now_[i] > weightsBefore[i]) revert ConcentrationCapExceeded();
        }
    }

    /// @dev Every constituent's share of NAV_low in one O(n) pass. Calling
    /// `weightBps` per leg would be O(n^2) — it recomputes NAV each time.
    function _allWeightsBps() private view returns (uint256[] memory w) {
        return
            IndexValuation.allWeightsBps(
                constituentList,
                constituents,
                params.bandBps,
                params.staleAfter
            );
    }

    /// @dev Above `largeOpValueWei`, a constituent's band must have HELD
    /// across independent checkpoints before the basket prices against it —
    /// and across MORE of them the larger the operation is (see
    /// `requiredCheckpoints`).
    function _requirePersistenceIfLarge(address token, uint256 ethValue) private view {
        if (ethValue < params.largeOpValueWei) return;
        // The VARIANCE-CALIBRATED requirement (Part E), not the size-only one.
        // `requiredCheckpoints` is retained unchanged as the pure size term
        // and as the figure a UI or monitor should read.
        if (!persistenceHoldsFor(token, requiredCheckpointsFor(token, ethValue))) {
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

        Params memory p = params;
        return
            IndexMath.mintFeeBps(
                depthFee,
                current[idx],
                t,
                p.baseImbalanceFeeBps,
                p.imbalanceSlopeBps,
                p.maxImbalanceFeeBps
            );
    }

}
