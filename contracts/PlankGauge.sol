// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * ============================================================================
 *  PlankGauge — epoch-scoped burn voting, and NOTHING ELSE
 *
 *  NOT FOR DEPLOYMENT. Same gate as GlobalIndexVault.sol: nothing in this repo
 *  may put either contract on any network until the external audit of
 *  SPEC-PLANK-CHECKS-AND-INDEX.md §2.6 clears. hardhat.config.ts has no default
 *  network on purpose; keep it that way.
 *
 *  WHAT THIS CONTRACT IS, IN ONE SENTENCE
 *  --------------------------------------
 *  A PUBLISHER. It reads burns, and it publishes two numbers: a per-gauge
 *  voting weight for the CURRENT epoch, and a per-account boost multiplier.
 *  It holds no value, it pays nobody, it has no payable function, no claim
 *  function, no accumulator over anyone's money, and no reference to any
 *  vault, pool, treasury or reward source anywhere in its ABI or its bytecode.
 *
 *  WHAT IT USED TO BE, AND WHY THAT WAS REMOVED
 *  --------------------------------------------
 *  The previous generation carried a PERMANENT claim ledger: every burn
 *  credited a soulbound, never-expiring `claimantWeightedBurns` balance, ETH
 *  was pushed in via `receiveRewards`, held in `pendingRewards` until it
 *  cleared a global `distributionThresholdWei`, then folded into a
 *  per-weight accumulator that claimants drew from. It worked, and it was
 *  over-engineered for what it bought:
 *
 *    - A permanent claim means a burn from two years ago still dilutes every
 *      distribution today. Influence that never has to be renewed is not
 *      "buying direction", it is a perpetuity, and perpetuities ossify a
 *      gauge into whoever showed up first.
 *    - The threshold/fold/settle machinery is three interacting stateful
 *      systems (pending pot, per-weight accumulator, per-claimant checkpoint)
 *      whose combined invariant — "a later burn can never claw back an
 *      already-folded pot" — took a dedicated test to state and is exactly
 *      the class of bookkeeping that has produced real incidents elsewhere.
 *    - It made this contract a custodian of ETH. A contract that holds money
 *      has to defend that money.
 *
 *  All of it is gone. Burning no longer creates any standalone reward stream
 *  at all. What a burn buys is influence over the CURRENT epoch, and a boost
 *  multiplier that some OTHER contract — the one that actually earns LP swap
 *  fees — may choose to honour when it pays out.
 *
 *  THE EPOCH RULE: INFLUENCE IS RENTED FROM TIME, NOT OWNED
 *  --------------------------------------------------------
 *  An epoch is a fixed real-time window (`epochDuration`, timelocked, 7 days
 *  by default). All burn accounting is keyed by `(currentEpoch, gauge,
 *  account)`. At an epoch boundary `gaugeWeight(gauge)` reads a fresh,
 *  untouched storage slot and is therefore ZERO — not decayed, not
 *  carried-forward, not half-life'd. Zero.
 *
 *  There is deliberately NO carry-forward of any kind. A wallet that wants
 *  sustained influence over a gauge must burn again, every epoch, forever.
 *  That is the entire economic point: it converts gauge direction from a
 *  one-time purchase into a recurring cost, which is the only version of
 *  "burn for influence" that produces recurring buy pressure rather than a
 *  single land-grab followed by permanent rent extraction.
 *
 *  `currentEpoch()` is monotonic across an `epochDuration` change: changing the
 *  duration re-bases the clock and jumps the index forward past every id that
 *  was ever used, so a governance retune can never resurrect a stale epoch's
 *  storage or replay its weights.
 *
 *  THE THREE BURN PATHS AND THEIR MULTIPLIERS (unchanged, and still the core)
 *  -------------------------------------------------------------------------
 *  Weighted burn credited = amount * multiplier.
 *
 *    burnPlank                1.0x  baseline. Destroys token count.
 *    burnPlankEthLp           2.5x  destroys a PAIRED position: PLANK *and*
 *                                   the ETH sitting against it. Permanent
 *                                   removal of two-sided depth — the LP can
 *                                   never be pulled back out and dumped.
 *    burnCollectionLp         3.0x  same permanence, but the depth it locks is
 *                                   the EXACT market the vote asks to support.
 *
 *  Those are DEFAULTS, timelocked, bounded by MAX_MULTIPLIER_BPS. Every path
 *  still moves the token to 0x...dEaD via `transferFrom` and still credits the
 *  ACTUAL observed balance delta at the dead address, never the nominal
 *  amount (Balancer-STA discipline, same as GlobalIndexVault._pullCredited).
 *  It does NOT call `burn()` on the token: a Uniswap-V2-style LP `burn` is
 *  "redeem this LP for the underlying", which would hand the liquidity BACK
 *  rather than destroy it — exactly wrong. The LP allowlists are unchanged
 *  and still address-keyed, because at least three impostor contracts on the
 *  target chain report the symbol "WETH" (lib/constants.ts records this).
 *
 *  SQRT DAMPENING — AND AN HONEST CORRECTION ABOUT WHAT IT DOES
 *  -----------------------------------------------------------
 *  An account's contribution to `gaugeWeight` is
 *
 *      weightContribution_i = sqrt(weightedBurn_i this epoch)
 *
 *  not the linear amount. That genuinely dampens whales: doubling your burn
 *  buys 1.41x the weight, not 2x, so the marginal ETH a whale spends on
 *  direction is worth strictly less than the marginal ETH a minnow spends.
 *  That property is real and it is why this is here.
 *
 *  What sqrt dampening does NOT do — and the design note asking for it
 *  claimed the opposite, so it is worth stating plainly rather than shipping
 *  a comment that is false — is make wallet-splitting unprofitable. The
 *  claimed inequality `sqrt(a) + sqrt(b) < sqrt(a+b)` is BACKWARDS. Because
 *  (sqrt(a)+sqrt(b))^2 = a + b + 2*sqrt(a*b) >= a + b, the true relation for
 *  all a,b > 0 is
 *
 *      sqrt(a) + sqrt(b)  >  sqrt(a + b)
 *
 *  i.e. sqrt is CONCAVE, and every concave weighting function strictly
 *  REWARDS splitting one burn across many wallets. This is not an obscure
 *  edge: it is precisely the reason quadratic funding (Buterin/Hitzig/Weyl)
 *  requires an identity or personhood layer to function at all — the sqrt is
 *  what creates the sybil incentive, not what removes it. The only weighting
 *  that is sybil-NEUTRAL without identity is linear (f(a)+f(b) = f(a+b)); the
 *  only sybil-RESISTANT one is superadditive/convex, which is plutocratic by
 *  construction. You may pick two of {anti-whale, sybil-proof, identity-free}
 *  and this contract picks the first two words of the first one.
 *
 *  ROUND 9f — AND AN EVEN MORE UNCOMFORTABLE CORRECTION
 *  ----------------------------------------------------
 *  A game-theory audit drove the paragraph above to its equilibrium and found
 *  that "anti-whale" does not survive contact with a rational actor either:
 *
 *   (a) ANTI-WHALE IS ACTUALLY ANTI-MINNOW. A whale that splits into N
 *       addresses in PROPORTION to its size restores EXACT linearity:
 *       C_w/C_m = sqrt(N_w*W_w)/sqrt(N_m*W_m) = sqrt(X*X) = X, not sqrt(X).
 *       Splitting cost was purely GAS, and gas is an ABSOLUTE cost, so a whale
 *       can afford proportionally more addresses than a minnow can. The
 *       dampening therefore bound only on actors too small to pay the gas
 *       floor to fragment — i.e. on exactly the people it was meant to protect.
 *   (b) THE TWO PUBLISHED NUMBERS REWARDED OPPOSITE STRUCTURES. `gaugeWeight`
 *       aggregates across addresses, so weight-optimal N is unbounded (the
 *       audit derived N* ~= [V*R/(2*sqrt(W)*G*p)]^(2/3), in the THOUSANDS at
 *       real L2 gas prices, with no interior optimum — only gas stops it).
 *       `boostMultiplier` reads ONE address's share `c_i/T`, which strictly
 *       FALLS as N rises, so boost-optimal N is 1. And a SOLE burner's weight
 *       is exactly ZERO, because `1 - rawShare^k` vanishes at rawShare = 1. So
 *       anybody who wants real influence is FORCED to fragment and thereby
 *       forfeits the boost entirely. The mechanism did not merely tolerate
 *       sybils, it mandated them.
 *
 *  THE REPAIR: A REGISTRATION COST DENOMINATED IN THE BURNED ASSET
 *  --------------------------------------------------------------
 *  The impossibility result above is real and is not repealed here: you still
 *  may pick two of {anti-whale, sybil-proof, identity-free}. What CAN be fixed
 *  is that the marginal cost of one more address was GAS, which is roughly
 *  constant in the actor's wealth and therefore not a proportional cost at all.
 *
 *  `registrationBurnPlank` is a fixed PLANK amount that must be DESTROYED —
 *  same `BURN_ADDRESS`, same one-way transfer, same measured-delta discipline
 *  as every other burn path — the first time an account acquires nonzero weight
 *  in a given gauge in a given epoch. It buys NO weight and NO boost. It is a
 *  cost of having an identity in this epoch's book, and it is denominated in
 *  the very asset the attack spends.
 *
 *  WHAT THAT DOES TO N*, exactly. With a total PLANK budget B and a per-address
 *  registration cost `p`, an attacker splitting into N addresses has only
 *  `B - N*p` left to actually burn for weight, so their aggregate contribution
 *  is
 *
 *      A(N) = sqrt( N * (B - N*p) * mult )
 *
 *  which is a downward parabola in N. It is maximised at
 *
 *      N* = B / (2p)                     and is ZERO for N >= B/p.
 *
 *  Three things follow, and they are the whole point:
 *    - N* NO LONGER DEPENDS ON GAS AT ALL. It is set by the attacker's own
 *      budget divided by an asset-denominated cost, so a cheap-gas L2 does not
 *      hand anyone a thousand-fold larger sybil fleet.
 *    - AT THE OPTIMUM THE COST IS PROPORTIONAL. `N* = B/(2p)` scales with the
 *      actor's own budget, so an actor playing it destroys HALF their entire
 *      budget on registrations and never gets a unit of weight for it. A
 *      ten-times-larger actor therefore pays ten times more to sybil. Stated
 *      precisely because it is only true AT the optimum: `p` is an absolute
 *      per-address cost, the same SHAPE gas was, so at a matched per-shard
 *      budget a splitting whale still realises exactly linear weight. That
 *      negative result is not repealed, and it is asserted by test rather than
 *      quietly stepped around (see PlankGaugeSybilCost.audit.test.ts).
 *    - THERE IS NOW A HARD CEILING, AND THAT IS THE REAL REPAIR. Beyond `B/p`
 *      addresses the attacker has nothing left to burn and their weight is
 *      ZERO. An interior optimum exists where before there was none, so
 *      finding (b) softens too: the weight leg's optimum is no longer N -> inf
 *      against the boost leg's N = 1, it is a FINITE `B/(2p)`, and the actor
 *      faces a bounded, priced trade-off between the two published numbers
 *      instead of an unbounded corner that forfeits the boost outright.
 *
 *  Governance sets `p` (timelocked, ROLE_GAUGE_TUNING, hard-capped by
 *  `MAX_REGISTRATION_BURN`). It DEFAULTS TO ZERO, and that default is a
 *  deliberate refusal rather than an oversight: a nonzero default would be this
 *  contract asserting a relationship between PLANK's token units and economic
 *  value that it has no way to know — the same unfounded valuation claim
 *  WrappedIndexShare refuses to make when it declines to price unlike backing
 *  legs against each other. The right `p` is a fraction of a typical honest
 *  burn on the deployed token, which is a deployment-time fact. Shipped at
 *  zero, calibrated at listing, bounded forever by a compile-time constant no
 *  governance can raise — the same doctrine as every other parameter here.
 *
 *  WHAT THIS DOES NOT CLAIM. It does not make sybils unprofitable, and no
 *  identity-free mechanism can. It converts an UNBOUNDED, gas-limited sybil
 *  count into a BOUNDED, budget-limited one, and it makes the marginal address
 *  cost scale with the actor rather than with the chain. The residual — that
 *  splitting still lowers the price of influence — remains open, known, and
 *  measured by test, exactly as before.
 *
 *  NO CUSTODY IS CREATED. The registration cost is a BURN, not a payment: the
 *  PLANK goes from `msg.sender` to `BURN_ADDRESS` and this contract never holds
 *  it, never has a balance of it, and has no function that could move it. The
 *  "this contract pays none of it, it cannot" property below is unchanged, and
 *  is still proved by the ABI/bytecode enumeration in PlankGauge.audit.test.ts.
 *
 *  So: sqrt dampening is retained because anti-whale dampening is what it was
 *  actually wanted for, and the sybil exposure is DOCUMENTED AND TESTED
 *  rather than papered over. PlankGauge.audit.test.ts contains a test that
 *  measures the split-across-two-wallets case and asserts the direction that
 *  is really true. Governance should treat the sybil surface as an open,
 *  known cost of an identity-free gauge, bounded in practice by the fact that
 *  every sybil wallet still has to permanently destroy real tokens to vote
 *  and gets nothing back — splitting reduces the PRICE of a given amount of
 *  influence, it never makes influence free.
 *
 *  CONCENTRATION PENALTY
 *  ---------------------
 *  On top of the dampening, per gauge per epoch:
 *
 *      rawShare_i       = weightContribution_i / totalWeightContribution
 *      penalty_i        = rawShare_i ^ k                    (k = 1.5 default)
 *      effectiveShare_i = rawShare_i * (1 - penalty_i)
 *
 *  `k` is timelocked and stored as a fixed-point RATIO OVER TWO
 *  (`concentrationExponentHalves`, default 3 => k = 3/2 = 1.5). Halves are
 *  used rather than an arbitrary WAD exponent because s^(n/2) is exactly
 *  (sqrt s)^n — computable on-chain with one sqrt and n multiplies, with no
 *  exp/ln approximation and therefore no approximation error to audit.
 *
 *  Two properties worth being precise about, because the obvious statement of
 *  each is subtly wrong:
 *
 *   - The RETENTION RATE `effectiveShare_i / rawShare_i = 1 - rawShare_i^k`
 *     is strictly decreasing in rawShare_i. THAT is the concavity claim that
 *     is true and that the suite proves. `effectiveShare_i` itself is NOT
 *     monotone in rawShare_i: d/ds [s - s^2.5] = 1 - 2.5*s^1.5 vanishes at
 *     s = 0.4^(2/3) ~= 0.5429, so effectiveShare rises up to ~54% share and
 *     falls after. Asserting "effectiveShare strictly decreases as rawShare
 *     increases" would be asserting something false over most of the domain.
 *   - Dilution recovery IS true and is proven: when a second burner enters
 *     and pushes a whale's rawShare down, the whale's effectiveShare moves
 *     UP, because it was sitting on the falling side of that curve.
 *
 *  THE PENALIZED REMAINDER IS A REPORTING FIGURE, NOT A BALANCE
 *  -----------------------------------------------------------
 *  `protocolShareWad(gauge)` = WAD - sum_i effectiveShare_i. It does NOT go
 *  to the other burners (that would just re-concentrate it on the next
 *  largest holder). It is a pure view, computed on demand from the epoch's
 *  burner list.
 *
 *  There is NO claim path for it, and adding one is explicitly out of scope:
 *  a claimable protocol share would need a custodied balance, a distribution
 *  trigger, a settlement checkpoint and a payee role — i.e. it would rebuild
 *  the exact permanent-claim/threshold-accumulate machinery this rewrite
 *  deleted. If the protocol ever wants to monetise this figure it belongs in
 *  a separately-audited contract that holds its own funds, reads this view,
 *  and never gets a lever over this one.
 *
 *  THE LP-YIELD BOOST: PUBLISHED HERE, PAID SOMEWHERE ELSE
 *  ------------------------------------------------------
 *  `boostMultiplier(gauge, account)` returns, in bps:
 *
 *      min(maxBoostBps, baseBoostBps
 *          + (maxBoostBps - baseBoostBps) * contribution_i / totalContribution)
 *
 *  which is the Curve veCRV boost shape: a floor everyone gets, rising toward
 *  a hard ceiling (2.5x by default, timelocked) with the account's share of
 *  this epoch's burn weight on that gauge.
 *
 *  THIS CONTRACT PAYS NONE OF IT. It cannot. It has no payable function, no
 *  ETH balance, no token custody, and no address of anything that does. The
 *  actual LP-fee boost is the responsibility of whichever contract earns real
 *  LP swap fees — the constituent vault (MarketplankVaultV3-shaped) — which
 *  may read this view and scale its own payouts by it. That contract holds
 *  its own funds and is audited on its own terms.
 *
 *  That separation is the whole structural argument. GlobalIndexVault's
 *  anchor guarantee #4 ("no role ever has a withdrawal path over pooled
 *  reserves") remains true here for the strongest possible reason: this
 *  contract has no withdrawal path over ANYTHING, because it has nothing.
 *  PlankGauge.audit.test.ts enumerates the ABI and the deployed bytecode and
 *  proves both the vault-reference claim and the no-payment-mechanism claim.
 * ============================================================================
 */

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ScopedRoles} from "./ScopedRoles.sol";

