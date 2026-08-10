// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IndexFacetBase} from "./IndexFacetBase.sol";
import {ERC20Storage, CoreStorage, DiamondStorage} from "../storage/IndexStorage.sol";

/**
 * ============================================================================
 *  IndexShareFacet — the ERC-20 share, and the ERC-7575 SHARE half.
 *
 *  NOT FOR DEPLOYMENT except as a facet. Calling this contract directly reads
 *  and writes ITS OWN storage, which is empty; every meaningful call arrives by
 *  DELEGATECALL from the diamond.
 *
 *  ERC-7575, HONESTLY (design doc section 4.4)
 *  -------------------------------------------
 *  ERC-7575 splits "the share token" from "the vault(s) that mint it". The
 *  diamond IS the canonical share, so `share()` returns `address(this)` — which
 *  the spec explicitly permits ("MAY be the vault itself"). That is a
 *  CONFORMANT but DEGENERATE arrangement on its own, and this file says so
 *  rather than advertising a standard it gains nothing from: the value only
 *  becomes real once per-asset entry points (Pipes) exist, at which point
 *  `vault(asset)` starts returning something other than the diamond.
 *
 *  `vault(address)` therefore returns the registered pipe for an asset and
 *  falls back to `address(this)` — never `address(0)` — so a 4626-aware
 *  integrator always has an address to point at.
 *
 *  WHAT THIS FACET DELIBERATELY DOES NOT HAVE
 *  ------------------------------------------
 *  No role modifier on any function, no pause, no blocklist, no transfer hook
 *  that can fail, and no mint or burn entrypoint. Shares are minted only by the
 *  deposit paths and burned only by the exit door. A share that can be frozen
 *  is a redemption that can be blocked, and this facet holds no such lever.
 * ============================================================================
 */
contract IndexShareFacet is IndexFacetBase {
    /// @notice ERC-7575 share-token interface id.
    bytes4 internal constant ERC7575_SHARE_INTERFACE_ID = 0xf815c03d;

    /// @notice Emitted when an asset's ERC-7575 entry point is registered.
    event VaultUpdate(address indexed asset, address vault);

    // ── ERC-20 metadata ────────────────────────────────────────────────────

    function name() external view returns (string memory) {
        return ERC20Storage.layout().name;
    }

    function symbol() external view returns (string memory) {
        return ERC20Storage.layout().symbol;
    }

    function decimals() external pure returns (uint8) {
        return 18;
    }

    // ── ERC-20 core ────────────────────────────────────────────────────────

    function totalSupply() external view returns (uint256) {
        return _totalSupply();
    }

    function balanceOf(address account) external view returns (uint256) {
        return _balanceOf(account);
    }

    function allowance(address owner, address spender) external view returns (uint256) {
        return ERC20Storage.layout().allowances[owner][spender];
    }

    function transfer(address to, uint256 value) external returns (bool) {
        _transferShares(msg.sender, to, value);
        return true;
    }

    function approve(address spender, uint256 value) external returns (bool) {
        _approveShares(msg.sender, spender, value);
        return true;
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        _spendAllowance(from, msg.sender, value);
        _transferShares(from, to, value);
        return true;
    }

    function increaseAllowance(address spender, uint256 added) external returns (bool) {
        ERC20Storage.Layout storage s = ERC20Storage.layout();
        _approveShares(msg.sender, spender, s.allowances[msg.sender][spender] + added);
        return true;
    }

    function decreaseAllowance(address spender, uint256 subtracted) external returns (bool) {
        ERC20Storage.Layout storage s = ERC20Storage.layout();
        uint256 current = s.allowances[msg.sender][spender];
        if (current < subtracted) revert InsufficientAllowance(msg.sender, spender, current, subtracted);
        unchecked {
            _approveShares(msg.sender, spender, current - subtracted);
        }
        return true;
    }

    // ── ERC-7575 ───────────────────────────────────────────────────────────

    /// @notice The ERC-20 representing this system's shares. The diamond itself.
    function share() external view returns (address) {
        return address(this);
    }

    /**
     * @notice The entry point registered for `asset`, or the diamond itself.
     *
     * @dev Never `address(0)`. An integrator that reads a zero here would
     * reasonably conclude the asset is unsupported, when in fact every listed
     * constituent is depositable through the diamond's own
     * `mintSingleAsset` — so the honest answer is "the diamond", not "nothing".
     */
    function vault(address asset) external view returns (address) {
        address pipe = CoreStorage.layout().assetPipe[asset];
        return pipe == address(0) ? address(this) : pipe;
    }

    /// @notice Where the seed shares are locked at open, permanently. The
    /// public face of `IndexFacetBase.SEED_LOCK_ADDR`; see that declaration for
    /// why the getter lives in exactly one facet.
    function SEED_LOCK() external pure returns (address) {
        return SEED_LOCK_ADDR;
    }
}
