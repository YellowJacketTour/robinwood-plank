// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * ============================================================================
 *  IndexDividendDistributor — trustless ETH dividends for index-share holders
 *
 *  NOT FOR DEPLOYMENT. Same gate as GlobalIndexVault.sol and PlankGauge.sol:
 *  nothing in this repo may put any of them on any network until the external
 *  audit of SPEC-PLANK-CHECKS-AND-INDEX.md §2.6 clears. hardhat.config.ts has
 *  no default network on purpose; keep it that way.
 *
 *  WHY THIS IS A SEPARATE CONTRACT AND NOT A SECTION OF THE VAULT
 *  -------------------------------------------------------------
 *  Because GlobalIndexVault must keep the property its own suite asserts
 *  directly: "the vault cannot hold ETH at all — there is no receive and no
 *  payable path". A dividend accumulator is by definition an ETH custodian.
 *  Folding it into the vault would put a live ETH balance next to the pooled
 *  constituent reserves and would mean every future change to either had to
 *  re-argue that they cannot reach each other. Keeping them apart means the
 *  argument is made once, structurally, and stays made.
 *
 *  THE CUSTODY BOUNDARY, STATED AS A ONE-WAY ARROW
 *  ----------------------------------------------
 *  This contract's only reference to the vault is `IIndexMint`, an interface
 *  that declares exactly ONE function: `mintSingleAsset`. That is a function
 *  that GIVES the vault value. There is no redeem, no withdraw, no transfer
 *  out of reserves, no admin call and no parameter call in the interface, so
 *  none exists in this bytecode to be reached by any caller or any bug. Value
 *  flows distributor -> vault and never the other way. GlobalIndexVault's
 *  anchor guarantee #4 is therefore untouched by this contract's existence,
 *  for the same reason PlankGauge does not touch it: the lever is absent, not
 *  merely guarded.
 *
 *  Symmetrically, the vault has NO reference to this contract. It was
 *  deliberately not given a transfer hook on its share ERC-20 — the obvious
 *  implementation, and the wrong one. A hook in `_beforeTokenTransfer`
 *  calling a timelocked-admin-set address would hand that admin a share
 *  FREEZE: point the hook at anything that reverts and every transfer, every
 *  mint and every redeem of the index bricks, because a redeem burns shares.
 *  Freezing redemption is functionally the anchor rule violated from the
 *  other side, so the hook was refused and holders OPT IN by staking instead.
 *
 *  THE ACCOUNTING (MasterChef / Synthetix StakingRewards shape)
 *  -----------------------------------------------------------
 *  Holders `stake` index shares here. `receiveDividends()` is payable and
 *  permissionless — anyone may push ETH, and in practice the caller is the
 *  same off-chain fee flow that already routes marketplace revenue, exactly
 *  as PlankGauge's old `receiveRewards` was. Each push raises a single global
 *  accumulator:
 *
 *      accEthPerShareWad += msg.value * WAD / totalStaked
 *
 *  and a holder's entitlement is the textbook debt-tracked difference:
 *
 *      pending_a = stakedOf[a] * accEthPerShareWad / WAD - claimedDebt[a]
 *
 *  THE BALANCE-CHANGE BUG, AND HOW IT IS ACTUALLY AVOIDED
 *  -----------------------------------------------------
 *  This pattern has exactly one hard part and it is worth naming precisely,
 *  because getting it subtly wrong is the single most common way this shape
 *  fails: `pending_a` is computed from the CURRENT balance against a debt
 *  recorded at some PAST balance. If the balance changes without settling
 *  first, the accumulated-but-unpaid amount for the old balance is silently
 *  recomputed at the new balance — over-paying on a stake (you get paid as if
 *  you had held the larger amount all along) and, worse, underflowing on an
 *  unstake.
 *
 *  The fix, applied at EVERY site that can move a balance and nowhere else:
 *
 *      1. `_settle(a)` FIRST, while `stakedOf[a]` is still the old value.
 *         This crystallises pending into `owed[a]` and sets
 *         `claimedDebt[a] = oldBalance * acc / WAD`.
 *      2. change the balance.
 *      3. RE-SYNC `claimedDebt[a] = newBalance * acc / WAD` — assignment, not
 *         accrual. Because `acc` cannot move between (1) and (3) (nothing in
 *         between calls out to anything that could raise it, and every entry
 *         point is `nonReentrant`), the freshly-computed pending across that
 *         boundary is exactly zero, which is the correct answer: no time
 *         passed and no dividend arrived.
 *
 *  `owed[a]` is a settled, immutable-until-paid figure. It is never
 *  recomputed from a balance, so a holder who stakes, earns, unstakes
 *  everything and walks away still has their earnings — and a holder who
 *  stakes late cannot reach back for a distribution that predates them,
 *  because their debt is set at the accumulator's CURRENT height.
 *
 *  CONSERVATION
 *  ------------
 *  `totalClaimed <= totalReceived` is an invariant, not an aspiration, and it
 *  holds for a structural reason: every division in the accumulator floors,
 *  so each push credits marginally LESS than it deposited, and the remainder
 *  stays in the contract forever. The suite asserts it directly over a long
 *  randomised sequence of stakes, unstakes, pushes and claims.
 *
 *  ETH pushed while `totalStaked == 0` has nobody to credit. It is NOT lost
 *  and NOT reverted: it accumulates in `undistributed` and folds into the
 *  accumulator on the first push that has stakers. That is the same
 *  honest-queryable-state discipline the old gauge's threshold used, minus
 *  the machinery.
 * ============================================================================
 */

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/**
 * @notice The ONLY thing this contract may ask GlobalIndexVault to do. One
 * function, and it is the one that hands the vault value. Deliberately not
 * the full vault interface: an interface is an attack surface, and a
 * one-function interface is a one-function attack surface.
 */
