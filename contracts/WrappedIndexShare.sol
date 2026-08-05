// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

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
 *  This contract is that wrapper, and nothing else:
 *
 *    - It is OPT-IN. Direct holders of the raw share are wholly unaffected and
 *      keep using the vault mechanism that already works for them.
 *    - It has NO owner, NO admin, NO roles, NO pause, NO timelock, NO
 *      upgrade path and no privileged function of any kind. There is no lever
 *      here that could lock a user's assets, because there is no lever.
 *    - `deposit` / `withdraw` / `harvest` are the entire external surface.
 *    - It holds NO accounting state at all beyond its own ERC-20 supply.
 *      Backing is read from live balances, so a stray donation of either
 *      backing asset is simply a gift to every wrapped holder and can never
 *      desynchronise an internal ledger from reality.
 *
 *  HOW THE RATE APPRECIATES — WITH ZERO MARKET RISK
 *  ------------------------------------------------
 *  Because this contract holds raw shares, it IS a direct holder, so the
 *  vault's own correction-term mechanism accrues its dividend automatically,
 *  with no special support and nothing new to trust. `harvest()` is a
 *  permissionless public-good trigger that calls `claimDividend()` and pulls
 *  in what was ALREADY earned. No swap. No price. No oracle. No slippage. No
 *  route. The harvested asset lands in this contract's backing and is paid out
 *  pro rata on withdraw — yield shows up as backing growth, never as balance
 *  growth, and the growth mechanism itself takes no market risk whatsoever.
 *
 *  THE JOIN IS PROPORTIONAL IN BOTH BACKING ASSETS. READ THIS.
 *  ----------------------------------------------------------
 *  Backing is TWO assets: raw shares (R) and harvested dividend asset (D).
 *  The obvious design — mint against `R + D` as if one unit of each were worth
 *  the same, and accept raw shares alone — is UNSOUND, and not subtly. Let a
 *  raw share be worth `p` units of the dividend asset on the open market. A
 *  deposit of `x` raw priced against `R + D`, immediately withdrawn, nets
 *
 *      out - in  =  x * D * (1 - p) / (R + D + x)
 *
 *  which is a risk-free drain of the existing holders whenever `p < 1`, and a
 *  silent robbery of the depositor whenever `p > 1`. The two assets have no
 *  fixed relative value, so `p = 1` is never true except by accident. Adding
 *  unlike units is a valuation claim, and this codebase does not make
 *  valuation claims it cannot defend.
 *
 *  So `deposit` is a PROPORTIONAL JOIN, the Balancer/Set model this repo uses
 *  everywhere else: supplying `x` raw shares also requires supplying the
 *  matching `ceil(x * D / R)` of the dividend asset. Round-tripping is then
 *  exactly value-neutral in BOTH assets for ANY `p`, with no price ever read.
 *  When `D == 0` (nothing harvested yet) the requirement is zero and the join
 *  is single-asset, which is the common case. The wrapped token itself remains
 *  a single fixed-balance ERC-20 with one appreciating exchange rate, which is
 *  the only property the downstream LP pool ever needed.
 *
 *  `deposit` and `withdraw` both harvest FIRST, so the pending-but-unharvested
 *  entitlement is never a window in which a new depositor can buy into value
 *  that predates them, or an exiting holder can walk away from value they
 *  earned.
 *
 *  FIRST-DEPOSITOR INFLATION
 *  -------------------------
 *  Defended with GlobalIndexVault's own `VIRTUAL_SHARES` / `VIRTUAL_ASSETS`
 *  offsets, same constants, same direction, deliberately not a new invention.
 *  A griefer donating raw shares or dividend asset into an empty wrapper is
 *  making a gift, not setting a trap: the virtual offsets keep the second
 *  depositor's mint from rounding toward zero, and the proportional join keeps
 *  the donation from ever being mispriced against them.
 *
 *  A consequence worth stating plainly: the FIRST deposit into an empty
 *  wrapper mints `VIRTUAL_SHARES : VIRTUAL_ASSETS`, i.e. 1000 wIDX per raw
 *  share, so wIDX opens at 1000x the raw share's unit count and drifts down as
 *  the rate appreciates. That is the offset doing its job, not a bug; wIDX's
 *  balance is a bookkeeping unit and only its redemption value is meaningful.
 *
 *  ROUNDING
 *  --------
 *  Every division that pays a user floors; every division that charges a user
 *  ceils. Dust always settles in the wrapper, i.e. with the holders who
 *  stayed, never systematically to the last actor out. Same discipline as the
 *  vault's redeem path.
 * ============================================================================
 */
