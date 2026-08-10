// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/security/ReentrancyGuard.sol";

import {IEnergyBus} from "./IEnergyBus.sol";
import {IEnergyAdapter} from "./IEnergyAdapter.sol";

/**
 * ============================================================================
 *  EnergyBus — PR2 of the AXIOM-1 stack (ONESHOT §7, SPEC §2.1).
 *
 *  Immutable WETH splitter into 6 pipes, called in fixed order I -> L -> X ->
 *  P -> R -> D. Genesis bps are LOCKED (ONESHOT §4.1) and validated to sum to
 *  exactly 10_000 at construction. No admin function anywhere ever moves
 *  WETH out of the Bus except through the adapter pipes themselves — there is
 *  no owner-withdraw, no adapter-swap, no bps-change function. `finalize()`
 *  exists only to flip a boolean and zero the deployer reference for
 *  transparency/monitoring; it grants no privilege before or after.
 *
 *  Security invariants enforced here (ONESHOT §6):
 *   - route() is permissionless                                       (§6.8)
 *   - credits only observed IERC20.balanceOf deltas, never self-report (§6.2)
 *   - adapter skip/impact routes the remainder to Pipe D only          (§6.7)
 *   - CEI + nonReentrant on route()/sync()                             (§6.9)
 *   - CALL only to adapters, never DELEGATECALL                        (§6.6)
 *   - TRUSTED_CAP_BPS = 0 — no spendable team treasury inside the Bus  (§0,§6)
 * ============================================================================
 */
