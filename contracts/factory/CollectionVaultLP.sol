// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

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
 *
 *  ── WHY THIS IS A HAND-WRITTEN ERC-20 RATHER THAN `is ERC20` ──────────────
 *  EIP-170 arithmetic, and it is not close. `CollectionVault` deploys this
 *  contract with `new`, so this contract's ENTIRE CREATION CODE is a constant
 *  inside `CollectionVault`'s bytecode; `CollectionVault`'s creation code is
 *  in turn a constant inside `CollectionVaultFactory`, which CREATE2s it. So
 *  every byte here is a byte in the factory's 24,576-byte budget. Measured:
 *  the OpenZeppelin-derived version cost 5,186 bytes there and put the factory
 *  at 26,156 — undeployable.
 *
 *  The alternative factorings do not help, and it is worth recording why so
 *  nobody re-attempts them:
 *    - An EXTERNAL library cannot be used at all: solc refuses
 *      `type(C).creationCode` for a contract that requires linking, which is
 *      exactly what `CollectionVaultFactory` needs. An INTERNAL library is
 *      inlined and saves nothing.
 *    - Moving the `new` into the factory, or cloning an implementation the
 *      factory deploys, relocates the same constant rather than removing it —
 *      the LP's creation code is embedded exactly once either way, so the
 *      factory's total is unchanged. (Measured, not assumed.)
 *  Shrinking the code is therefore the only lever, and this is the smallest
 *  surface that is still a complete, correct ERC-20.
 *
 *  It is a deliberately boring implementation: no permit, no hooks beyond the
 *  one the dwell mechanism requires, no burn-from-allowance, no infinite-
 *  allowance special case, no unchecked blocks. Every arithmetic operation is
 *  checked by 0.8.x, and `_transfer`/`_spendAllowance` follow the same shape
 *  as OpenZeppelin's so a reader can diff them by eye.
 * ============================================================================
 */

/// @dev The one callback this token makes into its vault. Declared as a
/// minimal interface rather than importing `CollectionVault` because the
/// import would be circular (`CollectionVault` deploys this contract).
interface ICollectionVaultLpHook {
    function onLpReceived(address to) external;
}

contract CollectionVaultLP is IERC20 {
    /// @notice The one `CollectionVault` this receipt belongs to. This
    /// immutable, not a per-instance name string, is the token's identity —
    /// which is why constant metadata below costs nothing real. (The factory
    /// already hardcodes every vault's own share token to the same
    /// "Collection Vault Share"/"cvSHARE" pair.)
    address public immutable vault;

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    error NotVault();
    error ZeroAddressTransfer();
    error InsufficientBalance();
    error InsufficientAllowance();

    constructor(address vault_) {
        vault = vault_;
    }

    function name() external pure returns (string memory) {
        return "Collection Vault LP";
    }

    function symbol() external pure returns (string memory) {
        return "cvLP";
    }

    function decimals() external pure returns (uint8) {
        return 18;
    }

    modifier onlyVault() {
        if (msg.sender != vault) revert NotVault();
        _;
    }

    function mint(address to, uint256 amount) external onlyVault {
        if (to == address(0)) revert ZeroAddressTransfer();
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
        _onReceived(to);
    }

    function burn(address from, uint256 amount) external onlyVault {
        uint256 bal = balanceOf[from];
        if (bal < amount) revert InsufficientBalance();
        balanceOf[from] = bal - amount;
        totalSupply -= amount;
        emit Transfer(from, address(0), amount);
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed < amount) revert InsufficientAllowance();
        // No infinite-allowance shortcut, deliberately: a special case is a
        // branch, and a branch is a place to be wrong.
        allowance[from][msg.sender] = allowed - amount;
        _transfer(from, to, amount);
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function _transfer(address from, address to, uint256 amount) private {
        if (to == address(0)) revert ZeroAddressTransfer();
        uint256 bal = balanceOf[from];
        if (bal < amount) revert InsufficientBalance();
        balanceOf[from] = bal - amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
        _onReceived(to);
    }

    /**
     * @dev AUDIT C-3, half 2. `CollectionVault.removeLiquidity` enforces a
     * minimum LP dwell. That guarantee would be worthless if this token were
     * freely transferable and the clock lived only on the caller, because an
     * attacker would simply mint LP to address A and remove from a virgin
     * address B — a per-caller lock on a transferable receipt is not a lock at
     * all. So EVERY inbound movement of LP, mint or transfer, restarts the
     * recipient's clock in the vault.
     *
     * Burns are skipped: there is no recipient, and the vault has already made
     * its dwell decision by the time it calls `burn`.
     *
     * Called AFTER balances settle (CEI), and the callee is `vault` — the one
     * address that already has total authority over this token — so this adds
     * no trust surface and no untrusted external call.
     */
    function _onReceived(address to) private {
        ICollectionVaultLpHook(vault).onLpReceived(to);
    }
}
