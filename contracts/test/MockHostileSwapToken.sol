// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IIndexCoinPoolSwap {
    function swap(
        bool paymentIn,
        uint256 amountIn,
        uint256 minAmountOut,
        address to
    ) external returns (uint256 amountOut);

    function getReserves() external view returns (uint256, uint256);
}

/**
 * TEST ONLY. Never deploy.
 *
 * A minimal ERC-20 with two hostile switches, each aimed at one of the two
 * defects the 2026-08-09 audit found in `IndexCoinPool.swap` (F-4/F-5/F-6):
 *
 *  1. `reenterOnTransferFrom` — calls back into `pool.swap` from inside the
 *     INPUT pull. This is the exact window the missing `nonReentrant` left
 *     open: the pool has taken the caller's tokens but has not yet written
 *     its reserves, so a re-entrant trade is priced against liquidity already
 *     committed to the outer trade. With the guard in place the re-entrant
 *     call must revert; the test asserts that, and asserts the outer swap
 *     still works with the switch OFF, so it cannot pass vacuously.
 *
 *  2. `feeBps` — burns a percentage on every transfer, i.e. a fee-on-transfer
 *     token. The pool must credit the OBSERVED delta, not the nominal
 *     `amountIn`. Crediting nominal makes the reserve claim more than the
 *     contract holds, which is the "never display a number we cannot pay"
 *     violation.
 *
 * Both switches default to OFF, so this doubles as a plain ERC-20 baseline.
 */
contract MockHostileSwapToken {
    string public name;
    string public symbol;
    uint8 public constant decimals = 18;

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    /// @notice Burn this many bps on every transfer. 0 = a normal ERC-20.
    uint256 public feeBps;

    /// @notice The pool to re-enter, and from which leg.
    address public pool;
    bool public reenterOnTransferFrom;
    bool public reenterOnTransfer;
    /// @notice Arguments for the re-entrant swap.
    bool public reenterPaymentIn;
    uint256 public reenterAmount;

    /// @notice Observations the test reads back.
    uint256 public reenterAttempts;
    bool public reenterSucceeded;
    uint256 public seenReservePayment;
    uint256 public seenReserveCoin;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(string memory n, string memory s) {
        name = n;
        symbol = s;
    }

    function mint(address to, uint256 amount) external {
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function setFeeBps(uint256 bps) external {
        require(bps < 10_000, "fee");
        feeBps = bps;
    }

    function arm(
        address pool_,
        bool onTransferFrom,
        bool onTransfer,
        bool paymentIn_,
        uint256 amount_
    ) external {
        pool = pool_;
        reenterOnTransferFrom = onTransferFrom;
        reenterOnTransfer = onTransfer;
        reenterPaymentIn = paymentIn_;
        reenterAmount = amount_;
        reenterAttempts = 0;
        reenterSucceeded = false;
        // The re-entrant swap is made BY this token, so the pool pulls from
        // this token's own balance and needs the allowance. Without this the
        // attack would fail for a boring reason and the test would prove
        // nothing about the guard.
        allowance[address(this)][pool_] = type(uint256).max;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _move(msg.sender, to, amount);
        if (reenterOnTransfer) _tryReenter();
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 a = allowance[from][msg.sender];
        if (a != type(uint256).max) {
            require(a >= amount, "allowance");
            allowance[from][msg.sender] = a - amount;
        }
        _move(from, to, amount);
        if (reenterOnTransferFrom) _tryReenter();
        return true;
    }

    function _move(address from, address to, uint256 amount) private {
        require(balanceOf[from] >= amount, "balance");
        uint256 burned = (amount * feeBps) / 10_000;
        uint256 net = amount - burned;
        balanceOf[from] -= amount;
        balanceOf[to] += net;
        if (burned > 0) totalSupply -= burned;
        emit Transfer(from, to, net);
    }

    /// @dev Failure is SWALLOWED so the outer transaction survives and the
    /// test can read `reenterSucceeded` rather than only observing a revert.
    /// `reenterSucceeded == false` after an attempt is the whole point.
    bool private _inReenter;

    function _tryReenter() private {
        address p = pool;
        if (p == address(0)) return;
        // ONE attempt per outer swap. Without this, a pool with the guard
        // REMOVED would recurse forever (the re-entrant swap's own pull fires
        // this hook again) and the test would fail with an out-of-gas rather
        // than the informative `reenterSucceeded == true`.
        if (_inReenter) return;
        _inReenter = true;
        reenterAttempts += 1;
        (seenReservePayment, seenReserveCoin) = IIndexCoinPoolSwap(p).getReserves();
        (bool ok, ) = p.call(
            abi.encodeWithSelector(
                IIndexCoinPoolSwap.swap.selector,
                reenterPaymentIn,
                reenterAmount,
                uint256(0),
                address(this)
            )
        );
        if (ok) reenterSucceeded = true;
        _inReenter = false;
    }
}