contract EnergyBus is IEnergyBus, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant BPS_DENOM = 10_000;

    // ---- LOCKED genesis safety constants (ONESHOT §4.2 — do not deviate) ----
    uint256 public constant MAX_IMPACT_BPS = 300;
    uint256 public constant MAX_ROUTE_WEI = 10 ether;
    uint256 public constant MIN_ROUTE_WEI = 0.001 ether;

    /// @notice No spendable team treasury inside the Bus, ever.
    uint256 public constant TRUSTED_CAP_BPS = 0;

    IERC20 public immutable weth;

    IEnergyAdapter public immutable invAdapter; // Pipe I
    IEnergyAdapter public immutable clpAdapter; // Pipe L
    IEnergyAdapter public immutable idxBurnAdapter; // Pipe X
    IEnergyAdapter public immutable plankBurnAdapter; // Pipe P
    IEnergyAdapter public immutable plankLpAdapter; // Pipe R
    IEnergyAdapter public immutable divAdapter; // Pipe D

    uint16 public immutable invBps;
    uint16 public immutable clpBps;
    uint16 public immutable idxBurnBps;
    uint16 public immutable plankBurnBps;
    uint16 public immutable plankLpBps;
    uint16 public immutable divBps;

    address public deployer;
    bool public finalized;

    /// @dev Constructor packs adapters and bps into fixed-size arrays
    /// (order: I, L, X, P, R, D) purely to keep the stack shallow enough for
    /// the optimizer — semantics are identical to six named params each.
    constructor(address weth_, address[6] memory adapters_, uint16[6] memory bps_) {
        if (weth_ == address(0)) revert ZeroAddress();

        uint256 sum;
        for (uint256 i = 0; i < 6; i++) {
            if (adapters_[i] == address(0)) revert ZeroAddress();
            sum += bps_[i];
        }
        if (sum != BPS_DENOM) revert BpsSumInvalid();

        weth = IERC20(weth_);

        invAdapter = IEnergyAdapter(adapters_[0]);
        clpAdapter = IEnergyAdapter(adapters_[1]);
        idxBurnAdapter = IEnergyAdapter(adapters_[2]);
        plankBurnAdapter = IEnergyAdapter(adapters_[3]);
        plankLpAdapter = IEnergyAdapter(adapters_[4]);
        divAdapter = IEnergyAdapter(adapters_[5]);

        invBps = bps_[0];
        clpBps = bps_[1];
        idxBurnBps = bps_[2];
        plankBurnBps = bps_[3];
        plankLpBps = bps_[4];
        divBps = bps_[5];

        deployer = msg.sender;
    }

    function paymentToken() external view returns (address) {
        return address(weth);
    }

    // -------------------------------------------------------------------
    // route() — permissionless, CEI, nonReentrant.
    // -------------------------------------------------------------------

    function route() external nonReentrant returns (uint256 spent) {
        uint256 bal = weth.balanceOf(address(this));
        uint256 total = bal > MAX_ROUTE_WEI ? MAX_ROUTE_WEI : bal;
        if (total < MIN_ROUTE_WEI) {
            return 0;
        }

        // Effects: nothing to update in storage before external calls — the
        // Bus is a pure balance model, so "effects" here is simply computing
        // the split amounts before any external interaction.
        uint256 inv = (total * invBps) / BPS_DENOM;
        uint256 clp = (total * clpBps) / BPS_DENOM;
        uint256 idxBurn = (total * idxBurnBps) / BPS_DENOM;
        uint256 plankBurn = (total * plankBurnBps) / BPS_DENOM;
        uint256 plankLp = (total * plankLpBps) / BPS_DENOM;
        // Last pipe (D) absorbs the rounding remainder so no dust is ever
        // trapped in the Bus (SPEC §2.1: "last pipe gets remainder").
        uint256 div = total - inv - clp - idxBurn - plankBurn - plankLp;

        // Interactions: fixed pipe order I -> L -> X -> P -> R -> D. Any
        // pipe that skips (impact too high / adapter failure) has its slice
        // added to `div` and routed to the DividendAdapter at the end —
        // never to msg.sender, never to any admin-controlled address.
        uint256 divExtra;

        divExtra += _runPipe(0, invAdapter, inv);
        divExtra += _runPipe(1, clpAdapter, clp);
        divExtra += _runPipe(2, idxBurnAdapter, idxBurn);
        divExtra += _runPipe(3, plankBurnAdapter, plankBurn);
        divExtra += _runPipe(4, plankLpAdapter, plankLp);

        div += divExtra;
        _runPipe(5, divAdapter, div);

        emit Routed(msg.sender, total, inv, clp, idxBurn, plankBurn, plankLp, div);
        return total;
    }

    /// @dev Transfers `amount` WETH to `adapter` via plain CALL (never
    /// delegatecall), invokes `execute`, and reconciles by OBSERVED balance
    /// delta only — never trusting the adapter's self-reported `used`. Any
    /// WETH not consumed (either because the adapter returned it, or
    /// because it never spent what it received) flows back to Pipe D via the
    /// return value, which the caller adds into `div`.
    function _runPipe(uint8 pipeId, IEnergyAdapter adapter, uint256 amount) internal returns (uint256 toDiv) {
        if (amount == 0) return 0;

        uint256 beforeBal = weth.balanceOf(address(this));
        weth.safeTransfer(address(adapter), amount);

        bool skipped;
        try adapter.execute(amount) returns (uint256 usedReported, bool skipped_) {
            skipped = skipped_;
            usedReported; // silence unused-var warning; never trusted, see below
        } catch {
            skipped = true;
        }

        uint256 afterBal = weth.balanceOf(address(this));
        // Observed delta: how much of `amount` actually left the Bus and
        // never came back (i.e. was genuinely spent by the adapter).
        //
        // AUDIT C-1: this subtraction MUST be underflow-guarded before the
        // clamp, not inside a ternary condition. `a - b <= amount ? a - b : amount`
        // evaluates `a - b` first, so a well-funded adapter returning MORE
        // than it was sent (e.g. one that refunds its entire balance after
        // someone donated WETH straight to it) panics here — outside the
        // try/catch above, which wraps only `adapter.execute()`. The whole
        // of `route()` then reverts, and because it reverts the donation is
        // never consumed, so it reverts FOREVER on an immutable contract.
        // The adapters are additionally capped to never return more than
        // they received; this guard is the defence-in-depth half, because
        // adapters are external code and this contract cannot be upgraded.
        uint256 leftBus;
        if (afterBal < beforeBal) {
            unchecked {
                leftBus = beforeBal - afterBal;
            }
            if (leftBus > amount) leftBus = amount;
        }
        uint256 unspent = amount - leftBus;

        if (unspent > 0) {
            toDiv += unspent;
        }
        if (skipped && leftBus > 0) {
            // Adapter kept/spent something while claiming skip — that should
            // not happen for a well-behaved adapter (it must return the
            // entire amountIn on skip), but if it does, we do not double
            // count: `unspent` already captured whatever came back to us.
            // Nothing further to route; `leftBus` already left this
            // contract and is not this contract's WETH to redirect.
        }
        if (skipped) {
            emit AdapterSkipped(pipeId, unspent);
        }
    }

    // -------------------------------------------------------------------
    // sync() — pure balance model; nothing to reconcile, kept for interface
    // parity / future extension per SPEC §2.1.
    // -------------------------------------------------------------------

    function sync() external nonReentrant returns (uint256 surplus) {
        return weth.balanceOf(address(this));
    }

    // -------------------------------------------------------------------
    // finalize() — one-way, zero admin privilege before or after.
    // -------------------------------------------------------------------

    function finalize() external {
        if (finalized) revert AlreadyFinalized();
        if (msg.sender != deployer) revert NotFinalizable();
        finalized = true;
        deployer = address(0);
        emit PipeFinalized();
    }
}
