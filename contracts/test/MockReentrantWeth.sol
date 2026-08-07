// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @notice A HOSTILE stand-in for the wrapped-ETH leg, built to attack exactly
 * one window: the span inside `IndexDividendDistributor.claimAndReinvest`
 * between `_crystallise` (which settles the caller's debt) and `_resync`
 * (which re-assigns it at the CURRENT accumulator height).
 *
 * WHY THIS MOCK EXISTS AT ALL, given that the real call graph is clean.
 * ---------------------------------------------------------------------
 * `claimAndReinvest` holds that window open across two external calls:
 * `weth.deposit{value: amount}()` and `indexVault.mintSingleAsset(...)`. The
 * canonical WETH9 (contracts/test/CanonicalWeth9.sol) only credits a mapping
 * in `deposit`, and every external read `mintSingleAsset` performs is a
 * `view` interface call or an explicit `staticcall` — so with the REAL pieces
 * in place there is no reachable path back into `receiveDividends` and the
 * window is closed by the callees' shape. That is a fact about someone else's
 * bytecode, not a property of this contract, and a future WETH swap or a new
 * vault call could revoke it silently.
 *
 * This mock is that future, brought forward: it IS the reinvest asset, and it
 * calls `receiveDividends` from inside both external calls the window spans
 * (`deposit`, and `transferFrom` — the one the vault's `_pullCredited` makes
 * during `mintSingleAsset`). If `receiveDividends` were unguarded, the
 * accumulator would rise mid-window and the caller's own accrual would be
 * erased by the `_resync` that follows. The guard makes that unreachable, and
 * this contract is what proves it rather than asserting it.
 *
 * Otherwise a faithful, minimal WETH9: deposit credits, withdraw pays, and
 * `totalSupply` is the ETH held. LOCAL HARDHAT TEST ONLY.
 */
interface IReceiveDividends {
    function receiveDividends() external payable;
}

contract MockReentrantWeth {
    string public constant name = "Hostile Wrapped Ether";
    string public constant symbol = "hWETH";
    uint8 public constant decimals = 18;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    /// @notice The distributor to re-enter. Zero disables the attack entirely.
    address public target;
    /// @notice Re-enter from `deposit()` — the FIRST call in the window.
    bool public attackOnDeposit;
    /// @notice Re-enter from `transferFrom()` — reached from inside the
    /// vault's `mintSingleAsset`, i.e. the SECOND call in the window.
    bool public attackOnTransferFrom;
    /// @notice How much ETH the re-entrant push tries to inject.
    uint256 public reenterValue;
    /// @notice If true the re-entrant call is made with a raw `.call` and its
    /// failure is SWALLOWED, so the outer transaction survives and the test
    /// can read `reenterSucceeded` to see whether the attack landed. If false
    /// the failure bubbles and reverts everything.
    bool public swallow;

    /// @notice Set by every attempt. FALSE after a blocked attempt is the
    /// whole point of this contract.
    bool public reenterSucceeded;
    uint256 public reenterAttempts;

    event Deposit(address indexed dst, uint256 wad);
    event Withdrawal(address indexed src, uint256 wad);
    event Transfer(address indexed src, address indexed dst, uint256 wad);
    event Approval(address indexed src, address indexed guy, uint256 wad);

    function arm(
        address target_,
        bool onDeposit,
        bool onTransferFrom,
        uint256 value_,
        bool swallow_
    ) external {
        target = target_;
        attackOnDeposit = onDeposit;
        attackOnTransferFrom = onTransferFrom;
        reenterValue = value_;
        swallow = swallow_;
        reenterSucceeded = false;
        reenterAttempts = 0;
    }

    /// @notice Fund the attacker's own ETH war chest for the re-entrant push.
    /// Deliberately NOT credited as wrapped balance — this is the attacker's
    /// capital, not a deposit.
    function fundAttack() external payable {}

    function _tryReenter() private {
        address t = target;
        if (t == address(0)) return;
        uint256 v = reenterValue;
        if (address(this).balance < v) return;
        reenterAttempts += 1;
        if (swallow) {
            (bool ok, ) = t.call{value: v}(
                abi.encodeWithSelector(IReceiveDividends.receiveDividends.selector)
            );
            if (ok) reenterSucceeded = true;
        } else {
            IReceiveDividends(t).receiveDividends{value: v}();
            reenterSucceeded = true;
        }
    }

    // ══ WETH9 surface ═════════════════════════════════════════════════════

    function deposit() public payable {
        balanceOf[msg.sender] += msg.value;
        emit Deposit(msg.sender, msg.value);
        if (attackOnDeposit) _tryReenter();
    }

    function withdraw(uint256 wad) public {
        require(balanceOf[msg.sender] >= wad, "hWETH: insufficient");
        balanceOf[msg.sender] -= wad;
        payable(msg.sender).transfer(wad);
        emit Withdrawal(msg.sender, wad);
    }

    function totalSupply() public view returns (uint256) {
        return address(this).balance;
    }

    function approve(address guy, uint256 wad) public returns (bool) {
        allowance[msg.sender][guy] = wad;
        emit Approval(msg.sender, guy, wad);
        return true;
    }

    function transfer(address dst, uint256 wad) public returns (bool) {
        return transferFrom(msg.sender, dst, wad);
    }

    function transferFrom(address src, address dst, uint256 wad) public returns (bool) {
        require(balanceOf[src] >= wad, "hWETH: insufficient");
        if (src != msg.sender && allowance[src][msg.sender] != type(uint256).max) {
            require(allowance[src][msg.sender] >= wad, "hWETH: allowance");
            allowance[src][msg.sender] -= wad;
        }
        balanceOf[src] -= wad;
        balanceOf[dst] += wad;
        emit Transfer(src, dst, wad);
        if (attackOnTransferFrom) _tryReenter();
        return true;
    }

    receive() external payable {
        deposit();
    }
}
