// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ScopedRoles} from "./ScopedRoles.sol";

/**
 * @dev The exact, minimal slice of GlobalIndexVault this wrapper depends on.
 * All three members are already `public`/`external` on the real contract —
 * `dividendAsset` (public immutable), `claimDividend()` and
 * `withdrawableDividendOf()`. Nothing was added to the vault for this file.
 */
interface IIndexDividendShare is IERC20 {
    function dividendAsset() external view returns (address);

    function claimDividend() external returns (uint256 amount);

    function withdrawableDividendOf(address account) external view returns (uint256);
}

/**
 * ============================================================================
 *  WrappedIndexShare — wIDX, the opt-in composability wrapper
 *
 *  NOT FOR DEPLOYMENT, same gate as GlobalIndexVault.sol. Local Hardhat only.
 *
 *  THE PROBLEM
 *  -----------
 *  GlobalIndexVault pays dividends through a magnified-dividend-per-share
 *  accumulator computed live off `balanceOf`. That is exactly right for a
 *  holder who holds in their own wallet, and exactly wrong the moment the
 *  share is deposited into a third-party contract. An LP pool, a lending
 *  market, any custodying protocol becomes the holder of record; IT accrues
 *  the dividend, and it has never heard of `claimDividend()`. The value is not
 *  lost — it is claimable forever by an address whose operator has no reason
 *  to know it exists.
 *
 *  THE FIX, AND ITS PRECEDENT
 *  --------------------------
 *  Lido's wstETH, at billions of TVL, against the identical failure mode:
 *  stETH's rebasing balance breaks inside pools, so wrap it into a
 *  FIXED-BALANCE token whose EXCHANGE RATE appreciates instead. A pool holding
 *  a fixed-balance token needs no integration, no hook, no awareness — its
 *  holdings simply become worth more.
 *
 *  ROUND 9d — THE SAME FIX, GENERALISED TO N REWARD STREAMS
 *  --------------------------------------------------------
 *  The wrapper originally backed wIDX with exactly TWO assets: raw index
 *  shares (R) and the vault's own harvested dividend asset (D). But the
 *  stranding bug it exists to solve is not specific to that one dividend. A
 *  third-party bribe, an RWA airdrop, a partner incentive — ANY token someone
 *  wants to route to index-share holders — hits the identical wall: pooled
 *  shares are held by a custodian that will never claim it.
 *
 *  So backing is now an ARBITRARY SET of assets: R, D, and up to
 *  `MAX_STREAMS` whitelisted "stream" tokens. Every one of them is redeemed
 *  pro rata on `withdraw`, in its own native units.
 *
 *  THE ARCHITECTURAL RULE THIS FILE WILL NOT BREAK
 *  ----------------------------------------------
 *  ONLY BACKING-POOL APPRECIATION REACHES A POOLED HOLDER. A per-holder
 *  correction-term accumulator — the mechanism GlobalIndexVault uses, the
 *  mechanism this wrapper exists to work around — DOES NOT. Adding a new
 *  reward stream via per-holder accounting would silently reintroduce the
 *  exact stranding bug one level up: the LP pool would become the accruer of
 *  record for the bribe, and the bribe would be as stranded as the dividend
 *  was. Every stream therefore folds into the SAME aggregate backing pool,
 *  read from live balances, redeemed by exchange rate. There is no per-holder
 *  reward state anywhere in this contract, and there must never be.
 *
 *  (`pendingClaim` below is NOT a counterexample. It is not a reward
 *  accumulator: nothing accrues into it. It only holds an amount that was
 *  ALREADY computed pro rata and ALREADY left the backing pool, whose
 *  transfer bounced. See "THE RESTRICTED-ASSET PROBLEM".)
 *
 *  WHAT IS AND IS NOT ADMINISTERED
 *  -------------------------------
 *  The wrapper previously had NO roles at all. It now has exactly ONE
 *  capability behind a role, and the boundary is worth stating precisely,
 *  because the no-lever property is the reason anyone would trust this thing:
 *
 *    ROLE_STREAM_LISTER can do exactly two things — queue a token onto the
 *    stream whitelist (timelocked), and remove a token from it. That is the
 *    whole surface. It CANNOT touch backing, cannot move a token the wrapper
 *    already holds, cannot pause, cannot block or delay `withdraw`, cannot
 *    reach `deposit`, `harvest`, `claimPending`, the raw share leg or the
 *    dividend leg, and cannot mint, burn or freeze a single wIDX.
 *    DELISTING NEVER CLAWS BACK HELD BACKING (see `delistStream`).
 *
 *  Whitelisting is deliberately NOT permissionless. A stream token is code
 *  this contract will `transfer` to a user inside `withdraw` and `balanceOf`
 *  inside its own pricing; letting anyone push an arbitrary contract into
 *  that position is an open invitation. The gate is an admission decision,
 *  not a value decision — see `queueStream`'s NatSpec for the full list of
 *  judgment calls the listing role is accepting responsibility for.
 *
 *  `depositStream` — actually PUTTING value into an already-listed stream —
 *  IS permissionless, which is the part that matters: a bribe or an
 *  airdrop-forwarder funds a stream with no permission from anybody.
 *
 *  HOW THE RATE APPRECIATES — WITH ZERO MARKET RISK
 *  ------------------------------------------------
 *  Because this contract holds raw shares, it IS a direct holder, so the
 *  vault's own correction-term mechanism accrues its dividend automatically.
 *  `harvest()` is a permissionless public-good trigger that calls
 *  `claimDividend()` and pulls in what was ALREADY earned. No swap. No price.
 *  No oracle. No slippage. No route.
 *
 *  WHY STREAMS HAVE NO `harvest` OF THEIR OWN — AND SHOULD NOT
 *  ----------------------------------------------------------
 *  `harvest()` is not a generic "collect rewards" step. It does exactly one
 *  thing no other function can: it calls `GlobalIndexVault.claimDividend()`,
 *  moving value the vault is HOLDING FOR THIS CONTRACT under a per-holder
 *  accumulator into this contract's balance. It is a PULL, and it is needed
 *  precisely because the vault's dividend is per-holder state.
 *
 *  Streams have no such holding contract and no such accumulator. They are
 *  PUSHED: `depositStream` moves the tokens into this contract in the same
 *  transaction that funds them, and backing is read from live balances, so
 *  the value is in the backing pool the instant it lands. There is nothing
 *  left to pull. A `harvestStream()` would be a function whose entire body is
 *  a no-op, and shipping one would imply an integrator must call it or lose
 *  value — a lie that would eventually strand somebody. The two flows differ
 *  because the two mechanisms differ, and this file says so rather than
 *  forcing them into a matching shape.
 *
 *  (Even a raw, unsolicited `transfer` of a listed stream token straight to
 *  this address needs no call at all: live-balance backing means a donation
 *  is credited to every holder on arrival. `depositStream` exists for the
 *  measured-delta accounting and the event, not because a push is required.)
 *
 *  The batch convenience that IS meaningful is on the OTHER side — see
 *  `claimPendingMany`.
 *
 *  THE JOIN, AND WHAT IT DOES AND DOES NOT CHARGE FOR. READ THIS.
 *  -------------------------------------------------------------
 *  `deposit` takes RAW SHARES ONLY, and prices the mint against the raw leg
 *  alone, plus the proportional DIVIDEND-asset side.
 *
 *  Why the dividend leg is charged: the obvious design — mint against
 *  `R + D` as if one unit of each were worth the same — is UNSOUND, and not
 *  subtly. Let a raw share be worth `p` units of the dividend asset. A
 *  deposit of `x` raw priced against `R + D`, immediately withdrawn, nets
 *
 *      out - in  =  x * D * (1 - p) / (R + D + x)
 *
 *  a risk-free drain of existing holders whenever `p < 1` and a silent
 *  robbery of the depositor whenever `p > 1`. Adding unlike units is a
 *  valuation claim, and this codebase does not make valuation claims it
 *  cannot defend. So the mint is priced on R alone and the dividend side is
 *  charged proportionally alongside — the Balancer/Set proportional join.
 *
 *  Why the STREAM legs are NOT charged — a disclosed trade-off, stated
 *  plainly rather than buried:
 *
 *    Requiring a depositor to also hold and approve a proportional slice of
 *    EVERY listed stream (a bribe token, an RWA unit that may itself be
 *    KYC-gated and therefore unobtainable) would make `deposit` unusable, and
 *    for a KYC-gated stream, literally impossible for most depositors. The
 *    deliberate choice is that `deposit` stays single-asset.
 *
 *    The exact consequence, quantified: a depositor minting `w` wIDX against
 *    supply `S` acquires a `w / (S + w + VIRTUAL_SHARES)` claim on stream
 *    backing they did not contribute to. Existing holders are diluted by that
 *    fraction on the stream legs ONLY — never on the raw leg (priced on R)
 *    and never on the dividend leg (charged proportionally). Call
 *    `previewWithdraw` before and after to measure it exactly; `streams()`
 *    shows every held balance, so the dilution is fully observable on-chain
 *    in advance, never a surprise.
 *
 *    This is a real cost and it is not zero. It is accepted because the
 *    alternative is a wrapper nobody can deposit into, and because the
 *    dilution is bounded by deposit size relative to the pool and is
 *    symmetric — the same depositor is diluted in turn by everyone after
 *    them. A stream funder who wants to reward a FIXED holder set should push
 *    the bribe and let holders exit, rather than assume a closed membership
 *    the wrapper never promised.
 *
 *  THE RESTRICTED-ASSET PROBLEM, AND THE FAULT-TOLERANT PAYOUT
 *  ----------------------------------------------------------
 *  Real-world-asset tokens routinely enforce transfer restrictions the issuer
 *  controls and nobody here can influence: a KYC allowlist, a jurisdiction
 *  block, a lockup. USDC-shaped tokens carry an issuer blacklist. So a
 *  `withdraw` that loops over N backing assets doing a plain `transfer` for
 *  each has a fatal property: ONE asset reverting on transfer to THIS
 *  PARTICULAR withdrawer reverts the WHOLE transaction, trapping that user's
 *  raw shares and every other, perfectly unrestricted asset along with it.
 *  That is precisely the unmovable-assets failure this codebase treats as the
 *  cardinal sin, arrived at from a new direction.
 *
 *  So every payout leg is INDIVIDUALLY FAULT-TOLERANT:
 *
 *    1. Amounts for ALL assets are computed FIRST, from pre-burn backing, so
 *       no leg's outcome can influence another leg's size.
 *    2. wIDX is burned once.
 *    3. Each leg is paid by `_payout`, a bounded-gas low-level `transfer`
 *       that CANNOT revert the enclosing call. Success: the user has the
 *       tokens. Failure — revert, `false` return, out-of-gas inside the
 *       token, anything — the owed amount is credited to
 *       `pendingClaim[user][asset]` and moved into `reserved[asset]`.
 *
 *  `reserved` is the load-bearing half. A deferred slice has LEFT the backing
 *  pool: `_heldOf` subtracts `reserved`, so remaining holders cannot redeem
 *  it a second time and the withdrawer's claim is not silently donated to the
 *  people who stayed. The user retries whenever they like — the restriction
 *  clearing, a KYC approval landing, a blacklist lifting — via `claimPending`
 *  (loud, full gas) or `claimPendingMany` (batched, tolerant). The credit
 *  never expires, no role can touch it, and nothing can take it back.
 *
 *  The value is therefore never lost and never trapped BY THIS CONTRACT: if
 *  it is unreachable, it is unreachable because the issuer of that one token
 *  says so, and the user's OTHER assets came out in the same call regardless.
 *
 *  THE ZERO-DENOMINATOR CARRY — ROUND 9e
 *  -------------------------------------
 *  A live-balance backing pool has no `index += donation / W_global` step and
 *  therefore cannot suffer the divide-by-zero half of the classic MasterChef
 *  bug: a push into this wrapper never reverts on the funder and never strands
 *  the value. But it DID suffer the other half — the one that was audited as
 *  CRITICAL in a sister design under the name "lone-staker vault drain".
 *
 *  Concretely, and this was measured, not theorised: with `totalSupply() == 0`
 *  (everyone has unwrapped, or nobody has wrapped yet), a `depositStream` of
 *  100 units of a bribe token sits in the backing pool with no holder to
 *  divide it among. The next actor to call `deposit` — for one wei of raw
 *  share — owns 100% of a one-holder supply and `withdraw`s in the SAME
 *  TRANSACTION with 99.999999999999999999 of the 100 units and their raw share
 *  back. Zero capital, zero duration, zero risk, and the funder's entire
 *  intended reward to holders captured by whoever happened to be watching.
 *
 *  That is not the disclosed stream-leg dilution documented above. Disclosed
 *  dilution is bounded by `w / (S + w + VIRTUAL_SHARES)` and therefore requires
 *  capital proportional to the pool. At `S == 0` that bound degenerates to 1
 *  for an arbitrarily small `w`, which is a different thing entirely.
 *
 *  THE FIX, and it is the same shape as the sister design's `donation_carry`:
 *  value that arrives while there is NO eligible holder is not counted as
 *  backing. It is held in `carry[token]` — subtracted from every backing read
 *  by the same `_netOf` that already subtracts `reserved` — and it rejoins the
 *  pool the moment real, held-across-a-block stake exists, pro rata to
 *  EVERYONE present then, not to whoever re-entered first.
 *
 *  Why the release is one BLOCK after supply becomes real, rather than
 *  instantly on the mint: releasing on the mint itself hands the pot to the
 *  sole depositor who just created the supply, which is the identical capture
 *  with one more step. A block boundary is the minimum condition under which
 *  "eligible" means anything at all — the holder must carry the position
 *  across a block, at real risk, and anyone else may join before the release,
 *  so the pot is genuinely shared by whoever is present rather than won by
 *  transaction ordering. This is a deliberate design choice, stated here and
 *  proved by test, not a silently-inherited property.
 *
 *  WHAT THE CARRY IS NOT. It is not a lever, not a pause, and not a delay on
 *  anybody's exit:
 *    - No role can read it, write it, extend it, or reach it. There is no
 *      setter and no parameter.
 *    - It never blocks `withdraw`. Carried value simply is not yet backing;
 *      every other leg pays out exactly as before, and a holder's own
 *      previously-earned backing is never carried.
 *    - It cannot trap. Release is unconditional and automatic on the first
 *      interaction at or after the unlock block. `pruneStream` additionally
 *      refuses to drop a token with a live carry, so a carried balance can
 *      never be orphaned off the iteration list.
 *    - It is unreachable in the normal case: with any wrapped supply at all,
 *      `_accrueCarry` is a no-op and every push lands in backing instantly,
 *      exactly as before.
 *
 *  RESIDUAL, stated rather than hidden: a raw `transfer` of a stream token
 *  straight to this address while supply is zero is invisible to this contract
 *  and is NOT carried. `depositStream` is the supported funding path and is the
 *  one that carries. A funder who bypasses it accepts first-comer capture.
 *
 *  PER-STREAM ISOLATION
 *  --------------------
 *  A listed token that later turns hostile, breaks, or self-destructs must
 *  never be able to brick anything else. It cannot:
 *    - `_probeBalance` reads every stream balance through a bounded-gas
 *      STATICCALL and treats any failure or short return as a zero balance,
 *      so a reverting `balanceOf` cannot brick pricing or `withdraw`.
 *    - `_payout` is bounded-gas and cannot revert the caller, so a reverting
 *      `transfer` cannot brick the other legs.
 *    - `deposit` and `harvest` never read a stream at all, so the core
 *      wIDX / raw-share / dividend mechanism is untouchable from a stream.
 *    - `reserved` and `pendingClaim` are keyed per token, so a hostile
 *      token's absurd balance inflates only its own bookkeeping.
 *  The 63/64 gas rule means a bounded-gas callee cannot consume the caller's
 *  remaining gas, which is what makes the above bounds real rather than
 *  decorative.
 *
 *  THE FINITE STREAM CAP — DELIBERATE, DISCLOSED
 *  ---------------------------------------------
 *  `withdraw` iterates every backing asset, so an unbounded stream count
 *  would eventually make WITHDRAWAL — the one function that must always work
 *  — gas-unsafe. That would be a slow-motion version of the trapping bug
 *  this file spends most of its length avoiding. `MAX_STREAMS = 32`, the same
 *  number as `GlobalIndexVault.MAX_CONSTITUENTS` and for the same reason: it
 *  is generous enough that no honest deployment reaches it, and small enough
 *  that a full exit is comfortably within a block. Worst case is 34 legs (32
 *  streams + raw + dividend), each bounded by `PAYOUT_GAS`. This is a
 *  disclosed bound, not an accidental limitation, and `pruneStream` lets a
 *  fully-drained delisted stream free its slot permissionlessly.
 *
 *  REBASING TOKENS — AN OPERATIONAL CONSTRAINT, NOT A CODE GUARANTEE
 *  ----------------------------------------------------------------
 *  See `queueStream`. Stated there rather than claimed here.
 *
 *  FIRST-DEPOSITOR INFLATION
 *  -------------------------
 *  Defended with GlobalIndexVault's own `VIRTUAL_SHARES` / `VIRTUAL_ASSETS`
 *  offsets, same constants, same direction, deliberately not a new invention.
 *  A consequence worth stating plainly: the FIRST deposit into an empty
 *  wrapper mints `VIRTUAL_SHARES : VIRTUAL_ASSETS`, i.e. 1000 wIDX per raw
 *  share, so wIDX opens at 1000x the raw share's unit count and drifts down
 *  as the rate appreciates.
 *
 *  ROUNDING
 *  --------
 *  Every division that pays a user floors; every division that charges a user
 *  ceils. Dust always settles in the wrapper, i.e. with the holders who
 *  stayed, never systematically to the last actor out.
 * ============================================================================
 */
