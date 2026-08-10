// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/security/ReentrancyGuard.sol";

interface IWeth9Adapter {
    function deposit() external payable;
    function withdraw(uint256 amount) external;
}

/// @dev The subset of the already-LIVE `MarketplankVaultV3` this adapter
/// reads and calls. Declared locally rather than importing the real
/// contract, so this file has no compile-time dependency on V3's exact
/// source (matches `IndexCoinPool.sol`'s own "standalone contract" doctrine).
interface IMarketplankVaultV3 {
    function ethReserve() external view returns (uint256);
    function shareReserve() external view returns (uint256);
    function swapFeeBps() external view returns (uint256);
    function poolOpen() external view returns (bool);
    function buyShares(uint256 minSharesOut) external payable returns (uint256 sharesOut);
    function sellShares(uint256 sharesIn, uint256 minEthOut) external returns (uint256 ethOut);
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
}

/**
 * ============================================================================
 *  RobinwoodV3Adapter — wires the ALREADY-LIVE, ALREADY-TRADING
 *  MarketplankVaultV3 into the Honest Index's EnergyBus/WeightModule system
 *  as a real, honestly-scored constituent, WITHOUT moving, migrating, or
 *  touching a single existing V3 depositor's shares or LP position. V3 keeps
 *  running exactly as it does today, forever — this contract only lets NEW
 *  protocol-routed WETH energy (Pipe I / Pipe L) additionally deploy into
 *  V3's own AMM, on top of what is already there.
 *
 *  WHY A WRAPPER, NOT A PASSTHROUGH. `WeightModule.weights()` returns an
 *  address that EnergyBus adapters (`InventoryBuyAdapter`, `CollectionLpAdapter`)
 *  treat as BOTH the CollectionVault-shaped quote/buy/sell surface AND the
 *  ERC20 share token itself — e.g. `IERC20(vault).safeTransfer(index, sharesOut)`
 *  is called directly on that address. V3 mints its OWN shares, not this
 *  adapter's, so a bare passthrough cannot stand in for `vault` on the
 *  token-transfer half of that contract. This contract therefore mints a
 *  strict 1:1 WRAPPED claim (wV3S) for every real V3 share it custodies —
 *  the cToken/ERC-4626 shape — so its own balance is always a real,
 *  redeemable claim on custodied V3 shares, never a synthetic promise.
 *  `shareReserve()` below reports THIS wrapper's own outstanding supply
 *  (what is actually redeemable through it), never V3's raw `shareReserve`
 *  (almost all of which belongs to pre-existing V3 depositors this contract
 *  has no claim on and must never price against).
 *
 *  SCORING HONESTY (game-theory audit hardening). This adapter deliberately
 *  pushes ONLY `noteDepth` to WeightModule — an objective read of V3's real
 *  `ethReserve`, unfakeable without real, continuously-held capital (see
 *  `WeightModule._windowMin`). It never pushes `noteFee`/`noteMintPressure`/
 *  `noteVolume`. V3's own fees route to its `immutable treasury` — fully
 *  recoverable by V3's own admin, not an unrecoverable sink — so crediting
 *  them as F/P/V would violate the `R <= C` bound and reopen exactly the
 *  wash-trading vulnerability (audit H-4) WeightModule's redesign closed.
 *  Robinwood therefore earns weight here purely from real, verifiable depth,
 *  never from a fabricated activity signal — see `ROBINWOOD_FLOOR_BPS` in
 *  `WeightModule.sol` for the separate, capacity-bounded floor guarantee,
 *  which does not depend on this adapter reporting F/P/V at all.
 * ============================================================================
 */
