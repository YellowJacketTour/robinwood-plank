// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ReentrancyGuard} from "@openzeppelin/contracts/security/ReentrancyGuard.sol";

/// Minimal surface the bank needs on a casino game (PlankCrashDrand).
interface IPlankGame {
    function placeBetFor(address player, uint256 autoCashOutBps) external payable;
    function cashOutFor(uint256 roundId, address player) external;
}

/**
 * PlankBank -- the "sign to get in, play instantly, sign to leave" buffer.
 *
 * A player DEPOSITS ETH once (one signature), then plays as many rounds as
 * they like with NO per-bet wallet popup: they authorize a local "session
 * key" (a throwaway keypair the frontend holds) with a spend cap and an
 * expiry, and that key drives placeBetFor / cashOutFor on the game FROM the
 * player's pre-funded bank balance. Losses simply leave the balance smaller;
 * winnings recycle straight back into the balance IF the player opted into
 * the game's payout redirect (game.setPayoutRedirect(bank)). To leave, the
 * player WITHDRAWS whatever is left (one signature).
 *
 * The bank holds NO privilege over the game beyond what any funder has: it
 * bets on a player's behalf and can only cash out bets it itself funded. It
 * has NO admin, NO upgrade path, and the set of games it will talk to is
 * fixed at construction. A session key is strictly LESS powerful than the
 * player -- it can only bet up to its cap, only until its expiry, only on
 * whitelisted games, and can NEVER withdraw. Withdrawal is the player's
 * root key alone.
 *
 * Security posture (from-scratch, adversarially reviewed alongside the rest
 * of the casino stack):
 *   - Checks-Effects-Interactions + nonReentrant on every ETH move.
 *   - A session key cannot exceed its owner's balance (debit reverts) nor
 *     its own cumulative spend cap.
 *   - creditFor (winnings recycling) is callable ONLY by a whitelisted game,
 *     so nobody can inflate a balance out of thin air.
 *   - No bare receive(): stray ETH cannot be silently mis-credited; only
 *     deposit() and a game's creditFor() move money in.
 */
