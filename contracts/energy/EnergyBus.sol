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

    /// @notice AUDIT H-5 — THE CUMULATIVE RATE LIMIT.
    ///
    /// THE BUG THIS CLOSES. `MAX_ROUTE_WEI` alone is a per-CALL cap, and
    /// `route()` is permissionless and unlimited in frequency. A per-call cap
    /// on an unlimited-frequency function is not a limit — it is a STEP SIZE.
    /// An attacker opens a sandwich, calls `route()` in a loop inside one
    /// transaction until the Bus's entire accumulated balance is drawn down at
    /// the manipulated price, then closes. The repo's own BUS-4 test already
    /// demonstrated that looping drains an arbitrarily large balance; it
    /// framed that as safe drainage, which it is not under a sandwich.
    ///
    /// This is not theoretical. Two real incidents defeated per-call throttles
    /// by exactly this arithmetic:
    ///   - Balancer, Nov 2025, $128.64M — 65 individually sub-threshold
    ///     operations compounded inside a SINGLE `batchSwap()`.
    ///   - Wise Lending — the attacker sized the donation just under the
    ///     per-call throttle and repeated.
    ///
    /// THE FIX. All `route()` calls draw from one shared per-block budget.
    /// Looping inside a transaction, or across many transactions inside one
    /// block, cannot exceed `BLOCK_BUDGET_WEI` in aggregate. Since a sandwich
    /// must open and close around the victim flow, and holding a manipulated
    /// pool across a block boundary exposes the attacker to every arbitrageur
    /// on the network, "per block" is the correct granularity for this threat.
    ///
    /// WHY THIS VALUE, AND THE TRADE-OFF, STATED HONESTLY. The Bus is
    /// immutable, has no admin, and sits behind a `diamondCut` renounced at
    /// birth — there is no lever to retune this later, ever. So the value is
    /// pinned to `MAX_ROUTE_WEI` deliberately, which makes the plain-language
    /// claim exactly true for the first time: *at most one maximum-size route
    /// per block*. Nothing new is starved relative to the intended operating
    /// mode (a keeper routing once per block), while the single-block
    /// extractable notional falls from "the Bus's entire balance" to 10 WETH.
    ///
    ///   Too tight would starve legitimate compounding and let fees pile up
    ///   unrouted. At ~12s blocks this budget is ~72,000 WETH/day of routing
    ///   capacity — orders of magnitude above any plausible marketplace-fee
    ///   accrual rate, so the starvation arm of the trade-off is not close.
    ///   Too loose would leave the sandwich surface open; 10 WETH is the same
    ///   figure already reviewed as the maximum single-call exposure, now
    ///   actually enforced per block instead of per call.
    ///
    /// AND WHAT IT DOES NOT DO — see `MAX_LEG_POOL_FRACTION_BPS` in
    /// `InventoryBuyAdapter`/`CollectionLpAdapter` and the note on
    /// `_blockBudgetRemaining()` below. This bounds cumulative notional per
    /// block. It does not bound extraction ACROSS blocks, and it is not a
    /// slippage guard. Overclaiming a guard's strength is what finding C-2
    /// was; this comment is written to not repeat it.
    uint256 public constant BLOCK_BUDGET_WEI = MAX_ROUTE_WEI;

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

    /// @dev AUDIT H-5 rate-limit state, packed into ONE storage slot so the
    /// limit costs a single warm SSTORE per route rather than two.
    /// `budgetBlock` is the block number the tally belongs to; when
    /// `block.number` moves past it the tally is treated as 0 without needing
    /// to be cleared. uint64 block numbers do not wrap in any reachable
    /// future, and uint192 wei dwarfs the total supply of ether.
    uint64 private budgetBlock;
    uint192 private budgetUsed;

    /// @notice AUDIT H-5. Emitted when a `route()` is trimmed or fully
    /// no-opped by the per-block budget rather than by balance. Monitoring
    /// signal only — this is a normal, safe condition (unrouted WETH sits at
    /// the Bus and every exit path is unaffected; see audit ADV-7).
    event RouteBudgetLimited(address indexed caller, uint256 requested, uint256 granted);

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
        uint256 requested = bal > MAX_ROUTE_WEI ? MAX_ROUTE_WEI : bal;

        // AUDIT H-5: draw down the shared per-block budget. `remaining` is 0
        // once this block's budget is spent, no matter how many times or by
        // how many callers `route()` has been invoked in this block, and no
        // matter whether those calls came from separate transactions or from
        // a loop inside one.
        uint256 remaining = _blockBudgetRemaining();
        uint256 total = requested > remaining ? remaining : requested;

        if (total < MIN_ROUTE_WEI) {
            // Deliberately a NO-OP RETURN, never a revert.
            //
            // GRIEFING ANALYSIS (the reason this branch is not `revert
            // RouteBudgetExhausted()`): if budget exhaustion reverted, then
            // any present or future contract that opportunistically calls
            // `route()` inside a user action would have that user's entire
            // transaction reverted by a stranger who front-ran them and burned
            // the block's budget. That would convert a rate limit into a
            // cheap, general denial-of-service amplifier against unrelated
            // users. Returning 0 keeps exhaustion a local no-op, exactly as
            // an under-MIN balance already was (BUS-1).
            if (requested > 0) {
                emit RouteBudgetLimited(msg.sender, requested, 0);
            }
            return 0;
        }
        if (total < requested) {
            emit RouteBudgetLimited(msg.sender, requested, total);
        }

        // Effects: commit the budget draw BEFORE any external call (CEI). The
        // adapters are external code and `route()` is reentrancy-guarded, but
        // committing first means even a guard bypass could not spend the same
        // budget twice.
        budgetBlock = uint64(block.number);
        budgetUsed = uint192(BLOCK_BUDGET_WEI - remaining + total);

        // The remaining "effects" are simply computing the split amounts
        // before any external interaction — the Bus is a pure balance model.
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

    /// @notice AUDIT H-5. WETH still routable in the current block.
    ///
    /// HOW THIS INTERACTS WITH `MAX_LEG_POOL_FRACTION_BPS = 200`, STATED
    /// WITHOUT OVERCLAIM. The 2% leg cap is read from the target pool's LIVE
    /// payment reserve, which is the property that makes it ungameable within
    /// a call. But a buy INCREASES that reserve, so under the H-5 loop the cap
    /// re-reads a reserve our own previous leg just grew: `b_i = 0.02·x_i` and
    /// `x_{i+1} ≈ 1.02·x_i`, so `n` looped legs spend about `x·(1.02ⁿ − 1)` —
    /// which passes the pool's whole depth at n≈35 and keeps compounding. The
    /// per-leg size cap therefore does NOT compose into a cumulative bound
    /// under looping; it degrades geometrically. So this budget is NOT merely
    /// defence-in-depth on top of the 2% cap: it supplies the cumulative bound
    /// the 2% cap structurally cannot, and the 2% cap in turn supplies the
    /// per-trade impact bound this budget structurally cannot. They are
    /// orthogonal, and each is load-bearing where the other is not.
    ///
    /// What the pair bounds, honestly: cumulative routed notional per block
    /// (10 WETH), and per-leg impact (~2% of live depth), so single-block
    /// sandwich extraction lands on the order of a couple of percent of 10
    /// WETH rather than a couple of percent of the Bus's whole balance. That
    /// is an order-of-magnitude statement about a constant-product pool, not a
    /// theorem, and it says nothing about extraction spread ACROSS blocks —
    /// which is bounded instead by the attacker's cost of holding a
    /// manipulated pool through a block boundary against every arbitrageur on
    /// the network, an economic bound and not an arithmetic one.
    /// KEEPER NOTE, because a surprising simulation result is how operators
    /// conclude a contract is broken: `eth_call` executes against the LATEST
    /// block, so simulating `route()` (or reading this) in the same block a
    /// route already landed in truthfully reports that block's DEPLETED
    /// budget, and `route.staticCall()` will return 0. That is correct, not a
    /// fault — the real transaction lands in a later block with a refilled
    /// budget. Simulate one block ahead, or simply retry.
    function blockBudgetRemaining() external view returns (uint256) {
        return _blockBudgetRemaining();
    }

    function _blockBudgetRemaining() internal view returns (uint256) {
        // A tally stamped with an older block number is stale and reads as
        // zero-used, so the budget refills every block with no clearing write.
        if (budgetBlock != uint64(block.number)) return BLOCK_BUDGET_WEI;
        uint256 used = budgetUsed;
        if (used >= BLOCK_BUDGET_WEI) return 0;
        return BLOCK_BUDGET_WEI - used;
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
