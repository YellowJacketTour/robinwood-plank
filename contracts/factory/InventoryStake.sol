// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/security/ReentrancyGuard.sol";

/**
 * ============================================================================
 *  InventoryStake — PR4 of the AXIOM-1 stack (ONESHOT §5.2 / §7 / §8 XTOKEN-*,
 *  SPEC-AXIOM-1-ENERGY-BUS-AND-ADAPTERS.md preamble).
 *
 *  ERC-4626-style vault: asset = a single `CollectionVault`'s own share token
 *  ("vToken"), share = the inventory-stake share this contract mints
 *  ("xToken"). Depositing vToken mints xToken; redeeming xToken burns it and
 *  returns vToken. This is the CVI-critical NESTED compound: `convertToAssets`
 *  must genuinely rise over time as fees compound vToken INTO this stake, not
 *  merely reflect deposit-time pricing — see `compound()` below.
 *
 *  WHY THIS IS SAFE AGAINST FIRST-DEPOSITOR INFLATION (ONESHOT §4.1a /
 *  DESIGN-N-VAULT-FACTORY-AND-VALUE-ACCRUAL-2026-08-06.md's already-proven
 *  pattern, applied identically here): OZ's ERC4626 base (v4.9+) already
 *  implements "virtual shares + virtual assets" via `_decimalsOffset()` —
 *  `_convertToShares`/`_convertToAssets` divide/multiply against
 *  `totalSupply() + 10**offset` and `totalAssets() + 1`, exactly the same
 *  `+ VIRTUAL_SHARES` shape this codebase already uses everywhere else
 *  (`IndexFacetBase.VIRTUAL_SHARES = 10**3`, `WrappedIndexShare.VIRTUAL_SHARES
 *  = 10**3`). This contract sets `_decimalsOffset() == 3`, i.e. the identical
 *  1000:1 virtual-share:virtual-asset ratio, so a first depositor cannot
 *  donate-and-frontrun a second depositor's deposit into a near-zero-share
 *  price — the same mitigation, the same magnitude, applied a third time in
 *  this codebase.
 *
 *  ONLY THE COMPOUNDER MAY CREDIT FEE-COMPOUND ASSETS. `compound()` is the
 *  ONLY way new vToken assets can land here through a code path that raises
 *  `convertToAssets` WITHOUT also minting xToken (a plain `deposit` always
 *  mints proportional shares — it cannot dilute anyone). `compound()` is
 *  gated to the single immutable `compounder` address, set at construction to
 *  the `CollectionVault` whose own share this stake wraps (ONESHOT §5.2:
 *  "only CollectionVault or fee router may credit fee-compound assets"). A
 *  third party CAN still plain-`ERC20.transfer` vToken directly to this
 *  contract's balance (nothing can prevent a raw token transfer) — but that
 *  is the exact "donation" scenario the virtual-shares offset above already
 *  neutralizes; it is not a privileged, unlimited-supply credit path the way
 *  an ungated `compound()` would be.
 * ============================================================================
 */
contract InventoryStake is ERC4626, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @dev Matches this codebase's existing `VIRTUAL_SHARES = 10**3`
    /// convention (`IndexFacetBase.sol`, `WrappedIndexShare.sol`) — OZ 4626's
    /// `_decimalsOffset()` produces the identical 1000:1 virtual ratio.
    uint8 private constant DECIMALS_OFFSET = 3;

    /// @notice The only address ever permitted to call `compound()` — the
    /// `CollectionVault` whose own share token is this stake's `asset()`.
    /// Immutable: fixed once, at construction, never re-pointable.
    address public immutable compounder;

    /// @notice Emitted every time fee revenue compounds new vToken into this
    /// stake. `assetsCredited` is the OBSERVED balance delta (never the
    /// caller's nominal `assetsIn`), following this codebase's universal
    /// balance-delta discipline (`CollectionVault._pullFee`).
    event Compounded(uint256 assetsIn, uint256 assetsCredited, uint256 totalAssetsAfter, uint256 totalSupplyAfter);

    error ZeroAddress();
    error NotCompounder();
    error ZeroAmount();

    constructor(IERC20 vToken_, address compounder_, string memory name_, string memory symbol_)
        ERC20(name_, symbol_)
        ERC4626(vToken_)
    {
        if (address(vToken_) == address(0) || compounder_ == address(0)) revert ZeroAddress();
        compounder = compounder_;
    }

    function _decimalsOffset() internal pure override returns (uint8) {
        return DECIMALS_OFFSET;
    }

    /**
     * @notice Credit newly fee-compounded vToken into this stake vault. This
     * is a PURE asset credit — no xToken is minted — so it raises
     * `convertToAssets(1 share)` for every existing xToken holder without
     * diluting anyone. Callable only by `compounder`.
     * @param assets Nominal amount of vToken the compounder is transferring
     * in. The actually-credited amount is the observed balance delta.
     */
    function compound(uint256 assets) external nonReentrant returns (uint256 credited) {
        if (msg.sender != compounder) revert NotCompounder();
        if (assets == 0) revert ZeroAmount();
        IERC20 vToken = IERC20(asset());
        uint256 before = vToken.balanceOf(address(this));
        vToken.safeTransferFrom(msg.sender, address(this), assets);
        credited = vToken.balanceOf(address(this)) - before;
        emit Compounded(assets, credited, totalAssets(), totalSupply());
    }

    // ── Reentrancy-hardened overrides of the standard 4626 value paths ─────
    // (OZ's base has none; every other value-moving entrypoint in this
    // codebase's factory contracts uses `nonReentrant` — CollectionVault.sol
    // — so this stake matches that convention.)

    function deposit(uint256 assets, address receiver) public override nonReentrant returns (uint256) {
        return super.deposit(assets, receiver);
    }

    function mint(uint256 shares, address receiver) public override nonReentrant returns (uint256) {
        return super.mint(shares, receiver);
    }

    function withdraw(uint256 assets, address receiver, address owner) public override nonReentrant returns (uint256) {
        return super.withdraw(assets, receiver, owner);
    }

    function redeem(uint256 shares, address receiver, address owner) public override nonReentrant returns (uint256) {
        return super.redeem(shares, receiver, owner);
    }
}
