// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * ============================================================================
 *  CollectionVaultLP — real, transferable ERC-20 LP receipt for ONE
 *  `CollectionVault`'s internal constant-product pool, per
 *  docs/DESIGN-COLLECTION-VAULT-NATIVE-LP-AND-ZAP-MINT-2026-08-08.md §3.1.
 *
 *  This is a SEPARATE claim from the vault's own share token `S`
 *  (`CollectionVault is ERC20`) — holding LP does not mean holding S, and
 *  vice versa. `CollectionVault` is the ONLY minter/burner (`onlyVault`),
 *  and it only ever mints via `addLiquidity` / burns via `removeLiquidity`,
 *  both of which act on `msg.sender`'s own balance — this contract itself
 *  grants the vault no arbitrary admin-burn power over a holder who did not
 *  call `removeLiquidity` themselves.
 *
 *  Deployed lazily, once, at `openPool()` — NOT in `CollectionVault`'s
 *  constructor — so the factory's existing `type(CollectionVault).creationCode`
 *  call site (`CollectionVaultFactory._creationCode`) needs no change at all.
 * ============================================================================
 */
contract CollectionVaultLP is ERC20 {
    address public immutable vault;

    error NotVault();

    constructor(string memory name_, string memory symbol_, address vault_) ERC20(name_, symbol_) {
        vault = vault_;
    }

    modifier onlyVault() {
        if (msg.sender != vault) revert NotVault();
        _;
    }

    function mint(address to, uint256 amount) external onlyVault {
        _mint(to, amount);
    }

    function burn(address from, uint256 amount) external onlyVault {
        _burn(from, amount);
    }
}