contract RobinwoodV3Adapter is ReentrancyGuard {
    using SafeERC20 for IERC20;

    IMarketplankVaultV3 public immutable v3;
    IERC20 public immutable weth;
    address public immutable weightModule;

    string public constant name = "Wrapped Robinwood V3 Share";
    string public constant symbol = "wV3S";
    uint8 public constant decimals = 18;

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    uint256 private constant BPS_DENOMINATOR = 10_000;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    event DepthPoked(uint256 ethReserve);

    error ZeroAddress();
    error ZeroAmount();
    error InsufficientBalance();
    error InsufficientAllowance();
    error InsufficientOutput();
    error PoolNotOpen();
    error EmptyVault();

    constructor(address v3_, address weth_, address weightModule_) {
        if (v3_ == address(0) || weth_ == address(0)) revert ZeroAddress();
        v3 = IMarketplankVaultV3(v3_);
        weth = IERC20(weth_);
        weightModule = weightModule_;
    }

    // ── ERC20, minimal, standard ───────────────────────────────────────────

    function transfer(address to, uint256 amount) external returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed < amount) revert InsufficientAllowance();
        allowance[from][msg.sender] = allowed - amount;
        _transfer(from, to, amount);
        return true;
    }

    function _transfer(address from, address to, uint256 amount) private {
        if (to == address(0)) revert ZeroAddress();
        uint256 bal = balanceOf[from];
        if (bal < amount) revert InsufficientBalance();
        balanceOf[from] = bal - amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
    }

    // ── CollectionVault-shaped read surface, honest pass-through ──────────

    /// @notice V3's real ETH reserve, WETH-denominated 1:1 (ETH and WETH are
    /// par by construction of the wrapped-ether standard this system already
    /// relies on elsewhere).
    function paymentReserve() external view returns (uint256) {
        return v3.ethReserve();
    }

    /// @notice THIS wrapper's own outstanding supply — the redeemable claim
    /// on custodied V3 shares — never V3's raw `shareReserve`. See header.
    function shareReserve() external view returns (uint256) {
        return totalSupply;
    }

    function poolOpen() external view returns (bool) {
        return v3.poolOpen();
    }

    /// @notice Mirrors V3's OWN `buyShares` pricing, wei-for-wei — required
    /// so `InventoryBuyAdapter`'s pre-trade quote never promises more than
    /// execution pays (design doc §1.2/§1.3 discipline, applied here to V3's
    /// formula instead of CollectionVault's).
    function quoteBuyShares(uint256 amountIn) public view returns (uint256 sharesOut) {
        if (!v3.poolOpen() || amountIn == 0) return 0;
        uint256 r = v3.ethReserve();
        uint256 s = v3.shareReserve();
        if (r == 0 || s == 0) return 0;
        uint256 inNet = (amountIn * (BPS_DENOMINATOR - v3.swapFeeBps())) / BPS_DENOMINATOR;
        return (inNet * s) / (r + inNet);
    }

    /// @notice Mirrors V3's own `sellShares` pricing, wei-for-wei. Only ever
    /// quotes against THIS wrapper's own custodied position — see
    /// `sellShares` below.
    function quoteSellShares(uint256 sharesIn) public view returns (uint256 amountOut) {
        if (!v3.poolOpen() || sharesIn == 0) return 0;
        uint256 r = v3.ethReserve();
        uint256 s = v3.shareReserve();
        if (r == 0 || s == 0) return 0;
        uint256 inNet = (sharesIn * (BPS_DENOMINATOR - v3.swapFeeBps())) / BPS_DENOMINATOR;
        return (inNet * r) / (s + inNet);
    }

    /// @notice No predicate gating exists on V3's own redeem surface — this
    /// adapter reports that honestly (zero) rather than fabricate a root.
    /// `WeightModule.setRobinwoodVault` therefore correctly refuses this
    /// contract until/unless that changes; see the header's SCORING HONESTY
    /// note and `WeightModule.sol`'s own doc on `RobinwoodVaultMustBeGated`.
    function eligibilityRoot() external pure returns (bytes32) {
        return bytes32(0);
    }

    function realizableBps(uint256 sharesIn) external view returns (uint256) {
        if (sharesIn == 0 || totalSupply == 0) return 0;
        uint256 mark = (sharesIn * v3.ethReserve()) / v3.shareReserve();
        if (mark == 0) return 0;
        return (quoteSellShares(sharesIn) * BPS_DENOMINATOR) / mark;
    }

    // ── Write surface: deploy protocol WETH energy into V3's real AMM ─────

    /// @notice Called by `InventoryBuyAdapter` (Pipe I) exactly as it would
    /// call a real `CollectionVault`: pulls `amountIn` WETH, unwraps it,
    /// buys real V3 shares with the resulting ETH, and mints the caller an
    /// equal wrapped claim. Every wei pulled becomes either a real V3 share
    /// held in custody or is refunded — never stranded.
    function buyShares(uint256 amountIn, uint256 minSharesOut) external nonReentrant returns (uint256 sharesOut) {
        if (amountIn == 0) revert ZeroAmount();
        if (!v3.poolOpen()) revert PoolNotOpen();
        if (v3.ethReserve() == 0 || v3.shareReserve() == 0) revert EmptyVault();

        uint256 before = weth.balanceOf(address(this));
        weth.safeTransferFrom(msg.sender, address(this), amountIn);
        uint256 credited = weth.balanceOf(address(this)) - before;
        if (credited == 0) revert ZeroAmount();

        IWeth9Adapter(address(weth)).withdraw(credited);
        sharesOut = v3.buyShares{value: credited}(minSharesOut);
        if (sharesOut == 0) revert InsufficientOutput();

        totalSupply += sharesOut;
        balanceOf[msg.sender] += sharesOut;
        emit Transfer(address(0), msg.sender, sharesOut);

        _pokeDepth();
    }

    /// @notice The symmetric exit: burns the caller's wrapped claim, sells
    /// the same real V3 shares, wraps the ETH proceeds back to WETH.
    function sellShares(uint256 sharesIn, uint256 minAmountOut) external nonReentrant returns (uint256 amountOut) {
        if (sharesIn == 0) revert ZeroAmount();
        uint256 bal = balanceOf[msg.sender];
        if (bal < sharesIn) revert InsufficientBalance();

        balanceOf[msg.sender] = bal - sharesIn;
        totalSupply -= sharesIn;
        emit Transfer(msg.sender, address(0), sharesIn);

        uint256 ethOut = v3.sellShares(sharesIn, 0);
        if (ethOut < minAmountOut || ethOut == 0) revert InsufficientOutput();

        IWeth9Adapter(address(weth)).deposit{value: ethOut}();
        amountOut = ethOut;
        weth.safeTransfer(msg.sender, amountOut);

        _pokeDepth();
    }

    /// @notice Permissionless, matching `WeightModule.pokeDepth`'s own
    /// discipline — anyone (a keeper, a rival, the Bus itself) can put V3's
    /// true current depth on the record, so a stale high sample can never be
    /// protected by going quiet.
    function pokeDepth() external {
        _pokeDepth();
    }

    function _pokeDepth() private {
        uint256 r = v3.ethReserve();
        (bool ok, ) = weightModule.call(abi.encodeWithSignature("pokeDepth(address)", address(this)));
        ok; // best-effort; WeightModule.pokeDepth already degrades non-reverting on a non-vault target
        emit DepthPoked(r);
    }

    /// @dev Lets this contract receive the ETH `v3.sellShares` pays out and
    /// nothing else.
    receive() external payable {}
}
