// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;

/**
 * ============================================================================
 *  CanonicalWeth9 — the REAL WETH9, vendored, not a hand-rolled mock
 *
 *  This is a faithful port of the canonical `WETH9.sol` (the
 *  `gnosis/canonical-weth` contract, deployed at
 *  0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2 on Ethereum mainnet and the
 *  same source Uniswap's own test suites deploy locally). It is here so the
 *  auto-compound round trip is driven against REAL WETH semantics instead of
 *  a convenient mock that quietly differs from them.
 *
 *  WHY THIS MATTERS AND WHAT THE OLD MOCK GOT WRONG BY OMISSION
 *  -----------------------------------------------------------
 *  The mock it replaces (contracts/test/MockWrappedEth.sol, now deleted) was
 *  OpenZeppelin's ERC20 plus a `deposit`/`withdraw` pair and a `mint` cheat.
 *  Three real behaviours were therefore never exercised:
 *
 *   1. THE INFINITE-APPROVAL SPECIAL CASE. Real WETH9 does NOT decrement an
 *      allowance of `type(uint256).max` (the original source's
 *      `allowance[src][msg.sender] != uint(-1)` guard). OpenZeppelin's ERC20
 *      decrements every allowance unconditionally. Any integration that
 *      re-reads an allowance after a transferFrom sees a different number
 *      against the real contract than against the mock.
 *   2. `withdraw` PAYS WITH `transfer`, i.e. a 2300-gas stipend, not a
 *      gas-forwarding `.call`. A recipient contract whose `receive()` does
 *      more than trivial work simply cannot be paid by real WETH9. That is a
 *      constraint on the consumer's `receive()`, and a mock that uses `.call`
 *      hides it completely. IndexDividendDistributor's `receive()` is written
 *      to fit inside that stipend precisely because this contract enforces it.
 *   3. `receive()` FALLS THROUGH TO `deposit()`. Real WETH9 wraps any bare ETH
 *      send; the mock reverted on one.
 *
 *  There is no `mint`. There is no owner. There is no rescue. Every WETH in a
 *  test is backed by real ETH the test actually sent, exactly as on mainnet —
 *  which is itself the point: the invariant "WETH totalSupply == the ETH this
 *  contract holds" is structural here and was fictional in the mock.
 *
 *  DELIBERATE, MINIMAL MODERNISATION (and nothing else):
 *   - pragma 0.4.18 -> ^0.8.24. Checked arithmetic replaces the original's
 *     bare `+`/`-`; the original relied on explicit `require`s for the two
 *     cases that could underflow, and those `require`s are retained verbatim
 *     so the revert conditions are identical.
 *   - `function() public payable` -> `receive()` / `fallback()`.
 *     `uint(-1)` -> `type(uint256).max`.
 *   - `public` state variables and function visibility annotated for 0.8.
 *  No behaviour, no event, no name, and no ordering has been changed.
 *
 *  LOCAL HARDHAT ONLY. Nothing in this repo deploys this to any network: the
 *  production target is the REAL, already-verified WETH at
 *  0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73 (lib/constants.ts
 *  MARKET_OFFER_CURRENCY), which IndexDividendDistributor takes as an
 *  immutable constructor argument rather than hardcoding.
 * ============================================================================
 */
contract CanonicalWeth9 {
    string public name = "Wrapped Ether";
    string public symbol = "WETH";
    uint8 public decimals = 18;

    event Approval(address indexed src, address indexed guy, uint256 wad);
    event Transfer(address indexed src, address indexed dst, uint256 wad);
    event Deposit(address indexed dst, uint256 wad);
    event Withdrawal(address indexed src, uint256 wad);

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    receive() external payable {
        deposit();
    }

    fallback() external payable {
        deposit();
    }

    function deposit() public payable {
        balanceOf[msg.sender] += msg.value;
        emit Deposit(msg.sender, msg.value);
    }

    function withdraw(uint256 wad) public {
        require(balanceOf[msg.sender] >= wad);
        balanceOf[msg.sender] -= wad;
        // Real WETH9 pays with `transfer`, i.e. the 2300-gas stipend. Kept as
        // it is: a consumer that cannot be paid inside that budget cannot be
        // paid by the real contract either, and a test must find that out.
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
        require(balanceOf[src] >= wad);

        // THE INFINITE-APPROVAL SPECIAL CASE, verbatim from the original
        // (`allowance[src][msg.sender] != uint(-1)`). An allowance of
        // type(uint256).max is never decremented.
        if (src != msg.sender && allowance[src][msg.sender] != type(uint256).max) {
            require(allowance[src][msg.sender] >= wad);
            allowance[src][msg.sender] -= wad;
        }

        balanceOf[src] -= wad;
        balanceOf[dst] += wad;

        emit Transfer(src, dst, wad);

        return true;
    }
}
