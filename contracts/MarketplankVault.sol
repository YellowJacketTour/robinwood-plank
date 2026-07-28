// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * ============================================================================
 *  UNAUDITED BY A THIRD PARTY. DO NOT DEPLOY WITH REAL VALUE UNTIL REVIEWED.
 *
 *  Phase 2 of docs/marketplank/SPEC.md — an NFTX-style instant liquidity
 *  vault for a single NFT collection. Unlike Seaport (Phase 1, already
 *  deployed and independently audited on Robinhood Chain), this is new code.
 *
 *  Revision 2 (2026-07-27) after an adversarial self-review that found and
 *  fixed six real defects — see test/contracts/VaultDrain.audit.test.ts,
 *  where each is pinned by a regression test:
 *    1. CRITICAL: selling shares against an empty share reserve returned the
 *       entire ETH pool for dust input. Total pool drain.
 *    2. CRITICAL: redemptions minted a fee without burning an offsetting
 *       amount, so share claims and NFT backing drifted apart permanently.
 *    3. Zero-output swaps accepted payment and returned nothing.
 *    4. seedLiquidity() was permissionless.
 *    5. HIGH: single-transaction random redemption let a contract caller
 *       inspect the result and revert to reroll — free rare-sniping.
 *    6. HIGH: targeted redemption could consume the NFT backing an
 *       already-paid-for pending random redemption.
 *
 *  Revision 3 (2026-07-27) after an INDEPENDENT fresh-eyes audit which proved
 *  the revision-2 fix for defect #5 was bypassable. See
 *  test/contracts/VaultRandomness.exploit.test.ts:
 *    A. CRITICAL: the seed was frozen at commit but the DRAW SET was not.
 *       The draw was heldTokenIds[keccak(seed,caller) % heldTokenIds.length],
 *       and deposit() is permissionless, so an attacker read the public seed
 *       one block later, computed off-chain how many throwaway NFTs to append
 *       to land the modulus on the rare token, and did `deposit xK; claim` in
 *       one transaction wrapped in require(got == rare). Free rare-sniping,
 *       exactly the defect #5 was supposed to close.
 *    B. HIGH: the same lever let ANY third party (or the single Orbit
 *       sequencer, which orders unilaterally) change a victim's already
 *       paid-for outcome with one unrelated deposit.
 *    C. MEDIUM: seeded pool ETH was strandable — nothing could ever move
 *       shares into the pool, so a freshly seeded vault was bricked on both
 *       sides with no withdrawal path.
 *    D. HIGH (proven by test): refreshRandomRedeem() was an unlimited seed
 *       reroll. A redeemer with a bad draw simply did not claim, waited out
 *       the 256-block window, re-anchored, and drew again. Demonstrated
 *       changing a committed draw from token 6 to token 7.
 *
 *  The revision-3 model, in one line: a random redemption's outcome is PINNED
 *  to a concrete tokenId as soon as the committed block's hash exists, and
 *  from that moment nothing — not deposits, not targeted redemptions, not the
 *  redeemer's own inaction — can change it.
 *
 *    - The draw index is taken modulo `frozenLen`, the array length captured
 *      at COMMIT time, never the live length. Appending is therefore inert.
 *    - Between commit and pin, the prefix heldTokenIds[0, frozenLen) is
 *      immutable: deposit only appends, and every removal path pins first and
 *      fails closed if it cannot.
 *    - Pinning is permissionless (pinPendingDraw), happens automatically
 *      inside deposit/redeemTarget/claim, and a pinned draw never expires.
 *    - refreshRandomRedeem is GONE. An expired-and-never-pinned request can
 *      only be forfeited (see forfeitExpiredRedeem), which is strictly worse
 *      than any draw, so stalling for a reroll is never profitable.
 *    - At most one random redemption may be pending vault-wide. This is a
 *      deliberate fail-closed serialization: concurrent requests would have
 *      to share a frozen prefix and could collide on the same slot.
 *      STATED HONESTLY (this was previously overstated): the single slot IS a
 *      cheap denial-of-service lever. Anyone willing to burn one share plus
 *      gas can occupy it, and can re-take it the moment it frees. Nothing
 *      here prevents that. What IS guaranteed is only that the slot can never
 *      become permanently stuck: every pending request has a terminal path
 *      (settle once pinned — unconditionally, see _settle — or forfeit once
 *      expired and unpinned) that any third party may push. The accepted
 *      trade-off is "one at a time, grief-able but never bricked" over
 *      "concurrent, with an ordering-dependent collision rule".
 *
 *  Revision 4 (2026-07-27) closes the one thing revision 3 explicitly did NOT:
 *  the sequencer. blockhash() is not a safe randomness source on Arbitrum
 *  Orbit — block.number reports an estimate of the *L1* height while
 *  blockhash() resolves against *L2* blocks, and Arbitrum's own documentation
 *  states L2 block hashes are not cryptographically secure and can be derived
 *  in advance by the sequencer. No contract-side trick fixes an input chosen
 *  by one party, so the input itself is replaced:
 *
 *    - The seed now comes from DrandBeacon.sol — a verified drand (League of
 *      Entropy) threshold-BLS round, checked on chain with the bn128 pairing
 *      precompile. drand runs entirely off this chain on a wall-clock
 *      schedule and has no knowledge of this vault.
 *    - A request anchors to a drand ROUND NUMBER that does not exist yet at
 *      request time, instead of to a block number.
 *    - Anyone may relay that round (permissionlessly, ~3s cadence), after
 *      which the draw pins exactly as before.
 *    - The staleness path is unchanged in shape: a request whose target round
 *      goes unrelayed for ROUND_EXPIRY rounds can be forfeited, never
 *      re-rolled.
 *
 *  Trust model, plainly: the trust root moves from "the single sequencer, who
 *  also orders your transactions" to "a threshold of the drand committee is
 *  not colluding with the vault's adversary". Strictly better, not zero.
 *  See DrandBeacon.sol's header for the deploy-time parameters that MUST be
 *  independently verified before this goes anywhere near real value.
 *
 *  Revision 5 (2026-07-27): explicit one-way pool activation. An earlier cut
 *  of this revision auto-locked seeding when ethReserve crossed a fixed
 *  constructor threshold; the owner rejected any magic number ("lets not have
 *  a minimum, lets just make it so i have to initiate it"). The model now:
 *    - The vault deploys CLOSED: buyShares/sellShares revert PoolNotOpen for
 *      everyone, even with non-zero reserves from partial seeding.
 *    - The treasury seeds at its own pace, any order, any number of calls.
 *    - openPool() (treasury only, one-way, permanent) flips the switch. Its
 *      only precondition is a non-empty pool on BOTH sides — a sanity floor,
 *      not a minimum; how much is "enough" is entirely the treasury's call.
 *    - Once open: trading is public forever, seedLiquidity/seedShares revert
 *      forever for everyone (treasury included, no override), and openPool
 *      itself can never be called again.
 *  Requiring shares to open keeps the defect-C stranded state (ETH seeded
 *  alone) recoverable: the pool cannot open there, so seedShares stays
 *  callable. See test/contracts/VaultBootstrapLock.test.ts.
 * ============================================================================
 */

import {IDrandBeacon} from "./IDrandBeacon.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/security/ReentrancyGuard.sol";

/**
 * @title MarketplankVault
 * @notice Deposit an NFT, mint one fungible vault share. Trade shares against
 * ETH on a constant-product pool. Redeem a share for an NFT — a specific one
 * for a premium, or a random one via commit-reveal.
 *
 * SOLVENCY INVARIANT, enforced after every state-changing call:
 *
 *     totalSupply() + pendingRedeemCount * SHARE_UNIT
 *         == heldTokenIds.length * SHARE_UNIT
 *
 * In words: every share that exists, plus every share already burned for a
 * redemption that hasn't been claimed yet, is backed one-to-one by an NFT
 * actually sitting in this contract. There is no path that creates a claim
 * the vault cannot honor.
 *
 * Deliberately excluded (see the scoping research): no pooled lending, no
 * oracle, no external AMM dependency for a peg, no owner-mutable fees, no
 * upgradeability, no admin withdrawal of pool ETH.
 */
contract MarketplankVault is ERC20, ReentrancyGuard, IERC721Receiver {
    IERC721 public immutable collection;

    /// @notice Fees in basis points (100 = 1%), fixed forever at deployment.
    uint256 public immutable mintFeeBps;
    uint256 public immutable redeemFeeBps;
    /// @notice Extra charge to pick an exact token ID instead of a random one.
    uint256 public immutable targetPremiumBps;

    /// @notice Receives fees and is the only address that may seed pool ETH.
    address public immutable treasury;

    /// @notice The verified drand round cache this vault draws its seed from.
    IDrandBeacon public immutable beacon;

    /**
     * @notice True once the treasury has explicitly opened the pool.
     * @dev One-way, permanent — set only by openPool(), never cleared by
     * anything. While false, buyShares/sellShares revert PoolNotOpen for
     * everyone (even with non-zero reserves from partial seeding); once true,
     * seedLiquidity/seedShares revert forever, for everyone, no override.
     */
    bool public poolOpen;

    uint256 private constant BPS_DENOMINATOR = 10_000;
    uint256 private constant SHARE_UNIT = 1e18;

    /**
     * @dev How many rounds past "the next round after now" a request targets.
     *
     * nextRoundAfter(block.timestamp) is already a round whose emission time
     * is in the future, but block.timestamp on an Orbit chain is set by the
     * sequencer within a tolerance, and a round emitted "now" may already be
     * public. One extra round of lead makes the target unambiguously
     * unpublished at request time even if the sequencer skews the timestamp by
     * a few seconds. At a 3s period the user-visible wait is ~6 seconds.
     *
     * That "~6 seconds" only actually held once DrandBeacon.currentRoundAt was
     * corrected to drand's real convention (round 1 is published AT genesis,
     * so round_at(t) = floor((t-genesis)/period) + 1). The earlier off-by-one
     * reported every round one lower than drand does, which silently cut the
     * real margin here to a single period.
     *
     * A sequencer that skews the clock can only shift WHICH future round is
     * targeted; every candidate is equally unknown to it, so there is nothing
     * to choose between them.
     */
    uint64 private constant ROUND_LEAD = 1;

    /**
     * @dev A request whose target round is this many rounds in the past and
     * still unrelayed may be forfeited. 28_800 rounds is 24h at a 3s period —
     * long enough that a transient drand or relayer outage never destroys a
     * paid-for request, short enough that a stuck request cannot lock the
     * single-request slot forever.
     */
    uint64 private constant ROUND_EXPIRY = 28_800;

    /// @dev Token IDs currently custodied, available for redemption.
    uint256[] private heldTokenIds;
    /// @dev tokenId => index+1 in heldTokenIds (0 means "not held").
    mapping(uint256 => uint256) private heldTokenIndex;

    /// @dev Constant-product pool: ETH side. Share side is balanceOf(this).
    uint256 public ethReserve;

    struct RedeemRequest {
        /// @dev drand round whose verified randomness seeds the draw. It does
        /// not exist yet when the request is made. Shares are already burned.
        uint64 targetRound;
        /// @dev heldTokenIds.length captured at commit. The draw modulus is
        /// this, never the live length — that is what makes appending inert.
        uint64 frozenLen;
        bool active;
        /// @dev Once true, drawnTokenId is final and cannot be changed by
        /// anyone, including the requester.
        bool pinned;
        uint256 drawnTokenId;
    }

    mapping(address => RedeemRequest) public redeemRequests;
    /**
     * @notice NFTs owed to committed-but-unclaimed random redemptions, and the
     * single in-flight random redemption (address(0) when idle).
     * @dev Deliberately packed into ONE slot. At most one request may be
     * pending vault-wide, so the count is bounded by 1 and uint96 is absurdly
     * generous; the pair is read together in _assertSolvent (which runs after
     * every state-changing call) and written together in requestRandomRedeem,
     * _settle and forfeitExpiredRedeem, so sharing a slot turns two cold
     * SLOADs into one and two SSTOREs into one on each of those paths.
     */
    uint96 public pendingRedeemCount;
    address public pendingRequester;

    event Deposited(address indexed from, uint256 indexed tokenId);
    event RedeemRequested(address indexed by, uint64 targetRound);
    event DrawPinned(address indexed by, uint256 indexed tokenId);
    event RedeemForfeited(address indexed by);
    event SharesSeeded(uint256 shares, uint256 ethIn);
    event Redeemed(address indexed to, uint256 indexed tokenId, bool targeted);
    event Bought(address indexed buyer, uint256 ethIn, uint256 sharesOut);
    event Sold(address indexed seller, uint256 sharesIn, uint256 ethOut);
    event PoolOpened(uint256 ethReserve, uint256 shareReserve);

    error FeeTooHigh();
    error EmptyVault();
    error TokenNotHeld();
    error InsufficientOutput();
    error TransferFailed();
    error NotTreasury();
    error RequestPending();
    error NoRequest();
    error TooSoon();
    /// @notice The target drand round has not been relayed yet. Expected, and
    /// short-lived: rounds publish every ~3s and ANYONE may relay one.
    error RandomnessNotAvailable();
    error RandomnessExpired();
    error InvalidBeacon();
    error ReservedForPendingRedeem();
    error SolvencyBroken();
    error DrawNotPinned();
    error NothingToSeed();
    error AlreadyHeld();
    /// @notice Seeding is permanently closed: the pool has been opened.
    error BootstrapComplete();
    /// @notice The treasury has not opened the pool for trading yet.
    error PoolNotOpen();
    /// @notice openPool() already happened; it is one-way and unrepeatable.
    error PoolAlreadyOpen();

    constructor(
        IERC721 collection_,
        string memory name_,
        string memory symbol_,
        uint256 mintFeeBps_,
        uint256 redeemFeeBps_,
        uint256 targetPremiumBps_,
        address treasury_,
        IDrandBeacon beacon_
    ) ERC20(name_, symbol_) {
        // Hard ceiling. These are immutable anyway, but this makes a
        // predatory-fee deployment impossible rather than merely unintended.
        if (mintFeeBps_ > 1_000 || redeemFeeBps_ > 1_000 || targetPremiumBps_ > 2_000) {
            revert FeeTooHigh();
        }
        if (treasury_ == address(0)) revert NotTreasury();
        // Fail closed: a zero beacon would make every random redemption
        // permanently unclaimable after the shares were already burned.
        if (address(beacon_) == address(0)) revert InvalidBeacon();
        beacon = beacon_;
        collection = collection_;
        mintFeeBps = mintFeeBps_;
        redeemFeeBps = redeemFeeBps_;
        targetPremiumBps = targetPremiumBps_;
        treasury = treasury_;
    }

    // ── Deposit / redeem ───────────────────────────────────────────────────

    /// @notice Deposit an NFT you own, receive one share minus the mint fee.
    function deposit(uint256 tokenId) external nonReentrant {
        // Pin any pending draw BEFORE the array grows. Appending cannot move
        // an index below frozenLen, so this is belt-and-braces — but it also
        // means ordinary vault traffic settles pending draws for free, which
        // is what makes the forfeit path below almost unreachable in practice.
        _pinPendingDraw();
        collection.safeTransferFrom(msg.sender, address(this), tokenId);
        _addHeldToken(tokenId);

        uint256 fee = (SHARE_UNIT * mintFeeBps) / BPS_DENOMINATOR;
        _mint(msg.sender, SHARE_UNIT - fee);
        if (fee > 0) _mint(treasury, fee);

        emit Deposited(msg.sender, tokenId);
        _assertSolvent();
    }

    /**
     * @notice Step 1 of a random redemption: burn the shares now, draw later.
     *
     * Burning up front is the whole point. If the draw and the payout happened
     * in one transaction, a contract caller could check which token it got and
     * revert the transaction to try again, repeating until it hit a rare one —
     * paying only gas to snipe the best NFTs out of the vault at the plain
     * redeem rate. Committing first makes the outcome unconditional.
     */
    function requestRandomRedeem() external nonReentrant {
        // Fail closed: one random redemption vault-wide at a time. Two
        // concurrent requests would share the same frozen prefix and could be
        // drawn onto the same slot, and resolving that collision on-chain
        // would reintroduce an ordering-dependent (therefore steerable)
        // outcome. Serializing is the honest way to keep "frozen means
        // frozen". A request is settleable BY ANYONE as soon as its drand
        // round is relayed (~3-6s), so no individual request can hold the lock
        // open indefinitely — but a determined griefer can keep re-taking the
        // slot at one share plus gas per round. See the header: grief-able,
        // never bricked.
        if (pendingRequester != address(0)) revert RequestPending();
        // Reserve one NFT for this request, on top of anything already owed.
        if (heldTokenIds.length <= pendingRedeemCount) revert EmptyVault();

        uint256 fee = (SHARE_UNIT * redeemFeeBps) / BPS_DENOMINATOR;
        _burn(msg.sender, SHARE_UNIT + fee);
        if (fee > 0) _mint(treasury, fee);

        // Anchor to a drand round that does not exist yet. Neither the caller,
        // nor any other user, nor the sequencer can know its value — drand
        // produces it off this chain on a wall clock, blind to this vault.
        uint64 targetRound = beacon.nextRoundAfter(block.timestamp) + ROUND_LEAD;

        pendingRedeemCount += 1;
        pendingRequester = msg.sender;
        redeemRequests[msg.sender] = RedeemRequest({
            targetRound: targetRound,
            // The whole fix in one assignment: the modulus is the length NOW,
            // not the length at claim time. Anything appended afterwards is
            // outside the draw set and cannot move the index.
            frozenLen: uint64(heldTokenIds.length),
            active: true,
            pinned: false,
            drawnTokenId: 0
        });

        emit RedeemRequested(msg.sender, targetRound);
        _assertSolvent();
    }

    /**
     * @notice Resolve the pending draw to a concrete tokenId. Permissionless.
     * @dev Callable by anyone, and called automatically by deposit,
     * redeemTarget and claim. Once pinned the outcome is final and immune to
     * every subsequent state change, including expiry of the target round.
     */
    function pinPendingDraw() external nonReentrant {
        _pinPendingDraw();
        address r = pendingRequester;
        if (r != address(0) && !redeemRequests[r].pinned) revert DrawNotPinned();
    }

    /// @notice Step 2: claim the NFT this request was pinned to.
    function claimRandomRedeem() external nonReentrant returns (uint256 tokenId) {
        return _settle(msg.sender);
    }

    /**
     * @notice Settle someone else's pending draw, delivering to them.
     * @dev Liveness: the outcome is theirs either way, so letting anyone push
     * it through removes the "wait and see" position entirely.
     */
    function claimRandomRedeemFor(address requester)
        external
        nonReentrant
        returns (uint256 tokenId)
    {
        return _settle(requester);
    }

    /**
     * @notice Burn an expired request that was never pinned. Permissionless.
     * @dev This replaces the old refreshRandomRedeem(), which was an unlimited
     * seed reroll: a redeemer who disliked his draw just declined to claim,
     * let the window lapse, re-anchored to a fresh block and drew again.
     *
     * There is no safe way to hand a fresh seed to someone who chose not to
     * take the one he already bought, so this fails closed: the request dies,
     * the redeemer gets nothing, and the share he burned is re-minted to the
     * treasury so the solvency invariant still balances exactly. Forfeiting is
     * strictly worse than any possible draw, which is precisely why nobody
     * will ever stall on purpose.
     *
     * Reaching this state requires that NOBODY relayed the target drand round
     * for ROUND_EXPIRY rounds (~24h) — despite relaying being permissionless,
     * costing nothing but gas, and settling the draw for free. It should be
     * unreachable in practice; it exists so a request can never be stranded
     * forever holding the single-request slot.
     */
    function forfeitExpiredRedeem(address requester) external nonReentrant {
        RedeemRequest memory req = redeemRequests[requester];
        if (!req.active) revert NoRequest();
        // Give it every last chance to resolve honestly before killing it.
        _pinPendingDraw();
        if (redeemRequests[requester].pinned) revert RequestPending();
        if (!_roundExpired(req.targetRound)) revert TooSoon();

        delete redeemRequests[requester];
        pendingRequester = address(0);
        pendingRedeemCount -= 1;
        // Keeps totalSupply + pending == held exactly. The NFT stays in the
        // vault; the claim on it moves to the treasury.
        _mint(treasury, SHARE_UNIT);

        emit RedeemForfeited(requester);
        _assertSolvent();
    }

    /// @notice Redeem a specific token ID for a share plus the target premium.
    function redeemTarget(uint256 tokenId) external nonReentrant {
        if (heldTokenIndex[tokenId] == 0) revert TokenNotHeld();

        address r = pendingRequester;
        if (r != address(0)) {
            // A targeted redeem reorders heldTokenIds (swap-and-pop), so it
            // must not run against an unresolved draw. Pin first; if the draw
            // cannot be pinned yet (same block as the commit) fail closed.
            _pinPendingDraw();
            RedeemRequest memory pend = redeemRequests[r];
            if (!pend.pinned) revert ReservedForPendingRedeem();
            // Never consume the exact NFT already drawn and paid for.
            if (pend.drawnTokenId == tokenId) revert ReservedForPendingRedeem();
        }
        // Never consume the last NFT backing a pending redemption.
        if (heldTokenIds.length <= pendingRedeemCount) revert ReservedForPendingRedeem();

        uint256 fee = (SHARE_UNIT * redeemFeeBps) / BPS_DENOMINATOR;
        uint256 premium = (SHARE_UNIT * targetPremiumBps) / BPS_DENOMINATOR;
        // Burn exactly one unit of backing plus the charges, then re-mint the
        // charges to the treasury. Net effect on supply is exactly -1 share
        // for exactly -1 NFT, which is what keeps the vault solvent.
        _burn(msg.sender, SHARE_UNIT + fee + premium);
        uint256 charges = fee + premium;
        if (charges > 0) _mint(treasury, charges);

        _removeHeldToken(tokenId);
        collection.safeTransferFrom(address(this), msg.sender, tokenId);

        emit Redeemed(msg.sender, tokenId, true);
        _assertSolvent();
    }

    // ── Constant-product pool ──────────────────────────────────────────────

    /// @notice Buy shares with ETH. `minSharesOut` is your slippage floor.
    function buyShares(uint256 minSharesOut)
        external
        payable
        nonReentrant
        returns (uint256 sharesOut)
    {
        // Checked BEFORE EmptyVault: even a partially seeded pool with both
        // reserves non-zero is not tradeable until the treasury opens it.
        if (!poolOpen) revert PoolNotOpen();
        uint256 shareReserve = balanceOf(address(this));
        if (shareReserve == 0 || ethReserve == 0) revert EmptyVault();

        // out = (in * reserveOut) / (reserveIn + in)
        sharesOut = (msg.value * shareReserve) / (ethReserve + msg.value);
        // Rounding can floor this to zero for dust input. Reverting is the
        // only honest outcome — otherwise the ETH is kept for nothing.
        if (sharesOut == 0 || sharesOut < minSharesOut) revert InsufficientOutput();

        ethReserve += msg.value;
        _transfer(address(this), msg.sender, sharesOut);
        emit Bought(msg.sender, msg.value, sharesOut);
    }

    /// @notice Sell shares for ETH. `minEthOut` is your slippage floor.
    function sellShares(uint256 sharesIn, uint256 minEthOut)
        external
        nonReentrant
        returns (uint256 ethOut)
    {
        // Checked BEFORE EmptyVault — see buyShares.
        if (!poolOpen) revert PoolNotOpen();
        uint256 shareReserve = balanceOf(address(this));
        // Both sides must be non-empty. With a zero share reserve the formula
        // below collapses to the entire ETH reserve for any input — the
        // critical drain this guard exists to stop.
        if (shareReserve == 0 || ethReserve == 0) revert EmptyVault();
        if (sharesIn == 0) revert InsufficientOutput();

        ethOut = (sharesIn * ethReserve) / (shareReserve + sharesIn);
        if (ethOut == 0 || ethOut < minEthOut) revert InsufficientOutput();

        // Effects before interaction; nonReentrant on top.
        _transfer(msg.sender, address(this), sharesIn);
        ethReserve -= ethOut;

        (bool ok, ) = msg.sender.call{value: ethOut}("");
        if (!ok) revert TransferFailed();
        emit Sold(msg.sender, sharesIn, ethOut);
    }

    /**
     * @notice Add ETH to the pool. Treasury only.
     * @dev There is deliberately no withdrawal path: pool ETH is committed
     * permanently, so the vault cannot be rugged by whoever holds the
     * treasury key.
     */
    function seedLiquidity() external payable {
        if (msg.sender != treasury) revert NotTreasury();
        // Seeding ends forever the moment the pool opens.
        if (poolOpen) revert BootstrapComplete();
        ethReserve += msg.value;
    }

    /**
     * @notice Bootstrap the pool: move treasury-held shares into the pool and
     * optionally add ETH in the same transaction. Treasury only.
     *
     * @dev Without this, seeded ETH was permanently stranded. The share side
     * of the pool is balanceOf(address(this)) and the ONLY thing that ever
     * moved shares in was sellShares — which reverts with EmptyVault while the
     * share reserve is zero, as does buyShares. A freshly seeded vault was
     * bricked on both sides and the ETH had no withdrawal path.
     *
     * Documented bootstrap procedure (see the tests):
     *   1. treasury deposits N NFTs, receiving N shares (minus mint fee);
     *   2. treasury calls seedShares{value: E}(S) with S > 0 — shares and ETH
     *      land atomically, so the pool is never live with one empty side;
     *   3. both buyShares and sellShares work from that block on.
     * Still no withdrawal path for pool ETH: seeding is one-way by design.
     */
    function seedShares(uint256 shares) external payable {
        if (msg.sender != treasury) revert NotTreasury();
        // Seeding ends forever the moment the pool opens.
        if (poolOpen) revert BootstrapComplete();
        // Fail closed rather than accept ETH that nothing can price.
        if (shares == 0) revert NothingToSeed();
        _transfer(msg.sender, address(this), shares);
        ethReserve += msg.value;
        emit SharesSeeded(shares, msg.value);
        _assertSolvent();
    }

    /**
     * @notice Open the pool for public trading. Treasury only. ONE-WAY.
     *
     * @dev This is the explicit switch that replaces any fixed bootstrap
     * threshold: the treasury seeds whatever it judges sufficient — across
     * any number of seedLiquidity/seedShares/deposit calls, in any order —
     * and then flips this. From that block on:
     *   - buyShares/sellShares are publicly usable forever;
     *   - seedLiquidity/seedShares revert forever, for everyone, no override;
     *   - this function itself can never be called again.
     *
     * The only precondition is a non-empty pool on BOTH sides. That is a
     * sanity floor (a one-sided pool is the documented bricked state where
     * both swap directions revert), NOT a minimum amount — the contract
     * deliberately does not second-guess how much is "enough".
     */
    function openPool() external {
        if (msg.sender != treasury) revert NotTreasury();
        if (poolOpen) revert PoolAlreadyOpen();
        uint256 shareReserve = balanceOf(address(this));
        if (shareReserve == 0 || ethReserve == 0) revert EmptyVault();
        poolOpen = true;
        emit PoolOpened(ethReserve, shareReserve);
    }

    // ── Views ──────────────────────────────────────────────────────────────

    function heldTokenCount() external view returns (uint256) {
        return heldTokenIds.length;
    }

    /// @notice NFTs redeemable right now, excluding those owed to pending draws.
    function availableTokenCount() external view returns (uint256) {
        uint256 held = heldTokenIds.length;
        return held > pendingRedeemCount ? held - pendingRedeemCount : 0;
    }

    function isTokenHeld(uint256 tokenId) external view returns (bool) {
        return heldTokenIndex[tokenId] != 0;
    }

    /**
     * @notice The token the in-flight random redemption is locked to.
     * @return pinned true once the outcome is final and unchangeable.
     * @return tokenId the drawn token (meaningless while `pinned` is false).
     */
    function pendingDraw() external view returns (bool pinned, uint256 tokenId) {
        address r = pendingRequester;
        if (r == address(0)) return (false, 0);
        RedeemRequest memory req = redeemRequests[r];
        return (req.pinned, req.drawnTokenId);
    }

    /**
     * @notice The drand round the in-flight request is waiting on, and whether
     * it has been relayed yet. A UI should show "waiting for drand round N"
     * rather than a generic spinner, and may relay the round itself.
     */
    function pendingRound() external view returns (uint64 round, bool available) {
        address r = pendingRequester;
        if (r == address(0)) return (0, false);
        round = redeemRequests[r].targetRound;
        available = beacon.isRoundAvailable(round);
    }

    // ── Internals ──────────────────────────────────────────────────────────

    /**
     * @dev Resolve the in-flight draw to a concrete tokenId, if possible.
     * No-op when there is nothing pending, when it is already pinned, or when
     * the target drand round has not been relayed yet. Callers that
     * mutate heldTokenIds must treat "still not pinned" as a hard stop.
     *
     * Correctness rests on one property: between the commit and this call, the
     * prefix heldTokenIds[0, frozenLen) is untouched. deposit() only appends;
     * every removal path (redeemTarget, _settle) calls this first and reverts
     * if it does not pin. So `heldTokenIds[index]` here is exactly the token
     * that sat at that index when the request was made.
     */
    function _pinPendingDraw() private {
        address r = pendingRequester;
        if (r == address(0)) return;
        RedeemRequest storage req = redeemRequests[r];
        if (req.pinned) return;
        // The target round's signature may not have been relayed yet. That is
        // the normal case for the first few seconds after a request; anyone
        // can relay it (see DrandBeacon.submitRound and scripts/relay-drand.ts).
        // One external call, not two: randomnessOrZero folds the availability
        // check into the read, and the zero guard below — which this code
        // already had as belt-and-braces — is exactly the "not relayed yet"
        // signal. A zero seed would be identical for every caller and every
        // request, so it must never be drawn from either way.
        bytes32 seed = beacon.randomnessOrZero(req.targetRound);
        if (seed == bytes32(0)) return;

        uint256 index = uint256(keccak256(abi.encodePacked(seed, r))) % req.frozenLen;
        uint256 drawn = heldTokenIds[index];
        req.drawnTokenId = drawn;
        req.pinned = true;
        emit DrawPinned(r, drawn);
    }

    /// @dev Deliver a pinned draw to its requester. Anyone may push it.
    function _settle(address requester) private returns (uint256 tokenId) {
        RedeemRequest memory req = redeemRequests[requester];
        if (!req.active) revert NoRequest();

        _pinPendingDraw();
        req = redeemRequests[requester];
        if (!req.pinned) {
            // Distinguish the two honest states: "wait ~3s for someone to
            // relay the round" versus "nobody ever did, forfeit it". There is
            // no second seed on offer in either case — see
            // forfeitExpiredRedeem for why a reroll can never be handed out.
            if (_roundExpired(req.targetRound)) revert RandomnessExpired();
            revert RandomnessNotAvailable();
        }

        delete redeemRequests[requester];
        pendingRequester = address(0);
        pendingRedeemCount -= 1;

        tokenId = req.drawnTokenId;
        _removeHeldToken(tokenId);
        /**
         * transferFrom, NOT safeTransferFrom, and this is the one transfer in
         * the contract where that is the correct choice.
         *
         * The bug it closes: pinning is a standalone, permissionless
         * transaction (pinPendingDraw) that commits pinned=true on its own,
         * before any delivery is attempted. If delivery could revert, a
         * requester contract without onERC721Received — malicious, or simply a
         * smart-contract wallet that never implemented the hook — left the
         * request in a state where claim reverts forever on the transfer while
         * forfeitExpiredRedeem refuses to touch a pinned request. Since
         * pendingRequester is a single vault-wide slot cleared only here, that
         * permanently killed random redemption for EVERY user and locked one
         * NFT forever, for the price of one share.
         *
         * The receiver check buys nothing here that it buys elsewhere: this
         * address did not passively receive an NFT, it burned a share and
         * asked for one. Making the payout unconditional means the vault-wide
         * slot always has an exit. The recipient is never called, so there is
         * also no reentrancy or revert-to-reroll surface on this path — which
         * is a strict improvement over safeTransferFrom's callback.
         *
         * deposit() and redeemTarget() keep safeTransferFrom: there, a revert
         * only unwinds the caller's own transaction and strands nothing.
         */
        collection.transferFrom(address(this), requester, tokenId);

        emit Redeemed(requester, tokenId, false);
        _assertSolvent();
    }

    // ── Internals ──────────────────────────────────────────────────────────

    /**
     * @dev Has the target round been in the past for longer than the grace
     * window? Uses the beacon's own schedule, so it stays correct even if the
     * chain's notion of time drifts relative to block production.
     */
    function _roundExpired(uint64 targetRound) private view returns (bool) {
        uint64 nowRound = beacon.currentRoundAt(block.timestamp);
        return nowRound > targetRound && nowRound - targetRound > ROUND_EXPIRY;
    }

    /// @dev The solvency invariant. Reverting here unwinds the whole call.
    function _assertSolvent() private view {
        if (totalSupply() + pendingRedeemCount * SHARE_UNIT != heldTokenIds.length * SHARE_UNIT) {
            revert SolvencyBroken();
        }
    }

    function _addHeldToken(uint256 tokenId) private {
        // Defense in depth against a non-standard collection that could let the
        // same tokenId arrive twice: a duplicate would corrupt heldTokenIndex
        // (one index overwriting the other) and desync the solvency invariant
        // from the array. One warm SLOAD to make that unreachable.
        if (heldTokenIndex[tokenId] != 0) revert AlreadyHeld();
        heldTokenIds.push(tokenId);
        heldTokenIndex[tokenId] = heldTokenIds.length; // 1-based
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