contract PlankGauge is ReentrancyGuard, ScopedRoles {
    using SafeERC20 for IERC20;

    /// @notice Generation marker. 2 = epoch-scoped publisher (this file);
    /// 1 was the permanent-claim/threshold-accumulate generation.
    uint256 public constant GAUGE_VERSION = 2;

    uint256 private constant BPS = 10_000;
    uint256 private constant WAD = 1e18;

    /// @notice Where every burn actually goes. Same constant the vault uses
    /// for its locked seed, and the same one-way property.
    address public constant BURN_ADDRESS = 0x000000000000000000000000000000000000dEaD;

    // ── Hard, contract-level ceilings ──────────────────────────────────────
    // Mirrors GlobalIndexVault's doctrine exactly: a timelock bounds WHEN a bad
    // change lands, never HOW BAD it can be. Compile-time constants — no admin,
    // no timelock, and no future governance can raise them.
    uint256 private constant MIN_TIMELOCK_DELAY = 48 hours;
    uint256 private constant MAX_TIMELOCK_DELAY = 30 days;
    uint256 private constant MIN_MULTIPLIER_BPS = BPS; // never below 1.0x
    uint256 private constant MAX_MULTIPLIER_BPS = 5 * BPS; // never above 5.0x
    uint256 private constant MIN_EPOCH_DURATION = 1 days;
    uint256 private constant MAX_EPOCH_DURATION = 90 days;
    /// @dev k = halves/2. [2, 8] => k in [1.0, 4.0]. Below 1.0 the penalty
    /// would be CONVEX in share and would reward concentration, which is the
    /// opposite of what the parameter exists for, so 1.0 is a hard floor.
    uint256 private constant MIN_EXPONENT_HALVES = 2;
    uint256 private constant MAX_EXPONENT_HALVES = 8;
    /// @dev Absolute boost ceiling. No governance can publish a 100x boost.
    uint256 private constant CEIL_BOOST_BPS = 5 * BPS; // 5.0x
    /**
     * @dev Hard ceiling on the per-address, per-gauge, per-epoch registration
     * burn. Compile-time, so no governance can set a registration cost so high
     * that honest participation becomes impossible — the ceiling exists to
     * bound HOW BAD a bad retune can be, exactly as every other bound here
     * does. 1,000,000 units at 18 decimals.
     */
    uint256 private constant MAX_REGISTRATION_BURN = 1_000_000 * 1e18;

    /// @dev Burn paths, in the order their multipliers are stored.
    uint8 public constant PATH_RAW = 0;
    uint8 public constant PATH_PLANK_ETH_LP = 1;
    uint8 public constant PATH_COLLECTION_LP = 2;

    // ── Storage ────────────────────────────────────────────────────────────

    /// @notice The PLANK token. Immutable — a mutable burn target is a mutable
    /// definition of what the whole accounting means.
    IERC20 public immutable plank;

    /// @notice Timelock delay, fixed at deploy. Not itself changeable, for the
    /// same reason the vault's is not: a mutable delay can be set to zero.
    uint256 public immutable timelockDelay;

    // ── Scoped administration roles (see ScopedRoles.sol) ──────────────────
    //
    // There is NO blanket admin. Each role sets FUTURE parameters only, within
    // its own enumerated scope, and none of them has a path to any burn record
    // or to any value, because this contract holds none.

    /// @notice The on-chain address registries: gauge registration/removal,
    /// the PLANK/ETH LP allowlist, the per-gauge collection-LP pairing, and
    /// the self-deal redirect sink. Every one of these is "which address is
    /// this credential" — a different question, and a different key, from
    /// "how steep is the curve". Cannot retune anything.
    bytes32 public constant ROLE_GAUGE_REGISTRY = "gauge.registry";

    /// @notice The curve: the three path multipliers, the concentration
    /// exponent, the boost floor/ceiling, and the epoch duration. Cannot
    /// register a gauge, an LP token, or a sink.
    bytes32 public constant ROLE_GAUGE_TUNING = "gauge.tuning";

    /// @notice bps multiplier per burn path, indexed by PATH_*.
    uint256[3] public multiplierBps;

    // ── Epoch clock ────────────────────────────────────────────────────────

    /// @notice Length of one epoch in seconds. Timelocked.
    uint256 public epochDuration;

    /// @dev Timestamp the current epoch numbering is measured from, and the
    /// index that timestamp corresponds to. Re-based (with the index jumped
    /// strictly forward) whenever `epochDuration` changes, so no epoch id is
    /// ever reused and no stale epoch's storage can be re-entered.
    uint256 public epochAnchorTime;
    uint256 public epochAnchorId;

    // ── Curve parameters ───────────────────────────────────────────────────

    /// @notice Concentration exponent k, stored as a fixed-point ratio over
    /// two: value 3 means k = 1.5. Timelocked.
    uint256 public concentrationExponentHalves;

    /// @notice Boost floor and ceiling in bps. 10_000 = 1.0x. Timelocked.
    uint256 public baseBoostBps;
    uint256 public maxBoostBps;

    /**
     * @notice PLANK destroyed the FIRST time an account acquires nonzero weight
     * in a gauge in an epoch. Buys no weight and no boost — it is the
     * asset-denominated per-identity cost that turns the sybil count from
     * gas-limited-and-unbounded into budget-limited-with-an-interior-optimum
     * at `N* = B/(2p)`. See "ROUND 9f" in the header for the derivation.
     *
     * Timelocked (ROLE_GAUGE_TUNING), bounded by `MAX_REGISTRATION_BURN`, and
     * ZERO BY DEFAULT — see the header for why shipping a nonzero default would
     * be a valuation claim this contract cannot support.
     */
    uint256 public registrationBurnPlank;

    /**
     * @notice SELF-DEAL REDIRECT SINK. Timelocked, and it is an ADDRESS THIS
     * CONTRACT PUBLISHES A CREDIT AGAINST, never an address it pays: this
     * contract still holds nothing and still moves nothing. Setting it is
     * subject to the same delay as every other parameter.
     *
     * See `_isSameAddressSelfDeal` for exactly what it catches and — much more
     * importantly — exactly what it does not.
     */
    address public redirectSink;

    // ── Registries (unchanged from the previous generation) ────────────────

    /// @notice Registered gauges. A gauge id is a constituent identifier — in
    /// practice the collection's v-token address, the same key
    /// lib/market/vault-registry.ts resolves vaults by.
    mapping(address => bool) public gaugeRegistered;
    address[] private gaugeList;

    /// @notice Allowlisted PLANK/ETH LP tokens (the approved DEX pair
    /// contracts). An arbitrary ERC-20 claiming to be an LP token is never
    /// trusted — the address itself is the credential.
    mapping(address => bool) public approvedPlankEthLp;

    /// @notice Allowlisted collection v-token LP token, keyed to the gauge it
    /// deepens. Registering it requires naming the real vault address it
    /// belongs to, so the pairing is explicit on-chain and auditable.
    mapping(address => address) public collectionLpOf; // gauge => LP token
    mapping(address => address) public collectionVaultOf; // gauge => vault

    // ── Epoch-scoped burn accounting (the whole mechanism) ─────────────────
    //
    // EVERY mapping below is keyed by epoch first. Nothing is carried forward,
    // nothing decays, nothing is migrated: a new epoch reads virgin slots.

    /// @notice epoch => gauge => account => multiplier-weighted burned amount.
    mapping(uint256 => mapping(address => mapping(address => uint256)))
        public epochWeightedBurn;

    /// @notice epoch => gauge => account => sqrt(epochWeightedBurn), cached so
    /// the total can be maintained incrementally instead of re-summed.
    mapping(uint256 => mapping(address => mapping(address => uint256)))
        public epochContribution;

    /// @notice epoch => gauge => sum of every account's contribution.
    mapping(uint256 => mapping(address => uint256)) public epochTotalContribution;

    /// @dev epoch => gauge => the accounts that burned into it, in first-burn
    /// order. Only ever read by the `protocolShareWad` reporting view, which
    /// is off-chain-called; no state-changing path iterates it.
    mapping(uint256 => mapping(address => address[])) private epochBurners;

    // ── Timelock queues (identical shape to GlobalIndexVault) ──────────────

    struct QueuedParam {
        uint256 value;
        uint64 eta;
        bool pending;
    }

    struct QueuedAllowlist {
        address token;
        address vault; // only meaningful for collection LP registrations
        uint64 eta;
        bool pending;
        bool isRemoval;
    }

    mapping(bytes32 => QueuedParam) public queuedParams;
    mapping(bytes32 => QueuedAllowlist) public queuedAllowlists;
    QueuedParam public queuedRedirectSink;

    // ── Events ─────────────────────────────────────────────────────────────

    event Burned(
        address indexed gauge,
        address indexed burner,
        uint8 indexed path,
        address token,
        uint256 amount,
        uint256 epoch,
        uint256 contribution
    );
    event ParamQueued(bytes32 indexed key, uint256 value, uint64 eta);
    event ParamApplied(bytes32 indexed key, uint256 value);
    event EpochRebased(uint256 anchorIndex, uint256 anchorTime, uint256 duration);
    event AllowlistQueued(bytes32 indexed key, address token, uint64 eta, bool removal);
    event GaugeRegistered(address indexed gauge);
    event GaugeUnregistered(address indexed gauge);
    event PlankEthLpApproved(address indexed token, bool approved);
    event CollectionLpApproved(address indexed gauge, address token, address vault);
    /// @notice A per-identity registration cost was DESTROYED (not paid) so
    /// `account` could hold weight in `gauge` this epoch. Buys no weight.
    event RegistrationBurned(address indexed gauge, address indexed account, uint256 amount);
    event RedirectSinkQueued(address indexed next, uint64 eta);
    event RedirectSinkApplied(address indexed next);
    /// @notice A burn whose directing address was provably the same address as
    /// the entity the boost would benefit. The weight went to `to`, not `from`.
    event SelfDealRedirected(
        address indexed gauge,
        address indexed from,
        address indexed to,
        uint256 weighted
    );

    // ── Errors ─────────────────────────────────────────────────────────────

    error BadParam();
    error NothingQueued();
    error TimelockNotElapsed();
    error ZeroAmount();
    error UnknownGauge();
    error GaugeAlreadyRegistered();
    error NotApprovedLp();
    error ShortBurn();
    error SelfDealing();

    // ── Construction ───────────────────────────────────────────────────────

    /**
     * @param roles_ The three scoped role holders, in the fixed order
     *        [ROLE_ADMIN, ROLE_GAUGE_REGISTRY, ROLE_GAUGE_TUNING].
     */
    constructor(
        IERC20 plank_,
        address[3] memory roles_,
        uint256 timelockDelay_,
        uint256[3] memory multiplierBps_,
        uint256 epochDuration_
    ) {
        if (address(plank_) == address(0)) revert BadParam();
        if (timelockDelay_ < MIN_TIMELOCK_DELAY || timelockDelay_ > MAX_TIMELOCK_DELAY) {
            revert BadParam();
        }
        for (uint256 i = 0; i < 3; i++) _validateMultiplier(multiplierBps_[i]);
        // Ordering is part of the design, not an accident: LP burns must never
        // be worth less than the raw burn they strictly dominate.
        if (multiplierBps_[PATH_PLANK_ETH_LP] < multiplierBps_[PATH_RAW]) revert BadParam();
        if (multiplierBps_[PATH_COLLECTION_LP] < multiplierBps_[PATH_PLANK_ETH_LP]) {
            revert BadParam();
        }
        if (epochDuration_ < MIN_EPOCH_DURATION || epochDuration_ > MAX_EPOCH_DURATION) {
            revert BadParam();
        }

        _initRole(ROLE_ADMIN, roles_[0]);
        _initRole(ROLE_GAUGE_REGISTRY, roles_[1]);
        _initRole(ROLE_GAUGE_TUNING, roles_[2]);

        plank = plank_;
        timelockDelay = timelockDelay_;
        multiplierBps = multiplierBps_;
        epochDuration = epochDuration_;
        epochAnchorTime = block.timestamp;
        epochAnchorId = 1; // start at 1 so "epoch 0" is never a live epoch
        concentrationExponentHalves = 3; // k = 1.5
        baseBoostBps = BPS; // 1.0x floor
        maxBoostBps = 25_000; // 2.5x ceiling, Curve-veCRV-shaped
    }

    function _timelockDelay() internal view override returns (uint256) {
        return timelockDelay;
    }

    function _isKnownRole(bytes32 role) internal pure override returns (bool) {
        return role == ROLE_ADMIN || role == ROLE_GAUGE_REGISTRY || role == ROLE_GAUGE_TUNING;
    }

    // ══ The epoch clock ═══════════════════════════════════════════════════

    /// @notice The live epoch id. Monotonically non-decreasing forever,
    /// including across an `epochDuration` retune.
    function currentEpoch() public view returns (uint256) {
        return epochAnchorId + (block.timestamp - epochAnchorTime) / epochDuration;
    }

    /// @notice Timestamp at which the current epoch ends and every gauge's
    /// weight becomes zero again. Nothing has to be called at that moment —
    /// the reset is a consequence of the storage key changing, not of an
    /// action anyone has to remember to take.
    function epochEndsAt() public view returns (uint256) {
        uint256 elapsed = block.timestamp - epochAnchorTime;
        return epochAnchorTime + ((elapsed / epochDuration) + 1) * epochDuration;
    }

    // ══ Burn paths ════════════════════════════════════════════════════════

    /// @notice Burn raw PLANK toward `gauge`, for THIS epoch only.
    function burnPlank(address gauge, uint256 amount)
        external
        nonReentrant
        returns (uint256 contribution)
    {
        return _burnFor(gauge, address(plank), amount, PATH_RAW);
    }

    /**
     * @notice Burn an APPROVED PLANK/ETH LP token toward `gauge`.
     * @dev `lpToken` is checked against the allowlist, never sniffed. A token
     * that merely claims to be a PLANK/ETH pair — same name, same symbol,
     * same `token0()`/`token1()` answers — earns nothing here.
     */
    function burnPlankEthLp(address gauge, address lpToken, uint256 amount)
        external
        nonReentrant
        returns (uint256 contribution)
    {
        if (!approvedPlankEthLp[lpToken]) revert NotApprovedLp();
        return _burnFor(gauge, lpToken, amount, PATH_PLANK_ETH_LP);
    }

    /**
     * @notice Burn the APPROVED v-token LP for `gauge`'s own collection.
     * @dev The allowlist is keyed to the gauge, so this path cannot be used to
     * point one collection's liquidity burn at a different collection's gauge.
     */
    function burnCollectionLp(address gauge, uint256 amount)
        external
        nonReentrant
        returns (uint256 contribution)
    {
        address lp = collectionLpOf[gauge];
        if (lp == address(0)) revert NotApprovedLp();
        return _burnFor(gauge, lp, amount, PATH_COLLECTION_LP);
    }

    function _burnFor(address gauge, address token, uint256 amount, uint8 path)
        private
        returns (uint256 contribution)
    {
        if (!gaugeRegistered[gauge]) revert UnknownGauge();
        if (amount == 0) revert ZeroAmount();

        // Credit the ACTUAL delta at the dead address, never the nominal
        // amount — same Balancer-STA discipline GlobalIndexVault._pullCredited
        // applies. A fee-on-transfer token would otherwise buy weight it never
        // destroyed.
        uint256 before = IERC20(token).balanceOf(BURN_ADDRESS);
        IERC20(token).safeTransferFrom(msg.sender, BURN_ADDRESS, amount);
        uint256 burned = IERC20(token).balanceOf(BURN_ADDRESS) - before;
        if (burned == 0) revert ZeroAmount();
        if (burned > amount) revert ShortBurn(); // rebasing/odd token; refuse

        uint256 weighted = (burned * multiplierBps[path]) / BPS;
        if (weighted == 0) revert ZeroAmount();

        // SELF-DEAL REDIRECT (the narrow, honestly-detectable case only).
        // The tokens still come from `msg.sender` and still go to dEaD — the
        // destruction is real either way. What changes is WHO the resulting
        // weight and boost are credited to.
        address beneficiary = msg.sender;
        if (_isSameAddressSelfDeal(gauge, msg.sender)) {
            address sink = redirectSink;
            // With no sink appointed there is nowhere honest to put it, and
            // crediting the self-dealer anyway would make the check
            // decorative. Refusing is the conservative resolution: it costs a
            // self-dealer a transaction, and it costs an honest party nothing,
            // because an honest party is never one of these addresses.
            if (sink == address(0)) revert SelfDealing();
            beneficiary = sink;
            emit SelfDealRedirected(gauge, msg.sender, sink, weighted);
        }

        uint256 e = currentEpoch();
        uint256 prevWeighted = epochWeightedBurn[e][gauge][beneficiary];
        uint256 prevContribution = epochContribution[e][gauge][beneficiary];

        // ROUND 9f — THE PER-IDENTITY REGISTRATION BURN. Charged once per
        // (epoch, gauge, beneficiary), on the first burn that gives that
        // address weight. It buys NOTHING: the PLANK is destroyed and no
        // weight, contribution or boost is credited for it. Keyed on
        // `beneficiary` rather than `msg.sender` so a redirected self-deal
        // cannot register the sink for free, and so one address paying for
        // many gauges pays once per gauge, which is the unit the sybil count
        // is actually measured in.
        if (prevContribution == 0) _chargeRegistration(gauge, beneficiary);
        uint256 nextWeighted = prevWeighted + weighted;
        // sqrt DAMPENING. Applied to the account's epoch TOTAL rather than to
        // each burn separately, deliberately: per-burn sqrt would mean ten
        // small burns beat one large one from the same wallet, which is the
        // sybil incentive turned inward and would make the accounting depend
        // on transaction chunking. One wallet, one epoch, one sqrt.
        contribution = Math.sqrt(nextWeighted);
        if (contribution == 0) revert ZeroAmount();

        if (prevContribution == 0) epochBurners[e][gauge].push(beneficiary);
        epochWeightedBurn[e][gauge][beneficiary] = nextWeighted;
        epochContribution[e][gauge][beneficiary] = contribution;
        epochTotalContribution[e][gauge] += contribution - prevContribution;

        emit Burned(gauge, beneficiary, path, token, burned, e, contribution);
    }

    /**
     * @dev THE NARROW, PROVABLE SELF-DEAL CASE — and an honest statement of
     * the far larger one that is not detectable at all.
     *
     * WHAT IS CAUGHT. Exactly one thing: the address directing the burn is,
     * bit for bit, an address this contract can already see standing on the
     * other side of the benefit the burn buys. Concretely, `who` is
     *
     *   - the GAUGE ITSELF (`gauge`), whose weight the burn is buying; or
     *   - the gauge's registered VAULT (`collectionVaultOf[gauge]`), the
     *     contract that earns the LP swap fees a boost on this gauge scales;
     *     or
     *   - the gauge's registered LP TOKEN (`collectionLpOf[gauge]`), the
     *     position whose yield the boost applies to.
     *
     * All three are addresses the admin explicitly registered on-chain, in a
     * timelocked action, naming the pairing. So the equality test here is over
     * facts this contract already holds — no heuristic, no inference, no
     * probability. When it fires, it is certain.
     *
     * WHAT IS NOT CAUGHT, AND WILL NOT BE. Cross-wallet self-dealing — the
     * same human operating the vault from one key and directing the burn from
     * another — is NOT detectable here and is NOT detectable by any
     * permissionless EVM contract without an identity layer. Two addresses
     * that never transact with each other are, to this contract, two people.
     * This is the same limitation, from the same root cause, that
     * PlankGauge's header already documents for sqrt burn-splitting: an
     * identity-free system cannot count parties, only addresses. Nothing in
     * this function should be read as closing that gap, and no future change
     * should try to close it with a heuristic (shared funding source, timing
     * correlation, nonce patterns) — every such heuristic is either trivially
     * evaded by an attacker who cares or fires on honest users who do not,
     * and usually both.
     *
     * So the honest claim is narrow and it is the whole claim: the case where
     * a single address is provably on both sides is caught and redirected; the
     * case where two addresses are the same person is open, known, and
     * unclosed.
     */
    function _isSameAddressSelfDeal(address gauge, address who) private view returns (bool) {
        if (who == gauge) return true;
        if (who != address(0) && who == collectionVaultOf[gauge]) return true;
        if (who != address(0) && who == collectionLpOf[gauge]) return true;
        return false;
    }

    // ══ Published weights ═════════════════════════════════════════════════

    /**
     * @notice THE number this contract exists to publish: `gauge`'s voting
     * weight for the CURRENT epoch. Zero at every epoch boundary, with no
     * action required to make it zero.
     */
    function gaugeWeight(address gauge) external view returns (uint256) {
        return epochTotalContribution[currentEpoch()][gauge];
    }

    /// @notice `gauge`'s weight in a specific (possibly past) epoch. Provided
    /// so the reset is provable rather than merely claimed.
    function gaugeWeightAt(address gauge, uint256 epoch) external view returns (uint256) {
        return epochTotalContribution[epoch][gauge];
    }

    /// @notice One account's sqrt-dampened contribution this epoch.
    function accountWeight(address gauge, address account) public view returns (uint256) {
        return epochContribution[currentEpoch()][gauge][account];
    }

    /// @notice One account's raw (pre-penalty) share of `gauge` this epoch, in
    /// WAD. 1e18 = 100%.
    function rawShareWad(address gauge, address account) public view returns (uint256) {
        uint256 e = currentEpoch();
        uint256 total = epochTotalContribution[e][gauge];
        if (total == 0) return 0;
        return Math.mulDiv(epochContribution[e][gauge][account], WAD, total);
    }

    /// @notice The concentration penalty applied to `account`, in WAD:
    /// `rawShare ^ k`, with k = concentrationExponentHalves / 2.
    function concentrationPenaltyWad(address gauge, address account)
        public
        view
        returns (uint256)
    {
        return _powHalves(rawShareWad(gauge, account), concentrationExponentHalves);
    }

    /// @notice `rawShare * (1 - rawShare^k)`, in WAD. What a payer honouring
    /// this gauge would actually weight the account by.
    function effectiveShareWad(address gauge, address account) public view returns (uint256) {
        uint256 raw = rawShareWad(gauge, account);
        if (raw == 0) return 0;
        uint256 penalty = _powHalves(raw, concentrationExponentHalves);
        if (penalty >= WAD) return 0;
        return Math.mulDiv(raw, WAD - penalty, WAD);
    }

    /**
     * @notice The penalized remainder for `gauge` this epoch, in WAD.
     *
     * REPORTING FIGURE ONLY. There is no claim path for this value and there
     * must not be one: making it payable would require a custodied balance, a
     * distribution trigger and a payee role — i.e. it would rebuild the whole
     * permanent-claim/threshold-accumulate machinery this generation deleted.
     * The timelocked admin can read it, the same as anybody else can, and that
     * is the entire extent of anyone's relationship with it.
     *
     * O(burners) in the epoch. A pure view with no state-changing caller, so
     * an epoch with many burners costs an off-chain call more time and costs
     * the chain nothing.
     */
    function protocolShareWad(address gauge) external view returns (uint256) {
        uint256 e = currentEpoch();
        if (epochTotalContribution[e][gauge] == 0) return 0;
        address[] storage burners = epochBurners[e][gauge];
        uint256 assigned;
        for (uint256 i = 0; i < burners.length; i++) {
            assigned += effectiveShareWad(gauge, burners[i]);
        }
        return assigned >= WAD ? 0 : WAD - assigned;
    }

    /// @notice How many distinct accounts burned into `gauge` this epoch.
    function burnerCount(address gauge) external view returns (uint256) {
        return epochBurners[currentEpoch()][gauge].length;
    }

    function burnerAt(address gauge, uint256 i) external view returns (address) {
        return epochBurners[currentEpoch()][gauge][i];
    }

    /**
     * @notice THE OTHER number this contract publishes: a Curve-veCRV-shaped
     * LP-yield boost multiplier for `account` on `gauge`, in bps.
     *
     *     min(maxBoostBps,
     *         baseBoostBps + (maxBoostBps - baseBoostBps) * contrib / total)
     *
     * NOTHING IS PAID HERE. This contract has no payable function, no token
     * custody and no reference to any contract that has either. The actual
     * LP-fee boost is applied by whichever contract earns the real LP swap
     * fees — the constituent vault — which may read this and scale its own
     * payouts. That contract holds its own funds and is audited separately;
     * this one is a view over burns and nothing more.
     */
    function boostMultiplier(address gauge, address account) external view returns (uint256 bps) {
        uint256 e = currentEpoch();
        uint256 total = epochTotalContribution[e][gauge];
        uint256 base = baseBoostBps;
        uint256 max_ = maxBoostBps;
        if (total == 0) return base;
        bps = base + Math.mulDiv(max_ - base, epochContribution[e][gauge][account], total);
        if (bps > max_) bps = max_;
    }

    // ══ Views ═════════════════════════════════════════════════════════════

    function gaugeCount() external view returns (uint256) {
        return gaugeList.length;
    }

    function gaugeAt(uint256 i) external view returns (address) {
        return gaugeList[i];
    }

    function listGauges() external view returns (address[] memory) {
        return gaugeList;
    }

    /// @notice Self-describing capability flags. `paysRewards` is hardcoded
    /// FALSE and is a structural fact, not a setting: there is no payable
    /// function on this ABI to make it true.
    function capabilities()
        external
        pure
        returns (bool burnDirected, bool epochScoped, bool paysRewards, uint256 version)
    {
        return (true, true, false, GAUGE_VERSION);
    }

    // ══ Timelocked administration ═════════════════════════════════════════
    //
    // EVERY function below affects FUTURE parameter values only. None of them
    // can move a burn record, and none of them can move value, because this
    // contract holds no value of any kind.

    /**
     * @notice Which role may queue `key`. Reverts for anything unrecognised.
     *
     * @dev The revert-on-unknown is load-bearing, not tidiness: `queuedParams`
     * is a shared mapping, and without a whitelist the tuning role could write
     * a `keccak256("gauge", g)`-shaped key and have an allowlist executor pick
     * it up, which would hand it the registry role's power. Note the two key
     * spaces already differ in shape (`queuedAllowlists` is a separate
     * mapping), so this is defence in depth — kept because "the other mapping
     * happens not to collide today" is not an access-control argument.
     */
    function roleForParamKey(bytes32 key) public pure returns (bytes32) {
        if (
            key == "multiplierRawBps" ||
            key == "multiplierPlankEthLpBps" ||
            key == "multiplierCollectionLpBps" ||
            key == "epochDuration" ||
            key == "concentrationExponentHalves" ||
            key == "baseBoostBps" ||
            key == "maxBoostBps" ||
            key == "registrationBurnPlank"
        ) return ROLE_GAUGE_TUNING;
        revert BadParam();
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

        if (key == "multiplierRawBps") {
            _validateMultiplier(q.value);
            if (q.value > multiplierBps[PATH_PLANK_ETH_LP]) revert BadParam();
            multiplierBps[PATH_RAW] = q.value;
        } else if (key == "multiplierPlankEthLpBps") {
            _validateMultiplier(q.value);
            if (q.value < multiplierBps[PATH_RAW]) revert BadParam();
            if (q.value > multiplierBps[PATH_COLLECTION_LP]) revert BadParam();
            multiplierBps[PATH_PLANK_ETH_LP] = q.value;
        } else if (key == "multiplierCollectionLpBps") {
            _validateMultiplier(q.value);
            if (q.value < multiplierBps[PATH_PLANK_ETH_LP]) revert BadParam();
            multiplierBps[PATH_COLLECTION_LP] = q.value;
        } else if (key == "epochDuration") {
            if (q.value < MIN_EPOCH_DURATION || q.value > MAX_EPOCH_DURATION) revert BadParam();
            // Re-base the clock and jump the index strictly PAST every id that
            // has ever been live, so changing the cadence can never land back
            // on an epoch whose storage still holds burns.
            epochAnchorId = currentEpoch() + 1;
            epochAnchorTime = block.timestamp;
            epochDuration = q.value;
            emit EpochRebased(epochAnchorId, epochAnchorTime, q.value);
        } else if (key == "concentrationExponentHalves") {
            if (q.value < MIN_EXPONENT_HALVES || q.value > MAX_EXPONENT_HALVES) revert BadParam();
            concentrationExponentHalves = q.value;
        } else if (key == "baseBoostBps") {
            if (q.value < BPS || q.value > maxBoostBps) revert BadParam();
            baseBoostBps = q.value;
        } else if (key == "maxBoostBps") {
            if (q.value < baseBoostBps || q.value > CEIL_BOOST_BPS) revert BadParam();
            maxBoostBps = q.value;
        } else if (key == "registrationBurnPlank") {
            if (q.value > MAX_REGISTRATION_BURN) revert BadParam();
            registrationBurnPlank = q.value;
        } else {
            revert BadParam();
        }
        emit ParamApplied(key, q.value);
    }

    /// @notice Queue a gauge registration (or removal).
    function queueGauge(address gauge, bool isRemoval) external onlyRole(ROLE_GAUGE_REGISTRY) {
        if (gauge == address(0)) revert BadParam();
        bytes32 key = keccak256(abi.encodePacked("gauge", gauge));
        uint64 eta = uint64(block.timestamp + timelockDelay);
        queuedAllowlists[key] = QueuedAllowlist({
            token: gauge,
            vault: address(0),
            eta: eta,
            pending: true,
            isRemoval: isRemoval
        });
        emit AllowlistQueued(key, gauge, eta, isRemoval);
    }

    /**
     * @notice Apply a queued gauge change after the delay.
     * @dev Un-registering STOPS new burns. It never deletes anyone's recorded
     * burn for the epoch in flight — deleting it is a confiscation, and a
     * confiscation is precisely the class of admin power this whole design is
     * built to not have. Re-registering restores the same book. Note that
     * with epoch scoping the blast radius of an un-registration is bounded by
     * construction: whatever it freezes expires at the epoch boundary anyway.
     */
    function executeGauge(address gauge) external {
        bytes32 key = keccak256(abi.encodePacked("gauge", gauge));
        QueuedAllowlist memory q = queuedAllowlists[key];
        if (!q.pending) revert NothingQueued();
        if (block.timestamp < q.eta) revert TimelockNotElapsed();
        delete queuedAllowlists[key];

        if (q.isRemoval) {
            if (!gaugeRegistered[gauge]) revert UnknownGauge();
            gaugeRegistered[gauge] = false;
            uint256 n = gaugeList.length;
            for (uint256 i = 0; i < n; i++) {
                if (gaugeList[i] == gauge) {
                    gaugeList[i] = gaugeList[n - 1];
                    gaugeList.pop();
                    break;
                }
            }
            emit GaugeUnregistered(gauge);
        } else {
            if (gaugeRegistered[gauge]) revert GaugeAlreadyRegistered();
            gaugeRegistered[gauge] = true;
            gaugeList.push(gauge);
            emit GaugeRegistered(gauge);
        }
    }

    /// @notice Queue an approved PLANK/ETH LP pair address.
    function queuePlankEthLp(address lpToken, bool isRemoval)
        external
        onlyRole(ROLE_GAUGE_REGISTRY)
    {
        if (lpToken == address(0)) revert BadParam();
        bytes32 key = keccak256(abi.encodePacked("plankEthLp", lpToken));
        uint64 eta = uint64(block.timestamp + timelockDelay);
        queuedAllowlists[key] = QueuedAllowlist({
            token: lpToken,
            vault: address(0),
            eta: eta,
            pending: true,
            isRemoval: isRemoval
        });
        emit AllowlistQueued(key, lpToken, eta, isRemoval);
    }

    function executePlankEthLp(address lpToken) external {
        bytes32 key = keccak256(abi.encodePacked("plankEthLp", lpToken));
        QueuedAllowlist memory q = queuedAllowlists[key];
        if (!q.pending) revert NothingQueued();
        if (block.timestamp < q.eta) revert TimelockNotElapsed();
        delete queuedAllowlists[key];
        approvedPlankEthLp[lpToken] = !q.isRemoval;
        emit PlankEthLpApproved(lpToken, !q.isRemoval);
    }

    /**
     * @notice Queue the approved v-token LP for one gauge's collection.
     * @param vault the real vault (v-token) address the LP belongs to. Stored
     * so the pairing is on-chain and auditable rather than an off-chain claim.
     */
    function queueCollectionLp(address gauge, address lpToken, address vault, bool isRemoval)
        external
        onlyRole(ROLE_GAUGE_REGISTRY)
    {
        if (gauge == address(0)) revert BadParam();
        if (!isRemoval && (lpToken == address(0) || vault == address(0))) revert BadParam();
        bytes32 key = keccak256(abi.encodePacked("collectionLp", gauge));
        uint64 eta = uint64(block.timestamp + timelockDelay);
        queuedAllowlists[key] = QueuedAllowlist({
            token: lpToken,
            vault: vault,
            eta: eta,
            pending: true,
            isRemoval: isRemoval
        });
        emit AllowlistQueued(key, lpToken, eta, isRemoval);
    }

    function executeCollectionLp(address gauge) external {
        bytes32 key = keccak256(abi.encodePacked("collectionLp", gauge));
        QueuedAllowlist memory q = queuedAllowlists[key];
        if (!q.pending) revert NothingQueued();
        if (block.timestamp < q.eta) revert TimelockNotElapsed();
        delete queuedAllowlists[key];
        if (q.isRemoval) {
            collectionLpOf[gauge] = address(0);
            collectionVaultOf[gauge] = address(0);
            emit CollectionLpApproved(gauge, address(0), address(0));
        } else {
            collectionLpOf[gauge] = q.token;
            collectionVaultOf[gauge] = q.vault;
            emit CollectionLpApproved(gauge, q.token, q.vault);
        }
    }

    // Role handover lives in ScopedRoles: `queueRole` / `executeRole`, on the
    // same `timelockDelay` the old single-admin handover used.

    /**
     * @notice Queue the self-deal redirect sink (address(0) to retire it).
     * @dev Grants the sink NOTHING that any other address does not already
     * have: it receives published WEIGHT, in a contract that has no payable
     * function, no balance and no payer. Whether a downstream contract chooses
     * to honour that weight is entirely that contract's decision, made with
     * its own funds under its own audit — which is the same relationship every
     * burner already has with the numbers published here.
     */
    function queueRedirectSink(address sink) external onlyRole(ROLE_GAUGE_REGISTRY) {
        uint64 eta = uint64(block.timestamp + timelockDelay);
        queuedRedirectSink = QueuedParam({
            value: uint256(uint160(sink)),
            eta: eta,
            pending: true
        });
        emit RedirectSinkQueued(sink, eta);
    }

    function executeRedirectSink() external {
        QueuedParam memory q = queuedRedirectSink;
        if (!q.pending) revert NothingQueued();
        if (block.timestamp < q.eta) revert TimelockNotElapsed();
        delete queuedRedirectSink;
        redirectSink = address(uint160(q.value));
        emit RedirectSinkApplied(redirectSink);
    }

    // ── Internals ──────────────────────────────────────────────────────────

    /**
     * @dev Destroy the registration cost. A BURN, never a payment: the PLANK
     * moves from `msg.sender` straight to `BURN_ADDRESS`, this contract is
     * never in the path and never holds a unit of it, so the no-custody /
     * no-payment-surface property is untouched. Same measured-delta discipline
     * as the weight-bearing paths — a token that under-delivers cannot register
     * an address for less than the posted cost.
     */
    function _chargeRegistration(address gauge, address account) private {
        uint256 fee = registrationBurnPlank;
        if (fee == 0) return;
        uint256 before = plank.balanceOf(BURN_ADDRESS);
        plank.safeTransferFrom(msg.sender, BURN_ADDRESS, fee);
        if (plank.balanceOf(BURN_ADDRESS) - before < fee) revert ShortBurn();
        emit RegistrationBurned(gauge, account, fee);
    }

    function _validateMultiplier(uint256 bps) private pure {
        if (bps < MIN_MULTIPLIER_BPS || bps > MAX_MULTIPLIER_BPS) revert BadParam();
    }

    /**
     * @dev x^(halves/2) for x in WAD, exactly — no exp/ln approximation.
     * s^(n/2) == (sqrt s)^n, and sqrt of a WAD value is
     * `Math.sqrt(x * WAD)` (still WAD-scaled). Then n integer multiplies.
     * Rounding is DOWN at every step, which under-states the penalty; the
     * conservative direction here is the one that never over-penalises a
     * burner for a rounding artefact.
     */
    function _powHalves(uint256 xWad, uint256 halves) private pure returns (uint256) {
        if (xWad == 0) return 0;
        uint256 root = Math.sqrt(xWad * WAD);
        uint256 acc = WAD;
        for (uint256 i = 0; i < halves; i++) {
            acc = Math.mulDiv(acc, root, WAD);
        }
        return acc;
    }
}