contract WrappedIndexShare is ERC20, ReentrancyGuard, ScopedRoles {
    using SafeERC20 for IERC20;

    /// @notice The raw GlobalIndexVault share token being wrapped.
    IIndexDividendShare public immutable indexShare;

    /// @notice The vault's own dividend denomination, read from the vault at
    /// construction via its real `dividendAsset()` getter — never passed in,
    /// so the two can never disagree.
    IERC20 public immutable dividendAsset;

    /**
     * @notice The ONLY role in this contract with a capability, and its
     * capability is admission and nothing else: list a stream (timelocked),
     * delist a stream. It can never move, freeze, or reach a single unit of
     * backing, and nothing it does can delay or block an exit.
     */
    bytes32 public constant ROLE_STREAM_LISTER = "stream.lister";

    /// @notice Disclosed, deliberate bound on iterated backing assets. Same
    /// value as `GlobalIndexVault.MAX_CONSTITUENTS`. See the header.
    uint256 public constant MAX_STREAMS = 32;

    /// @dev Gas ceiling on a fault-tolerant payout leg. Generous for an ERC-20
    /// `transfer` including a KYC/allowlist check (a plain transfer is ~50k),
    /// and low enough that 34 legs cannot approach a block. A legitimate token
    /// too heavy for this still pays out via `claimPending`, which forwards
    /// everything it has.
    uint256 private constant PAYOUT_GAS = 250_000;

    /// @dev Gas ceiling on a stream `balanceOf` probe. A view that needs more
    /// than this is not a token, it is a liability.
    uint256 private constant PROBE_GAS = 100_000;

    /**
     * @dev The first-depositor-inflation offsets, copied verbatim from
     * GlobalIndexVault. Not retuned, not reinvented.
     */
    uint256 private constant VIRTUAL_SHARES = 10 ** 3;
    uint256 private constant VIRTUAL_ASSETS = 1;

    /// @dev Same bounds GlobalIndexVault enforces on its own delay, so a
    /// listing can never be scheduled on a shorter clock than a vault change.
    uint256 private constant MIN_TIMELOCK_DELAY = 48 hours;
    uint256 private constant MAX_TIMELOCK_DELAY = 30 days;

    /// @notice The timelock every stream listing and every role rotation
    /// waits out. Immutable — no role can shorten it.
    uint256 public immutable timelockDelay;

    struct QueuedStream {
        uint64 eta;
        bool pending;
    }

    /// @dev Every token that has ever been listed and not yet pruned, in
    /// listing order. Iterated by `withdraw`; bounded by MAX_STREAMS.
    address[] private _streamList;

    /// @dev Present in `_streamList` (whether or not still accepting pushes).
    mapping(address => bool) private _tracked;

    /// @notice Currently accepting `depositStream` pushes. Going false does
    /// NOT remove held backing — see `delistStream`.
    mapping(address => bool) public isStream;

    /// @notice Pending timelocked listing per token.
    mapping(address => QueuedStream) public queuedStreams;

    /// @notice Per-asset total owed to specific users whose payout bounced.
    /// Subtracted from backing, so it can never be redeemed twice.
    mapping(address => uint256) public reserved;

    /// @notice user => asset => amount owed from a bounced payout leg.
    /// Claimable forever, by that user, with no role able to touch it.
    mapping(address => mapping(address => uint256)) public pendingClaim;

    /**
     * @notice Per-asset value that arrived while there was NO eligible holder,
     * held out of backing until real stake exists again. See "THE
     * ZERO-DENOMINATOR CARRY" in the header. No role can reach this.
     */
    mapping(address => uint256) public carry;

    /**
     * @dev Carry state machine, in one slot:
     *   0                  — nothing is carried.
     *   type(uint256).max   — carried, and the wrapper is (or was last seen)
     *                        empty, so there is nothing to release to yet.
     *   any other value n   — carried, releasing on the first interaction at
     *                        block height >= n (always `transition + 1`).
     */
    uint256 private _carryUnlockBlock;

    error ZeroAmount();
    error NothingToMint();
    error NothingToReturn();
    error NoDividendAsset();
    error BadTimelockDelay();
    error InvalidStream();
    error StreamAlreadyListed();
    error StreamCapReached();
    error NotAStream();
    error NoStreamQueued();
    error StreamTimelockNotElapsed();
    error StreamStillListed();
    error StreamNotEmpty();
    error NothingCredited();

    event Wrapped(
        address indexed account,
        uint256 rawSharesIn,
        uint256 dividendAssetIn,
        uint256 wrappedOut
    );
    event Unwrapped(
        address indexed account,
        uint256 wrappedIn,
        uint256 rawSharesOut,
        uint256 dividendAssetOut
    );
    event Harvested(address indexed caller, uint256 amount);
    event StreamQueued(address indexed token, uint64 eta);
    event StreamListed(address indexed token);
    event StreamDelisted(address indexed token);
    event StreamPruned(address indexed token);
    event StreamFunded(address indexed token, address indexed from, uint256 credited);
    event StreamPaid(address indexed account, address indexed token, uint256 amount);
    event PayoutDeferred(address indexed account, address indexed token, uint256 amount);
    event PendingClaimed(address indexed account, address indexed token, uint256 amount);

    constructor(
        address indexShare_,
        string memory name_,
        string memory symbol_,
        address roleAdmin_,
        address streamLister_,
        uint256 timelockDelay_
    ) ERC20(name_, symbol_) {
        if (indexShare_ == address(0)) revert ZeroAmount();
        indexShare = IIndexDividendShare(indexShare_);
        address asset = IIndexDividendShare(indexShare_).dividendAsset();
        // A vault with dividends switched off has nothing for this wrapper to
        // do, and a wrapper whose second backing asset is address(0) would be
        // a footgun waiting for the vault to be replaced. Refuse at birth.
        if (asset == address(0)) revert NoDividendAsset();
        dividendAsset = IERC20(asset);

        if (timelockDelay_ < MIN_TIMELOCK_DELAY || timelockDelay_ > MAX_TIMELOCK_DELAY) {
            revert BadTimelockDelay();
        }
        timelockDelay = timelockDelay_;

        // `_initRole` rejects address(0), so both roles are always occupied.
        _initRole(ROLE_ADMIN, roleAdmin_);
        _initRole(ROLE_STREAM_LISTER, streamLister_);
    }

    function _timelockDelay() internal view override returns (uint256) {
        return timelockDelay;
    }

    function _isKnownRole(bytes32 role) internal pure override returns (bool) {
        return role == ROLE_ADMIN || role == ROLE_STREAM_LISTER;
    }

    // ══ views ═══════════════════════════════════════════════════════════════

    /// @notice Raw index shares currently backing the wrapped supply, net of
    /// anything already owed to a specific user by a bounced payout.
    function rawSharesHeld() public view returns (uint256) {
        return _netOf(address(indexShare), indexShare.balanceOf(address(this)));
    }

    /// @notice Harvested dividend asset currently backing the wrapped supply,
    /// net of bounced-payout reservations.
    function dividendAssetHeld() public view returns (uint256) {
        return _netOf(address(dividendAsset), dividendAsset.balanceOf(address(this)));
    }

    /// @notice A single stream's backing, net of reservations. Returns 0 for a
    /// token that is not tracked AND for a tracked token whose `balanceOf`
    /// misbehaves — a broken stream reads as empty, never as a revert.
    function streamHeld(address token) public view returns (uint256) {
        if (!_tracked[token]) return 0;
        return _probeBalance(token);
    }

    /// @notice How many stream slots of `MAX_STREAMS` are occupied.
    function streamCount() external view returns (uint256) {
        return _streamList.length;
    }

    /**
     * @notice Stream discovery for a UI or an external agent: every tracked
     * stream, its current held backing, and whether it still accepts pushes.
     *
     * A token with `accepting == false` and `held > 0` is a DELISTED stream
     * whose backing remains fully withdrawable by every holder — that is the
     * intended, permanent state after a delisting, not a stuck one.
     */
    function streams()
        external
        view
        returns (address[] memory tokens, uint256[] memory held, bool[] memory accepting)
    {
        uint256 n = _streamList.length;
        tokens = new address[](n);
        held = new uint256[](n);
        accepting = new bool[](n);
        for (uint256 i = 0; i < n; ++i) {
            address t = _streamList[i];
            tokens[i] = t;
            held[i] = _probeBalance(t);
            accepting[i] = isStream[t];
        }
    }

    /// @notice Every backing asset in payout order — raw share, dividend
    /// asset, then each tracked stream — with current held balances.
    function backingAssets()
        public
        view
        returns (address[] memory tokens, uint256[] memory held)
    {
        uint256 n = _streamList.length;
        tokens = new address[](n + 2);
        held = new uint256[](n + 2);
        tokens[0] = address(indexShare);
        held[0] = rawSharesHeld();
        tokens[1] = address(dividendAsset);
        held[1] = dividendAssetHeld();
        for (uint256 i = 0; i < n; ++i) {
            tokens[i + 2] = _streamList[i];
            held[i + 2] = _probeBalance(_streamList[i]);
        }
    }

    /**
     * @notice Exactly what burning `wrappedIn` pays out right now, per asset,
     * in payout order. Quoted WITHOUT harvesting first (a view cannot), so the
     * dividend leg is a lower bound — `withdraw` harvests before it prices.
     */
    function previewWithdraw(uint256 wrappedIn)
        external
        view
        returns (address[] memory tokens, uint256[] memory amounts)
    {
        uint256[] memory held;
        (tokens, held) = backingAssets();
        amounts = new uint256[](held.length);
        uint256 denom = totalSupply() + VIRTUAL_SHARES;
        for (uint256 i = 0; i < held.length; ++i) {
            amounts[i] = Math.mulDiv(wrappedIn, held[i], denom);
        }
    }

    /// @notice What one wrapped share currently redeems for on the two core
    /// legs, at `1e18` granularity. Purely informational — no code path prices
    /// off it. Stream legs are in `previewWithdraw`.
    function exchangeRate()
        external
        view
        returns (uint256 rawPerWrapped, uint256 dividendPerWrapped)
    {
        uint256 supply = totalSupply();
        if (supply == 0) return (0, 0);
        uint256 denom = supply + VIRTUAL_SHARES;
        rawPerWrapped = Math.mulDiv(1e18, rawSharesHeld(), denom);
        dividendPerWrapped = Math.mulDiv(1e18, dividendAssetHeld(), denom);
    }

    /**
     * @notice The dividend-asset side a `deposit(rawSharesIn)` will also pull,
     * quoted against CURRENT backing. Approve at least this much, plus a
     * little headroom if a harvest may land between quote and send.
     */
    function quoteDividendAssetIn(uint256 rawSharesIn) external view returns (uint256) {
        return _dividendSideFor(rawSharesIn, rawSharesHeld(), dividendAssetHeld(), totalSupply());
    }

    /// @notice What this wrapper could pull from the vault right now.
    function pendingDividend() external view returns (uint256) {
        return indexShare.withdrawableDividendOf(address(this));
    }

    // ══ core mechanism — no role can reach any of this ══════════════════════

    /**
     * @notice Pull in the dividend this wrapper has already earned as a
     * direct raw-share holder, raising the exchange rate for every wrapped
     * holder at once — including a passive LP pool that will never call
     * anything itself.
     *
     * Permissionless by design and safe to call by anyone, repeatedly. With
     * nothing to claim it is a clean no-op returning 0. Reads no stream, so no
     * stream can affect it.
     */
    function harvest() external nonReentrant returns (uint256 claimed) {
        _foldCarry();
        claimed = _harvest();
    }

    /**
     * @notice Observability for the zero-denominator carry: the block height at
     * or after which carried value rejoins backing. `0` means nothing is
     * carried; `type(uint256).max` means something is carried and the wrapper
     * has no holders to release it to yet.
     */
    function carryUnlockBlock() external view returns (uint256) {
        return _carryUnlockBlock;
    }

    /**
     * @notice Wrap raw index shares into wIDX.
     *
     * Pulls `rawSharesIn` raw shares and, if any dividend asset is already in
     * backing, the proportional dividend-asset side alongside it. BOTH pulls
     * credit the MEASURED BALANCE DELTA, never the nominal amount.
     *
     * Deliberately does NOT charge a proportional side on stream legs, and
     * deliberately does not read a stream at all — see the header for the
     * quantified dilution this trades away, and for why a stream can never
     * interfere with a deposit.
     */
    function deposit(uint256 rawSharesIn)
        external
        nonReentrant
        returns (uint256 wrappedOut)
    {
        if (rawSharesIn == 0) revert ZeroAmount();

        // Release anything carried from a no-holder window BEFORE pricing, so
        // it is shared with the holders who were already here.
        _foldCarry();

        // Bank the pending entitlement BEFORE pricing, so the incoming
        // depositor cannot buy a slice of dividends that predate them.
        _harvest();

        uint256 rawBefore = rawSharesHeld();
        uint256 divBefore = dividendAssetHeld();
        uint256 supply = totalSupply();

        // Price against pre-deposit backing. Virtual offsets on both sides,
        // exactly as GlobalIndexVault mints.
        wrappedOut = Math.mulDiv(
            rawSharesIn,
            supply + VIRTUAL_SHARES,
            rawBefore + VIRTUAL_ASSETS
        );

        uint256 divIn = _dividendSideFor(rawSharesIn, rawBefore, divBefore, supply);

        // ── pulls, measured ────────────────────────────────────────────────
        IERC20(address(indexShare)).safeTransferFrom(msg.sender, address(this), rawSharesIn);
        uint256 rawCredited = rawSharesHeld() - rawBefore;

        uint256 divCredited;
        if (divIn > 0) {
            dividendAsset.safeTransferFrom(msg.sender, address(this), divIn);
            divCredited = dividendAssetHeld() - divBefore;
        }

        // If either leg under-delivered, re-price the mint DOWN to what
        // actually arrived.
        if (rawCredited < rawSharesIn) {
            wrappedOut = Math.mulDiv(wrappedOut, rawCredited, rawSharesIn);
        }
        if (divIn > 0 && divCredited < divIn) {
            wrappedOut = Math.mulDiv(wrappedOut, divCredited, divIn);
        }

        if (wrappedOut == 0) revert NothingToMint();
        _mint(msg.sender, wrappedOut);

        // Supply just went 0 -> nonzero with a pot carried: start the release
        // clock at the NEXT block, so this depositor cannot round-trip it out
        // in the same transaction and anyone else may join first.
        if (supply == 0) _armCarry();

        emit Wrapped(msg.sender, rawCredited, divCredited, wrappedOut);
    }

    /**
     * @notice Unwrap wIDX back into its exact pro-rata slice of EVERY backing
     * asset — raw index shares, accrued dividend asset, and every tracked
     * stream with a nonzero balance — in one call, each in its own native
     * units, with no price ever read or implied.
     *
     * Every leg is individually fault-tolerant: a leg whose `transfer` fails
     * for this particular withdrawer (an RWA transfer restriction, an issuer
     * blacklist, a token that simply broke) is credited to
     * `pendingClaim[msg.sender][asset]` and reserved out of backing, and EVERY
     * OTHER LEG STILL PAYS OUT IN THIS SAME CALL. One restricted asset can
     * never trap a user's unrestricted assets. Retry with `claimPending`.
     *
     * All divisions floor, so dust stays with the holders who stayed.
     */
    function withdraw(uint256 wrappedIn)
        external
        nonReentrant
        returns (uint256 rawSharesOut, uint256 dividendAssetOut)
    {
        if (wrappedIn == 0) revert ZeroAmount();

        // Never blocks: this only ever ADDS carried value back into the pool
        // this exit is about to be priced against.
        _foldCarry();

        _harvest();

        // Read AFTER harvest, BEFORE the burn. `+ VIRTUAL_SHARES` on the
        // denominator is the redeem-side half of the offset pair, mirroring
        // GlobalIndexVault's `redeemProRata`.
        uint256 denom = totalSupply() + VIRTUAL_SHARES;
        rawSharesOut = Math.mulDiv(wrappedIn, rawSharesHeld(), denom);
        dividendAssetOut = Math.mulDiv(wrappedIn, dividendAssetHeld(), denom);

        // EVERY amount is computed from pre-burn backing, before a single
        // transfer is attempted, so no leg's success or failure can change
        // another leg's size. This ordering is the isolation guarantee.
        uint256 n = _streamList.length;
        uint256[] memory streamOut = new uint256[](n);
        bool anyStream;
        for (uint256 i = 0; i < n; ++i) {
            uint256 amt = Math.mulDiv(wrappedIn, _probeBalance(_streamList[i]), denom);
            streamOut[i] = amt;
            if (amt > 0) anyStream = true;
        }

        // A burn that returns nothing at all is a user error, not a feature.
        // Reverting here cannot trap anything: the caller keeps their wrapped
        // shares and can simply exit a larger amount.
        if (rawSharesOut == 0 && dividendAssetOut == 0 && !anyStream) revert NothingToReturn();

        // Effects before interactions. `_burn` reverts on insufficient
        // balance, which is what authorises the payout.
        _burn(msg.sender, wrappedIn);

        _payout(address(indexShare), msg.sender, rawSharesOut);
        _payout(address(dividendAsset), msg.sender, dividendAssetOut);
        for (uint256 i = 0; i < n; ++i) {
            address t = _streamList[i];
            if (streamOut[i] > 0) {
                _payout(t, msg.sender, streamOut[i]);
                emit StreamPaid(msg.sender, t, streamOut[i]);
            }
        }

        emit Unwrapped(msg.sender, wrappedIn, rawSharesOut, dividendAssetOut);
    }

    /**
     * @notice Retry ONE bounced payout leg, at full gas and loudly.
     *
     * Unlike the `withdraw` loop this does NOT swallow a failure: if the
     * restriction is still in force the call reverts and the credit is left
     * exactly as it was. That is the right shape for a deliberate retry — the
     * caller wants to know whether it worked — and it is the escape hatch for
     * a legitimate token whose transfer costs more than `PAYOUT_GAS`.
     *
     * Permissionless in the only sense that matters: only the credited user
     * can move their own credit, and no role can touch it, ever.
     */
    function claimPending(address token) external nonReentrant returns (uint256 amount) {
        amount = pendingClaim[msg.sender][token];
        if (amount == 0) revert NothingToReturn();
        pendingClaim[msg.sender][token] = 0;
        reserved[token] -= amount;
        IERC20(token).safeTransfer(msg.sender, amount);
        emit PendingClaimed(msg.sender, token, amount);
    }

    /**
     * @notice Batch-retry several bounced legs. THIS is the batch convenience
     * that is actually meaningful here (see the header on why streams need no
     * `harvest`): a user exiting a wrapper with several restricted assets can
     * settle all of them in one call once their approvals land.
     *
     * Tolerant, unlike `claimPending`: a leg that still fails is simply
     * re-credited and the others still pay. Duplicate entries are harmless —
     * the second sees a zero credit and is skipped.
     */
    function claimPendingMany(address[] calldata tokens)
        external
        nonReentrant
        returns (uint256 settled)
    {
        for (uint256 i = 0; i < tokens.length; ++i) {
            address t = tokens[i];
            uint256 amount = pendingClaim[msg.sender][t];
            if (amount == 0) continue;
            pendingClaim[msg.sender][t] = 0;
            reserved[t] -= amount;
            // `_payout` re-credits and re-reserves on failure, so a still-
            // restricted leg ends exactly where it started.
            if (_payout(t, msg.sender, amount)) {
                ++settled;
                emit PendingClaimed(msg.sender, t, amount);
            }
        }
    }

    // ══ streams: permissionless funding ═════════════════════════════════════

    /**
     * @notice Push value into an already-listed stream. PERMISSIONLESS — this
     * is how a bribe, a partner incentive, or an RWA-airdrop forwarder funds
     * index-share holders, including the pooled ones that can never claim
     * anything themselves.
     *
     * Credits the MEASURED BALANCE DELTA, never the nominal `amount`: the
     * Balancer-STA discipline every inbound path in this codebase uses, so a
     * fee-on-transfer stream token cannot credit value that never arrived.
     *
     * The credited amount lands directly in the aggregate backing pool, which
     * is why there is nothing to "harvest" afterwards — the exchange rate has
     * already moved for every holder, pooled ones included.
     *
     * Reverts if `token` is not CURRENTLY accepting pushes: an unlisted token
     * can never be forced into backing, and a delisted one can never be
     * re-funded without a fresh timelocked listing.
     */
    function depositStream(address token, uint256 amount)
        external
        nonReentrant
        returns (uint256 credited)
    {
        if (!isStream[token]) revert NotAStream();
        if (amount == 0) revert ZeroAmount();
        _foldCarry();
        uint256 before = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        uint256 nowBal = IERC20(token).balanceOf(address(this));
        credited = nowBal > before ? nowBal - before : 0;
        if (credited == 0) revert NothingCredited();
        // No-op with any wrapped supply. With none, held aside rather than
        // left for the next actor to flash-capture. See the header.
        _accrueCarry(token, credited);
        emit StreamFunded(token, msg.sender, credited);
    }

    // ══ streams: admission, the ONLY administered surface ═══════════════════

    /**
     * @notice Queue a token onto the stream whitelist. ROLE_STREAM_LISTER
     * only, and it lands no sooner than `timelockDelay` from now — the same
     * clock as a role rotation, so a listing is always publicly visible and
     * contestable before it can take effect.
     *
     * @dev WHAT THE LISTING ROLE IS ACCEPTING RESPONSIBILITY FOR. These are
     * operational constraints this contract CANNOT enforce, stated as
     * constraints rather than dressed up as protections that do not exist:
     *
     *  - REBASING TOKENS MUST NOT BE LISTED. Backing is read from live
     *    balances, which handles a donation correctly but cannot distinguish a
     *    rebase from one. A NEGATIVE rebase silently shrinks every holder's
     *    claim and can push `balanceOf` below `reserved`, at which point a
     *    bounced credit is no longer fully covered. There is no reliable
     *    on-chain test for "is this token rebasing" — a token can rebase once,
     *    a year from now, on a governance vote — so this is NOT and CANNOT BE
     *    enforced in code. It is a judgment call made at listing time, and the
     *    honest thing is to say so.
     *  - The token must be a real contract with a working `transfer` and
     *    `balanceOf`. Non-contract addresses are rejected here, but a contract
     *    that lies is not detectable.
     *  - The token must not be able to re-enter this contract. `nonReentrant`
     *    covers the mutating surface; a token designed around it is out of
     *    scope for any whitelist.
     *  - A KYC/allowlist-gated RWA token IS acceptable — the fault-tolerant
     *    payout path exists precisely for it — but note that restricted
     *    holders will accumulate `pendingClaim` credits rather than receive
     *    the token, which is a UX cost the lister should weigh.
     *  - Listing DILUTES existing holders on that stream's leg as new
     *    depositors arrive (see the header). It is not a free action.
     *
     * The raw share and the dividend asset are rejected: they are already
     * backing legs, and listing one would double-count it into oblivion.
     */
    function queueStream(address token) external onlyRole(ROLE_STREAM_LISTER) {
        _validateCandidate(token);
        uint64 eta = uint64(block.timestamp + timelockDelay);
        queuedStreams[token] = QueuedStream({eta: eta, pending: true});
        emit StreamQueued(token, eta);
    }

    /**
     * @notice Apply a queued listing once the delay has elapsed.
     * Permissionless after the eta, exactly as `executeRole` is: the timelock
     * is the gate, not a second discretionary approval.
     *
     * Re-validates from scratch, so a queue made when a slot was free cannot
     * be executed past the cap, and a token listed by another route in the
     * meantime cannot be listed twice.
     */
    function executeStream(address token) external {
        QueuedStream memory q = queuedStreams[token];
        if (!q.pending) revert NoStreamQueued();
        if (block.timestamp < q.eta) revert StreamTimelockNotElapsed();
        _validateCandidate(token);
        delete queuedStreams[token];
        _streamList.push(token);
        _tracked[token] = true;
        isStream[token] = true;
        emit StreamListed(token);
    }

    /// @notice Withdraw a queued listing. ROLE_STREAM_LISTER only. Grants no
    /// capability — it only undoes something the same role scheduled.
    function cancelStream(address token) external onlyRole(ROLE_STREAM_LISTER) {
        if (!queuedStreams[token].pending) revert NoStreamQueued();
        delete queuedStreams[token];
        emit StreamQueued(token, 0);
    }

    /**
     * @notice Stop accepting NEW pushes into a stream. ROLE_STREAM_LISTER only.
     *
     * @dev DELISTING NEVER CLAWS BACK BACKING, AND THIS IS THE POINT. The
     * wrapper's existing balance of a delisted token stays in the backing
     * pool, stays in `_streamList`, stays iterated by `withdraw`, and stays
     * fully redeemable pro rata by every holder forever — exactly as it was
     * the block before. Delisting removes ONE thing and one thing only: the
     * ability of a new `depositStream` to add more.
     *
     * That asymmetry is deliberate. A listing role that could remove value
     * already promised to holders would be a lever over user assets, which
     * this codebase does not build. A listing role that can only close the
     * door to NEW value is an admission control, which is what was asked for.
     *
     * Immediate rather than timelocked, and that direction is the safe one: a
     * delay here could only prolong exposure to a token just discovered to be
     * hostile, and delisting cannot take anything from anyone. The timelock
     * guards the direction that ADDS an obligation, which is listing.
     */
    function delistStream(address token) external onlyRole(ROLE_STREAM_LISTER) {
        if (!isStream[token]) revert NotAStream();
        isStream[token] = false;
        emit StreamDelisted(token);
    }

    /**
     * @notice Free a stream's slot once it is delisted, fully drained, and
     * owes nobody. PERMISSIONLESS — it can only ever remove a token that has
     * nothing left to give, so there is no discretion to gate.
     *
     * Requires `held == 0` AND `reserved == 0`, so pruning can never orphan a
     * holder's pro-rata slice or a bounced credit. A hostile token whose
     * `balanceOf` reverts probes as zero and can be pruned, which is the
     * desired outcome: the stuck stream leaves and everyone else's exits get
     * cheaper.
     */
    function pruneStream(address token) external {
        if (!_tracked[token]) revert NotAStream();
        if (isStream[token]) revert StreamStillListed();
        // `carry` is checked alongside `reserved` because `_probeBalance`
        // subtracts it: a token holding nothing BUT a carried balance would
        // otherwise probe as empty, get pruned off `_streamList`, and never be
        // reachable by `_foldCarry` again — trapping the carry permanently.
        if (_probeBalance(token) != 0 || reserved[token] != 0 || carry[token] != 0) {
            revert StreamNotEmpty();
        }

        uint256 n = _streamList.length;
        for (uint256 i = 0; i < n; ++i) {
            if (_streamList[i] == token) {
                _streamList[i] = _streamList[n - 1];
                _streamList.pop();
                break;
            }
        }
        _tracked[token] = false;
        emit StreamPruned(token);
    }

    // ══ internals ═══════════════════════════════════════════════════════════

    function _validateCandidate(address token) private view {
        if (
            token == address(0) ||
            token == address(this) ||
            token == address(indexShare) ||
            token == address(dividendAsset) ||
            token.code.length == 0
        ) revert InvalidStream();
        if (_tracked[token]) revert StreamAlreadyListed();
        if (_streamList.length >= MAX_STREAMS) revert StreamCapReached();
    }

    /// @dev Backing net of amounts already owed to specific users. Clamped at
    /// zero rather than reverting: an underflow here would brick every path in
    /// the contract, which is a far worse failure than reading a hair low.
    function _netOf(address token, uint256 bal) private view returns (uint256) {
        uint256 res = reserved[token] + carry[token];
        return bal > res ? bal - res : 0;
    }

    /**
     * @dev THE ONE CARRY WRITE. Every inbound push routes through here, so the
     * zero-denominator rule is one code path rather than a special case bolted
     * onto each funding function.
     *
     * With any wrapped supply at all this is a no-op and the value is backing
     * immediately, exactly as before round 9e. With none, the value is held
     * aside and the release clock is re-armed to "locked", so a second push
     * into a still-empty wrapper cannot inherit a stale unlock height.
     */
    function _accrueCarry(address token, uint256 amount) private {
        if (amount == 0 || totalSupply() != 0) return;
        carry[token] += amount;
        _carryUnlockBlock = type(uint256).max;
    }

    /**
     * @dev Fold every carried balance back into backing once real stake has
     * been held across a block boundary. Unconditional, permissionless,
     * reachable from `deposit`, `withdraw` and `depositStream` — i.e. from any
     * interaction at all, so carried value can never sit out indefinitely
     * while the wrapper is in use.
     *
     * Bounded by `MAX_STREAMS + 1`, the same bound `withdraw` already carries.
     */
    function _foldCarry() private {
        uint256 unlock_ = _carryUnlockBlock;
        if (unlock_ == 0 || block.number < unlock_ || totalSupply() == 0) return;
        carry[address(dividendAsset)] = 0;
        uint256 n = _streamList.length;
        for (uint256 i = 0; i < n; ++i) carry[_streamList[i]] = 0;
        _carryUnlockBlock = 0;
    }

    /// @dev Arm the release clock when supply transitions 0 -> nonzero with
    /// something carried. `block.number + 1`: the sole depositor who just
    /// created the supply cannot capture the pot in their own transaction, and
    /// anyone may join before it lands.
    function _armCarry() private {
        if (_carryUnlockBlock != 0) _carryUnlockBlock = block.number + 1;
    }

    /**
     * @dev A stream's net backing, read through a bounded-gas STATICCALL that
     * cannot revert this contract. Any failure, any short return, reads as
     * zero backing — a broken stream becomes invisible instead of fatal.
     */
    function _probeBalance(address token) private view returns (uint256) {
        (bool ok, bytes memory data) = token.staticcall{gas: PROBE_GAS}(
            abi.encodeWithSelector(IERC20.balanceOf.selector, address(this))
        );
        if (!ok || data.length < 32) return 0;
        return _netOf(token, abi.decode(data, (uint256)));
    }

    /**
     * @dev Pay one leg without ever reverting the caller. Returns true on a
     * completed transfer; on ANY failure the amount is credited to the user
     * and reserved out of backing so it is neither lost to them nor
     * double-redeemable by anyone else.
     *
     * The bounded gas is what makes this real: the 63/64 rule means a hostile
     * token cannot consume the gas the remaining legs need.
     */
    function _payout(address token, address to, uint256 amount) private returns (bool) {
        if (amount == 0) return true;
        (bool ok, bytes memory data) = token.call{gas: PAYOUT_GAS}(
            abi.encodeWithSelector(IERC20.transfer.selector, to, amount)
        );
        // Accept the two shapes a real ERC-20 returns: nothing, or `true`.
        if (ok && (data.length == 0 || (data.length >= 32 && abi.decode(data, (bool))))) {
            return true;
        }
        pendingClaim[to][token] += amount;
        reserved[token] += amount;
        emit PayoutDeferred(to, token, amount);
        return false;
    }

    /**
     * @dev The proportional dividend-asset side owed alongside `rawIn`.
     *
     * Zero while the wrapper is empty (`supply == 0`): a donation into an
     * empty wrapper is a gift to whoever opens it, which is not an attack.
     * Ceils, and divides by `rawHeld + VIRTUAL_ASSETS` so it can never divide
     * by zero.
     */
    function _dividendSideFor(
        uint256 rawIn,
        uint256 rawHeld,
        uint256 divHeld,
        uint256 supply
    ) private pure returns (uint256) {
        if (supply == 0 || divHeld == 0 || rawHeld == 0) return 0;
        return Math.mulDiv(rawIn, divHeld, rawHeld + VIRTUAL_ASSETS, Math.Rounding.Up);
    }

    /**
     * @dev Claim this contract's own already-earned entitlement from the
     * vault and credit the MEASURED delta. Never reverts on zero. Touches no
     * stream, so no stream can break it.
     */
    function _harvest() private returns (uint256 claimed) {
        if (indexShare.withdrawableDividendOf(address(this)) == 0) return 0;
        uint256 before = dividendAssetHeld();
        indexShare.claimDividend();
        uint256 after_ = dividendAssetHeld();
        claimed = after_ > before ? after_ - before : 0;
        if (claimed > 0) {
            // Same rule, same entrypoint, for the dividend leg: a harvest into
            // a wrapper with no holders is carried, not left for the taking.
            _accrueCarry(address(dividendAsset), claimed);
            emit Harvested(msg.sender, claimed);
        }
    }
}