contract PlankBank is ReentrancyGuard {
    struct Session {
        address player; // whose balance this key spends
        uint128 spendCap; // cumulative ETH this key may ever bet
        uint128 spent; // cumulative ETH it has bet so far
        uint64 expiry; // unix seconds; key is dead after this
        bool revoked; // owner killed it early
    }

    mapping(address => uint256) public balanceOf;
    mapping(address => bool) public isGame; // fixed at construction
    mapping(address => Session) public sessions; // keyed by session-key address

    event Deposited(address indexed player, uint256 amount, uint256 newBalance);
    event Withdrawn(address indexed player, uint256 amount, uint256 newBalance);
    event SessionGranted(address indexed player, address indexed key, uint256 spendCap, uint64 expiry);
    event SessionRevoked(address indexed player, address indexed key);
    event BetPlaced(address indexed player, address indexed game, address indexed by, uint256 amount);
    event CashedOut(address indexed player, address indexed game, address indexed by, uint256 roundId);
    event Credited(address indexed player, address indexed game, uint256 amount);

    error ZeroAddress();
    error NoGames();
    error NotAGame();
    error InsufficientBalance();
    error BadExpiry();
    error KeyInUse();
    error NotKeyOwner();
    error SessionInvalid();
    error SessionExpired();
    error CapExceeded();
    error NothingToWithdraw();

    constructor(address[] memory games) {
        if (games.length == 0) revert NoGames();
        for (uint256 i = 0; i < games.length; i++) {
            if (games[i] == address(0)) revert ZeroAddress();
            isGame[games[i]] = true;
        }
    }

    // ── Root-key actions (the player signs) ─────────────────────────────

    function deposit() external payable {
        balanceOf[msg.sender] += msg.value;
        emit Deposited(msg.sender, msg.value, balanceOf[msg.sender]);
    }

    function withdraw(uint256 amount) external nonReentrant {
        uint256 bal = balanceOf[msg.sender];
        if (amount == 0 || amount > bal) revert InsufficientBalance();
        balanceOf[msg.sender] = bal - amount;
        (bool ok, ) = msg.sender.call{value: amount}("");
        require(ok, "ETH send failed");
        emit Withdrawn(msg.sender, amount, balanceOf[msg.sender]);
    }

    function withdrawAll() external nonReentrant {
        uint256 amount = balanceOf[msg.sender];
        if (amount == 0) revert NothingToWithdraw();
        balanceOf[msg.sender] = 0;
        (bool ok, ) = msg.sender.call{value: amount}("");
        require(ok, "ETH send failed");
        emit Withdrawn(msg.sender, amount, 0);
    }

    /// Authorize a session key. Re-callable by the same owner to raise the
    /// cap or extend the expiry; a key currently owned by a DIFFERENT live
    /// owner cannot be re-pointed (revoke/expire first).
    function grantSession(address key, uint128 spendCap, uint64 expiry) external {
        if (key == address(0)) revert ZeroAddress();
        if (expiry <= block.timestamp) revert BadExpiry();
        Session storage s = sessions[key];
        if (s.player != address(0) && s.player != msg.sender && !_dead(s)) revert KeyInUse();
        s.player = msg.sender;
        s.spendCap = spendCap;
        s.expiry = expiry;
        s.revoked = false;
        // NOTE: `spent` intentionally NOT reset on re-grant, so a raised cap
        // is a true ceiling on lifetime spend, never a laundering reset.
        emit SessionGranted(msg.sender, key, spendCap, expiry);
    }

    function revokeSession(address key) external {
        Session storage s = sessions[key];
        if (s.player != msg.sender) revert NotKeyOwner();
        s.revoked = true;
        emit SessionRevoked(msg.sender, key);
    }

    // ── Play: root-key path (no session needed) ─────────────────────────

    /// `autoCashOutBps` is the crash game's hardening-(a) auto-cash-out
    /// target, committed WITH the bet (0 = manual play only). Passed
    /// straight through; the bank never chooses it.
    function bet(address game, uint256 amount, uint256 autoCashOutBps) external nonReentrant {
        _bet(msg.sender, game, amount, msg.sender, autoCashOutBps);
    }

    function cashOut(address game, uint256 roundId) external nonReentrant {
        _cashOut(msg.sender, game, roundId, msg.sender);
    }

    // ── Play: session-key path (instant, no wallet popup) ───────────────

    function betVia(address game, uint256 amount, uint256 autoCashOutBps) external nonReentrant {
        Session storage s = _liveSession(msg.sender);
        uint256 newSpent = uint256(s.spent) + amount;
        if (newSpent > s.spendCap) revert CapExceeded();
        s.spent = uint128(newSpent);
        _bet(s.player, game, amount, msg.sender, autoCashOutBps);
    }

    function cashOutVia(address game, uint256 roundId) external nonReentrant {
        Session storage s = _liveSession(msg.sender);
        _cashOut(s.player, game, roundId, msg.sender);
    }

    // ── Winnings recycling (only a whitelisted game can call) ───────────

    /// A game pushes `player`'s winnings back into their play buffer. Kept
    /// trivial and non-reverting so the game's claim() best-effort push
    /// always succeeds; guarded to games so no one can mint balance.
    function creditFor(address player) external payable {
        if (!isGame[msg.sender]) revert NotAGame();
        balanceOf[player] += msg.value;
        emit Credited(player, msg.sender, msg.value);
    }

    // ── Internals ───────────────────────────────────────────────────────

    function _bet(address player, address game, uint256 amount, address by, uint256 autoCashOutBps) private {
        if (!isGame[game]) revert NotAGame();
        uint256 bal = balanceOf[player];
        if (amount == 0 || amount > bal) revert InsufficientBalance();
        balanceOf[player] = bal - amount;
        IPlankGame(game).placeBetFor{value: amount}(player, autoCashOutBps);
        emit BetPlaced(player, game, by, amount);
    }

    function _cashOut(address player, address game, uint256 roundId, address by) private {
        if (!isGame[game]) revert NotAGame();
        IPlankGame(game).cashOutFor(roundId, player);
        emit CashedOut(player, game, by, roundId);
    }

    function _liveSession(address key) private view returns (Session storage s) {
        s = sessions[key];
        if (s.player == address(0)) revert SessionInvalid();
        if (s.revoked) revert SessionInvalid();
        if (block.timestamp > s.expiry) revert SessionExpired();
    }

    function _dead(Session storage s) private view returns (bool) {
        return s.revoked || block.timestamp > s.expiry;
    }
}