contract WrappedIndexShare is ERC20, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice The raw GlobalIndexVault share token being wrapped.
    IIndexDividendShare public immutable indexShare;

    /// @notice The vault's own dividend denomination, read from the vault at
    /// construction via its real `dividendAsset()` getter — never passed in,
    /// so the two can never disagree.
    IERC20 public immutable dividendAsset;

    /**
     * @dev The first-depositor-inflation offsets, copied verbatim from
     * GlobalIndexVault. Not retuned, not reinvented: the same numbers make the
     * same argument, and that argument is already tested in this repo.
     */
    uint256 private constant VIRTUAL_SHARES = 10 ** 3;
    uint256 private constant VIRTUAL_ASSETS = 1;

    error ZeroAmount();
    error NothingToMint();
    error NothingToReturn();
    error NoDividendAsset();

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

    constructor(
        address indexShare_,
        string memory name_,
        string memory symbol_
    ) ERC20(name_, symbol_) {
        if (indexShare_ == address(0)) revert ZeroAmount();
        indexShare = IIndexDividendShare(indexShare_);
        address asset = IIndexDividendShare(indexShare_).dividendAsset();
        // A vault with dividends switched off has nothing for this wrapper to
        // do, and a wrapper whose second backing asset is address(0) would be
        // a footgun waiting for the vault to be replaced. Refuse at birth.
        if (asset == address(0)) revert NoDividendAsset();
        dividendAsset = IERC20(asset);
    }

    // ══ views ═══════════════════════════════════════════════════════════════

    /// @notice Raw index shares currently backing the wrapped supply.
    function rawSharesHeld() public view returns (uint256) {
        return indexShare.balanceOf(address(this));
    }

    /// @notice Harvested dividend asset currently backing the wrapped supply.
    function dividendAssetHeld() public view returns (uint256) {
        return dividendAsset.balanceOf(address(this));
    }

    /// @notice What one wrapped share currently redeems for, both legs, at
    /// `1e18` granularity. Purely informational — no code path prices off it.
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
     *
     * Deliberately quoted WITHOUT harvesting first (a view cannot), so it is a
     * lower bound. `deposit` harvests before it prices, which can only raise
     * `D` and therefore the requirement — hence the headroom note.
     */
    function quoteDividendAssetIn(uint256 rawSharesIn) external view returns (uint256) {
        return _dividendSideFor(rawSharesIn, rawSharesHeld(), dividendAssetHeld(), totalSupply());
    }

    /// @notice What this wrapper could pull from the vault right now.
    function pendingDividend() external view returns (uint256) {
        return indexShare.withdrawableDividendOf(address(this));
    }

    // ══ the entire mutating surface ═════════════════════════════════════════

    /**
     * @notice Pull in the dividend this wrapper has already earned as a
     * direct raw-share holder, raising the exchange rate for every wrapped
     * holder at once — including a passive LP pool that will never call
     * anything itself.
     *
     * Permissionless by design and safe to call by anyone, repeatedly,
     * back to back. With nothing to claim it is a clean no-op returning 0,
     * matching `GlobalIndexVault.claimDividend`'s own documented behaviour
     * ("paying zero is a successful transaction, not an error"). A harvest
     * that reverted on zero would be a griefable gate on a public good.
     */
    function harvest() external nonReentrant returns (uint256 claimed) {
        claimed = _harvest();
    }

    /**
     * @notice Wrap raw index shares into wIDX.
     *
     * Pulls `rawSharesIn` raw shares and, if any dividend asset is already in
     * backing, the proportional dividend-asset side alongside it (see the
     * header — a single-asset join against mixed backing is a drain). BOTH
     * pulls credit the MEASURED BALANCE DELTA, never the nominal amount: the
     * Balancer-STA discipline every other inbound path in this codebase uses,
     * so a fee-on-transfer token cannot mint against value that never arrived.
     */
    function deposit(uint256 rawSharesIn)
        external
        nonReentrant
        returns (uint256 wrappedOut)
    {
        if (rawSharesIn == 0) revert ZeroAmount();

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
        // actually arrived. Scaling by the raw leg alone is correct and
        // conservative: the dividend leg is a proportional obligation, so
        // short-changing it can only ever leave the pool richer per wrapped
        // share, never poorer.
        if (rawCredited < rawSharesIn) {
            wrappedOut = Math.mulDiv(wrappedOut, rawCredited, rawSharesIn);
        }
        if (divIn > 0 && divCredited < divIn) {
            // The raw side bought a proportional claim on a dividend side that
            // did not fully show up. Charge the shortfall to the depositor's
            // own mint rather than to the pool.
            wrappedOut = Math.mulDiv(wrappedOut, divCredited, divIn);
        }

        if (wrappedOut == 0) revert NothingToMint();
        _mint(msg.sender, wrappedOut);

        emit Wrapped(msg.sender, rawCredited, divCredited, wrappedOut);
    }

    /**
     * @notice Unwrap wIDX back into its exact pro-rata slice of BOTH backing
     * assets — raw index shares AND accrued dividend asset — in one call.
     *
     * Both divisions floor, so dust stays with the holders who stayed and
     * there is no way to extract more than your exact share. Harvests first so
     * an exiting holder is paid the dividend they earned right up to the
     * block they leave in.
     */
    function withdraw(uint256 wrappedIn)
        external
        nonReentrant
        returns (uint256 rawSharesOut, uint256 dividendAssetOut)
    {
        if (wrappedIn == 0) revert ZeroAmount();

        _harvest();

        // Read AFTER harvest, BEFORE the burn. The `+ VIRTUAL_SHARES` on the
        // denominator is the redeem-side half of the offset pair, mirroring
        // GlobalIndexVault's own `redeemProRata`: the mint side charges
        // against `R + VIRTUAL_ASSETS` while the redeem side pays against `R`
        // alone, which makes deposit-then-withdraw STRICTLY lossy for the
        // round-tripper by construction rather than by rounding luck.
        uint256 denom = totalSupply() + VIRTUAL_SHARES;
        rawSharesOut = Math.mulDiv(wrappedIn, rawSharesHeld(), denom);
        dividendAssetOut = Math.mulDiv(wrappedIn, dividendAssetHeld(), denom);

        // A burn that returns nothing at all is a user error, not a feature.
        // Reverting here cannot trap anything: the caller keeps their wrapped
        // shares and can simply exit a larger amount.
        if (rawSharesOut == 0 && dividendAssetOut == 0) revert NothingToReturn();

        // Effects before interactions. `_burn` reverts on insufficient
        // balance, which is what authorises the payout.
        _burn(msg.sender, wrappedIn);

        if (rawSharesOut > 0) {
            IERC20(address(indexShare)).safeTransfer(msg.sender, rawSharesOut);
        }
        if (dividendAssetOut > 0) {
            dividendAsset.safeTransfer(msg.sender, dividendAssetOut);
        }

        emit Unwrapped(msg.sender, wrappedIn, rawSharesOut, dividendAssetOut);
    }

    // ══ internals ═══════════════════════════════════════════════════════════

    /**
     * @dev The proportional dividend-asset side owed alongside `rawIn`.
     *
     * Zero while the wrapper is empty (`supply == 0`): with no wrapped shares
     * outstanding there is nobody for a donated dividend balance to belong to,
     * so requiring a matching side would let one wei of donation price the
     * first real depositor out of the contract entirely. A donation into an
     * empty wrapper is a gift to whoever opens it, which is not an attack.
     *
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
     * vault and credit the MEASURED delta. Never reverts on zero.
     */
    function _harvest() private returns (uint256 claimed) {
        if (indexShare.withdrawableDividendOf(address(this)) == 0) return 0;
        uint256 before = dividendAssetHeld();
        indexShare.claimDividend();
        claimed = dividendAssetHeld() - before;
        if (claimed > 0) emit Harvested(msg.sender, claimed);
    }
}