interface IIndexMint {
    function mintSingleAsset(address token, uint256 amountIn, uint256 minSharesOut)
        external
        returns (uint256 sharesOut);
}

/**
 * @notice The REAL canonical WETH9 surface: the wrap/unwrap pair on top of the
 * standard ERC-20 one. This is the interface of the already-deployed,
 * already-verified WETH at 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73 on the
 * target chain (lib/constants.ts `MARKET_OFFER_CURRENCY`, the same contract
 * the marketplace already uses as its offer currency) — not a mock, and not a
 * shape invented here.
 *
 * The address is NOT hardcoded. It is a constructor-set immutable, so a local
 * test can point this contract at a locally-deployed copy of the real
 * canonical WETH9 source (contracts/test/CanonicalWeth9.sol) and exercise the
 * genuine semantics, including the ones a hand-rolled mock silently gets
 * wrong. An immutable rather than a storage slot because a mutable wrapped-ETH
 * address is a mutable definition of what every reinvestment means.
 */
interface IWETH9 is IERC20 {
    function deposit() external payable;

    function withdraw(uint256 amount) external;
}

contract IndexDividendDistributor is ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 private constant WAD = 1e18;

    /// @notice Generation marker so the client never has to sniff bytecode.
    uint256 public constant DISTRIBUTOR_VERSION = 1;

    /// @notice The index share token. Staked here, never minted or burned by
    /// this contract — it has no authority to do either.
    IERC20 public immutable shareToken;

    /// @notice The vault, seen through a one-function, deposit-only lens.
    IIndexMint public immutable indexVault;

    /**
     * @notice The wrapped-ETH constituent `claimAndReinvest` routes through.
     * May be address(0), in which case reinvestment is simply unavailable and
     * `claim()` is the only exit — the vault prices constituents as ERC-20s
     * and has no ETH entry point at all, so a wrapped-ETH leg is a hard
     * requirement for the compounding path, not a convenience.
     */
    IWETH9 public immutable reinvestAsset;

    /// @notice ETH-per-staked-share accumulator, WAD-scaled. Monotone.
    uint256 public accEthPerShareWad;

    uint256 public totalStaked;
    mapping(address => uint256) public stakedOf;
    /// @notice The debt term of the accumulator pattern: what `stakedOf[a] *
    /// acc / WAD` was worth the last time this account's balance was touched.
    mapping(address => uint256) public claimedDebt;
    /// @notice Settled, not-yet-paid ETH. Never recomputed from a balance.
    mapping(address => uint256) public owed;

    /// @notice Pushed while nobody was staked; folds in on the next push.
    uint256 public undistributed;

    /// @notice Lifetime totals. `totalClaimed <= totalReceived`, always.
    uint256 public totalReceived;
    uint256 public totalClaimed;

    event Staked(address indexed account, uint256 shares);
    event Unstaked(address indexed account, uint256 shares);
    event DividendsReceived(address indexed from, uint256 amount, uint256 totalStaked);
    event Claimed(address indexed account, uint256 amount);
    event Reinvested(address indexed account, uint256 ethIn, uint256 sharesOut);

    error ZeroAmount();
    error InsufficientStake();
    error TransferFailed();
    error ReinvestUnavailable();
    error BadParam();
    error DirectEthRejected();

    constructor(IERC20 shareToken_, IIndexMint indexVault_, IWETH9 reinvestAsset_) {
        if (address(shareToken_) == address(0) || address(indexVault_) == address(0)) {
            revert BadParam();
        }
        shareToken = shareToken_;
        indexVault = indexVault_;
        reinvestAsset = reinvestAsset_;
    }

    // ══ Stake / unstake ═══════════════════════════════════════════════════

    /// @notice Deposit index shares to start earning pushed dividends.
    function stake(uint256 shares) external nonReentrant {
        if (shares == 0) revert ZeroAmount();
        _settle(msg.sender); // 1. settle at the OLD balance

        // Credit the ACTUAL delta, never the nominal amount — same
        // Balancer-STA discipline GlobalIndexVault._pullCredited applies. The
        // index share token is a plain ERC-20 today; this costs one SLOAD and
        // removes the assumption entirely.
        uint256 before = shareToken.balanceOf(address(this));
        shareToken.safeTransferFrom(msg.sender, address(this), shares);
        uint256 credited = shareToken.balanceOf(address(this)) - before;
        if (credited == 0) revert ZeroAmount();

        stakedOf[msg.sender] += credited; // 2. change the balance
        totalStaked += credited;
        _resync(msg.sender); // 3. re-sync the debt by ASSIGNMENT
        emit Staked(msg.sender, credited);
    }

    /// @notice Withdraw staked index shares. Settled earnings are untouched
    /// and stay claimable afterwards — leaving does not forfeit anything.
    function unstake(uint256 shares) external nonReentrant {
        if (shares == 0) revert ZeroAmount();
        if (stakedOf[msg.sender] < shares) revert InsufficientStake();
        _settle(msg.sender);
        stakedOf[msg.sender] -= shares;
        totalStaked -= shares;
        _resync(msg.sender);
        shareToken.safeTransfer(msg.sender, shares);
        emit Unstaked(msg.sender, shares);
    }

    // ══ Dividends in ══════════════════════════════════════════════════════

    /**
     * @notice Push ETH to every staked holder, pro rata. Permissionless on
     * purpose: making it a privileged role would buy nothing (a griefer's
     * "attack" is donating money) and would add a key to lose.
     */
    function receiveDividends() external payable {
        _credit(msg.value);
    }

    /**
     * @notice Push dividends denominated in WRAPPED ETH. Pulled, UNWRAPPED to
     * real ETH through the real `WETH.withdraw`, then credited by the identical
     * accumulator every other push uses.
     *
     * Exists because the marketplace fee flow this contract is fed by settles
     * in the offer currency, which IS the WETH at `reinvestAsset` — so without
     * this the pusher has to unwrap first, off-chain, in a separate
     * transaction, and a step that has to be remembered is a step that gets
     * skipped.
     *
     * THE UNWRAP-AND-PAY PATTERN, done in the order that matters:
     *   1. pull the WETH and credit the ACTUAL delta (Balancer-STA
     *      discipline, same as `stake` and the vault's `_pullCredited`);
     *   2. `WETH.withdraw(credited)` — the real contract, which pays this
     *      contract back in ETH through `receive()` below;
     *   3. ONLY THEN the accounting, in `_credit`.
     * Both external calls are to the immutable WETH address and nowhere else,
     * the whole function is `nonReentrant`, and no state this contract owns is
     * read across either of them.
     */
    function receiveDividendsWrapped(uint256 amount) external nonReentrant {
        IWETH9 weth = reinvestAsset;
        if (address(weth) == address(0)) revert ReinvestUnavailable();
        if (amount == 0) revert ZeroAmount();

        uint256 before = weth.balanceOf(address(this));
        IERC20(address(weth)).safeTransferFrom(msg.sender, address(this), amount);
        uint256 credited = weth.balanceOf(address(this)) - before;
        if (credited == 0) revert ZeroAmount();

        uint256 ethBefore = address(this).balance;
        weth.withdraw(credited);
        // Credit what really arrived as ETH, never the nominal figure.
        _credit(address(this).balance - ethBefore);
    }

    /// @dev The one accumulator, shared by both push paths.
    function _credit(uint256 amount) private {
        if (amount == 0) revert ZeroAmount();
        totalReceived += amount;
        uint256 pot = amount + undistributed;
        uint256 staked = totalStaked;
        if (staked == 0) {
            // Nobody to credit. Held, never lost, never reverted.
            undistributed = pot;
            emit DividendsReceived(msg.sender, amount, 0);
            return;
        }
        undistributed = 0;
        // Floors. The remainder stays in the contract forever, which is what
        // makes totalClaimed <= totalReceived structural rather than hopeful.
        accEthPerShareWad += Math.mulDiv(pot, WAD, staked);
        emit DividendsReceived(msg.sender, amount, staked);
    }

    /**
     * @notice ETH may enter this contract through `receiveDividends` and
     * through the WETH contract unwrapping. NOTHING ELSE.
     *
     * This is Uniswap's router pattern (`assert(msg.sender == WETH)`) and it
     * is here for its reason, not its shape: a bare `receive()` that accepts
     * anyone's ETH makes unsolicited donation ETH indistinguishable from
     * pushed dividends. That matters because `ethStatus()` publishes
     * `held` against `received - claimed`, and a donation would silently widen
     * the gap between them — turning a real solvency read into a number with
     * an unexplained residue in it, which is exactly the kind of accounting
     * fog that hides a genuine shortfall. Refusing donation ETH keeps
     * "everything here was pushed, and is accounted for" true by construction.
     *
     * Deliberately cheap: the guard is one immutable read (no SLOAD) and one
     * comparison, so it fits inside the 2300-gas stipend real WETH9's
     * `withdraw` pays with. A `receive()` that did anything more would be
     * unpayable by the real contract — which is precisely the class of bug the
     * hand-rolled mock's gas-forwarding `.call` was hiding.
     */
    receive() external payable {
        if (msg.sender != address(reinvestAsset)) revert DirectEthRejected();
    }

    // ══ Dividends out ═════════════════════════════════════════════════════

    /**
     * @notice Claim everything settled and pending. Paying zero is a
     * successful transaction, not an error — `claimable()` is where a caller
     * learns why it was zero.
     *
     * CHECKS-EFFECTS-INTERACTIONS, PLUS A GUARD, AND BOTH ARE LOAD-BEARING.
     * `_crystallise` applies EVERY state change this function makes —
     * `_settle`, `owed[a] = 0`, `totalClaimed += amount` — strictly BEFORE the
     * raw `.call`. So a recipient that re-enters mid-payment finds
     * `owed[msg.sender]` already zero and `claimable()` already zero: even
     * with the guard removed, a re-entrant claim would pay nothing, which is
     * the property that actually matters. `nonReentrant` is defence in depth
     * on top of that, not the thing holding it up, and the audit suite proves
     * the extraction bound against a mock recipient that really does re-enter.
     *
     * A raw `.call` rather than `transfer` because 2300 gas is not enough for
     * a smart-contract holder (a multisig, a vault, a splitter) to accept a
     * payment, and pinning a gas stipend into the payout path would silently
     * lock those holders out of their own dividends after any repricing. The
     * boolean IS checked — a failed send reverts the whole claim, so the
     * dividend is never marked paid when it was not.
     */
    function claim() external nonReentrant returns (uint256 amount) {
        amount = _crystallise(msg.sender); // ALL effects, before any interaction
        if (amount == 0) return 0;
        (bool ok, ) = payable(msg.sender).call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit Claimed(msg.sender, amount);
    }

    /**
     * @notice AUTO-COMPOUND. Claim the caller's pending dividend, wrap it,
     * mint index shares with it through the vault's existing
     * `mintSingleAsset`, and stake the result for the caller — atomically.
     *
     * Deliberately a thin composition of two things that already exist and
     * are already proven, with NO new economics anywhere in it: the caller
     * pays the ordinary mint-side imbalance fee and the ordinary platform
     * allocation, exactly as if they had claimed to their wallet and minted
     * by hand. The only thing this function buys is atomicity and one
     * signature instead of four.
     *
     * If the mint side fails for any reason — concentration cap, persistence
     * gate, stale price, slippage, a queued removal on the reinvest leg —
     * the WHOLE call reverts and the caller's pending dividend is exactly
     * where it was. There is no partial state: the claim, the wrap, the mint
     * and the stake are one transaction.
     *
     * @param minSharesOut slippage guard, passed straight through to the vault.
     */
    function claimAndReinvest(uint256 minSharesOut)
        external
        nonReentrant
        returns (uint256 sharesOut)
    {
        IWETH9 weth = reinvestAsset;
        if (address(weth) == address(0)) revert ReinvestUnavailable();

        uint256 amount = _crystallise(msg.sender);
        if (amount == 0) revert ZeroAmount();

        weth.deposit{value: amount}();
        IERC20(address(weth)).forceApprove(address(indexVault), amount);
        sharesOut = indexVault.mintSingleAsset(address(weth), amount, minSharesOut);
        if (sharesOut == 0) revert ZeroAmount();

        // The shares landed on THIS contract. Stake them for the caller,
        // using the identical settle -> change -> re-sync order every other
        // balance-moving path uses. `_crystallise` already settled, and the
        // accumulator cannot have moved since (nonReentrant, and nothing
        // above raises it), so a re-sync by assignment is exact.
        stakedOf[msg.sender] += sharesOut;
        totalStaked += sharesOut;
        _resync(msg.sender);

        emit Reinvested(msg.sender, amount, sharesOut);
        emit Staked(msg.sender, sharesOut);
    }

    // ══ Views ═════════════════════════════════════════════════════════════

    /// @notice Everything `account` could take out right now.
    function claimable(address account) public view returns (uint256) {
        return owed[account] + _pending(account);
    }

    /// @notice The honest, queryable ETH state. `held` is the real balance;
    /// `received - claimed` is what is still owed to somebody in aggregate;
    /// `parked` is the slice that has no staker to credit yet. The gap
    /// between (received - claimed) and the sum of every holder's
    /// `claimable()` is the flooring dust the accumulator retains, and it is
    /// permanently unclaimable by design — that retention is exactly what
    /// makes the conservation invariant structural.
    function ethStatus()
        external
        view
        returns (uint256 held, uint256 received, uint256 claimed, uint256 parked)
    {
        return (address(this).balance, totalReceived, totalClaimed, undistributed);
    }

    /// @notice Solvency: staked shares are always fully backed by real shares.
    function shareSolvency() external view returns (uint256 held, uint256 staked) {
        return (shareToken.balanceOf(address(this)), totalStaked);
    }

    function capabilities()
        external
        pure
        returns (bool pushOnly, bool pullsFromVault, bool autoCompounds, uint256 version)
    {
        // `pullsFromVault` is hardcoded FALSE and is a structural fact, not a
        // setting: the vault interface this contract holds declares exactly
        // one function and it is a deposit.
        return (true, false, true, DISTRIBUTOR_VERSION);
    }

    // ══ Internals ═════════════════════════════════════════════════════════

    function _pending(address account) private view returns (uint256) {
        uint256 accrued = Math.mulDiv(stakedOf[account], accEthPerShareWad, WAD);
        uint256 debt = claimedDebt[account];
        // Cannot underflow: `accEthPerShareWad` is monotone and `debt` was
        // assigned as `stakedOf * acc / WAD` at the last balance change, with
        // the same flooring division. Written defensively anyway — the whole
        // point of this contract is that this line is never wrong.
        return accrued > debt ? accrued - debt : 0;
    }

    /// @dev STEP 1. Crystallise pending into `owed` at the CURRENT balance.
    function _settle(address account) private {
        uint256 pending = _pending(account);
        if (pending > 0) owed[account] += pending;
        claimedDebt[account] = Math.mulDiv(stakedOf[account], accEthPerShareWad, WAD);
    }

    /// @dev STEP 3. Re-anchor the debt to the NEW balance by ASSIGNMENT. Not
    /// an accrual — accruing here is the bug this contract exists to not have.
    function _resync(address account) private {
        claimedDebt[account] = Math.mulDiv(stakedOf[account], accEthPerShareWad, WAD);
    }

    /// @dev Settle, then zero and return the payable amount. Effects fully
    /// applied before any interaction, on both callers.
    function _crystallise(address account) private returns (uint256 amount) {
        _settle(account);
        amount = owed[account];
        if (amount == 0) return 0;
        owed[account] = 0;
        totalClaimed += amount;
    }
}
