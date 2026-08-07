// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {IndexFacetBase} from "./IndexFacetBase.sol";
import {Constituent} from "../../lib/IndexTypes.sol";
import {CoreStorage, StreamStorage} from "../storage/IndexStorage.sol";

/**
 * ============================================================================
 *  IndexCoreFacet — THE EXIT DOOR.
 *
 *  NOT FOR DEPLOYMENT except as a facet.
 *
 *  READ THIS FILE FIRST. It is deliberately the smallest facet with real
 *  authority, and design doc section 2.1 makes that a rule rather than a habit:
 *
 *    - it imports NO governance storage namespace;
 *    - it carries NO role modifier on any function, and cannot, because it does
 *      not read `RolesStorage` at all on its own paths;
 *    - it consults NO hook, at any point, on any path. `HookRegistryFacet`'s
 *      enumerated hook-point set contains no point on `redeemProRata`,
 *      `claimPending` or `claimPendingMany`, and that is a compile-time
 *      constant rather than a configuration;
 *    - it reads no price. `redeemProRata` works with every constituent stale.
 *
 *  A reviewer can therefore confirm the anchor rule — *no privileged function
 *  can reach reserves already pooled, and nothing can block a redemption* — by
 *  reading one short file, which is the whole reason the split was worth making.
 *
 *  WHY THE ANCHOR RULE STILL HOLDS UNDER A DIAMOND (design doc section 6.1)
 *  -----------------------------------------------------------------------
 *  Under the monolith the proof was ABI ENUMERATION: list every privileged
 *  function, call each from each role, observe no reserve moves. That technique
 *  is sound for fixed code and WORTHLESS for a live diamond, because a cut can
 *  install a facet the enumeration never saw.
 *
 *  It is restored — and strengthened — by finalization: the diamond is cut and
 *  frozen inside `IndexDeployer`'s constructor and is never observable in a
 *  cuttable state, so the finalized selector set IS the whole surface, forever.
 *  The enumeration argument then applies to the union of the facet ABIs exactly
 *  as it applied to the monolith's, and `Diamond.finalize.test.ts` supplies the
 *  missing premise by proving the set cannot change.
 * ============================================================================
 */
contract IndexCoreFacet is IndexFacetBase {
    using SafeERC20 for IERC20;

    // ── Deferred-claim ledger views ────────────────────────────────────────

    function pendingClaim(address holder, address token) external view returns (uint256) {
        return CoreStorage.layout().pendingClaim[holder][token];
    }

    function reservedClaims(address token) external view returns (uint256) {
        return CoreStorage.layout().reservedClaims[token];
    }

    // ══ Mint ══════════════════════════════════════════════════════════════

    /**
     * @notice Mint `sharesOut` by depositing a pro-rata slice of EVERY
     * constituent. No valuation step, no oracle read, nothing to sandwich.
     * @dev Every required amount CEILS. The vault over-collects by at most one
     * base unit per constituent and that unit stays with the vault.
     */
    function mintProRata(uint256 sharesOut, uint256[] calldata maxAmountsIn)
        external
        nonReentrant
        whenOpen
        returns (uint256[] memory amountsIn)
    {
        if (sharesOut == 0) revert ZeroAmount();
        CoreStorage.Layout storage cs = CoreStorage.layout();
        uint256 n = cs.constituentList.length;
        if (maxAmountsIn.length != n) revert BadBatch();

        uint256 supplyBefore = _totalSupply();
        uint256 denom = supplyBefore + VIRTUAL_SHARES;
        amountsIn = new uint256[](n);
        for (uint256 i = 0; i < n; i++) {
            address t = cs.constituentList[i];
            Constituent storage c = cs.constituents[t];
            uint256 want = Math.mulDiv(sharesOut, c.reserve + VIRTUAL_ASSETS, denom, Math.Rounding.Up);
            if (want == 0) revert ZeroAmount();
            if (want > maxAmountsIn[i]) revert SlippageExceeded();
            uint256 credited = _pullCredited(IERC20(t), msg.sender, want);
            // Refuse a SHORT delivery outright: this path mints a fixed
            // `sharesOut`, so absorbing a transfer fee would mint full shares
            // against a partial deposit and dilute every existing holder.
            if (credited < want) revert ShortDelivery();
            amountsIn[i] = credited; // the depositor's real cost, UNAFFECTED by §7.11 below
            // §7.11: a small, governed slice of THIS leg's payment may route
            // to a PLANK buy for the dev-fund treasury before the remainder
            // backs the newly-minted shares — see `_routeDevFundBuy`'s
            // header for why this can never revert or shrink what the
            // depositor is credited with minting.
            c.reserve += _routeDevFundBuy(t, credited);
        }

        _mintWithAllocation(msg.sender, sharesOut);

        // Adversarial-review fix (2026-08-06): opportunistically reconcile
        // EVERY constituent this mint just touched (design doc §7.2 — "every
        // normal interaction with that constituent... opportunistically
        // reconciles any surplus"). Runs in its OWN pass, AFTER the pro-rata
        // loop above has finished pulling every deposit and crediting every
        // reserve, never interleaved with it — so none of the pricing math
        // above (`want`, `denom`, `sharesOut`) can ever observe a
        // reconcile-induced mutation mid-computation. Each call is
        // independently non-blocking (see `_attemptOpportunisticReconcile`'s
        // header) so a failure on one constituent can never stop the others
        // or this mint from completing. NOTE: `_deployToIndexPoolCore` itself
        // gates every attempt on `_requirePoolQuiescent()`, so at most the
        // first constituent in this loop whose deploy actually reaches the
        // pool this block succeeds — any later attempt in the SAME loop
        // fails closed exactly like any other real auto-deploy failure mode
        // (caught, non-blocking, `AutoDeployToIndexPoolFailed`), never a
        // special case.
        for (uint256 i = 0; i < n; i++) {
            _attemptOpportunisticReconcile(cs.constituentList[i]);
        }

        // Round 9f, ported verbatim from WrappedIndexShare (design doc §5.4).
        // Runs LAST: the mint is already priced and already done, so nothing
        // here can influence it. Offsets the stream-leg dilution this mint
        // just imposed by displacing that backing out of the redeemable pool
        // and re-vesting it linearly, which is what makes an atomic
        // mint->redeem round trip capture ~nothing of stream backing.
        // (Supply is never zero here in practice: `whenOpen` requires
        // `openIndex` to have already minted the permanently-locked seed
        // shares — see IndexBootstrapFacet.openIndex, the actual 0->nonzero
        // transition point, which is where `_armCarry` is called.)
        _revestOnMint(sharesOut, supplyBefore);

        emit MintedProRata(msg.sender, sharesOut);
    }

    // ══ Redeem ════════════════════════════════════════════════════════════

    /**
     * @notice STRICT PRO-RATA IN-KIND REDEMPTION. Burn `sharesIn`, receive
     * `floor(sharesIn * reserve_k / (totalSupply + VIRTUAL_SHARES))` of every
     * constituent k — the identical expression for every k, in one
     * transaction, with no valuation step anywhere in the path.
     *
     * ASYMMETRIC VIRTUAL-ASSET OFFSET: the MINT side charges against
     * `reserve_k + VIRTUAL_ASSETS` while the REDEEM side pays against
     * `reserve_k` alone. Carrying the offset through to the payout is the
     * intuitive symmetric choice and it is WRONG — it lets a redemption pay
     * marginally MORE than a strict pro-rata slice of the real reserve, which
     * is a per-share-backing leak of exactly the shape the Balancer V2
     * composable-stable incident was.
     *
     * PHASE 1 sizes and debits every leg against PRE-PAYOUT reserves with no
     * external call anywhere in the loop, so no leg's outcome can move another
     * leg's number. PHASE 2 pays; a leg that fails is DEFERRED, never fatal.
     */
    function redeemProRata(uint256 sharesIn, uint256[] calldata minAmountsOut)
        external
        nonReentrant
        whenOpen
        returns (uint256[] memory amountsOut)
    {
        if (sharesIn == 0) revert ZeroAmount();
        CoreStorage.Layout storage cs = CoreStorage.layout();
        uint256 n = cs.constituentList.length;
        if (minAmountsOut.length != n) revert BadBatch();

        // Never blocks: this only ever ADDS carried stream value back into the
        // pool this exit is about to be priced against. Must run BEFORE the
        // denominator and stream amounts are sized, exactly as
        // WrappedIndexShare's `withdraw` folded carry before pricing.
        _foldCarry();

        uint256 denom = _totalSupply() + VIRTUAL_SHARES;
        _burnShares(msg.sender, sharesIn); // burn first: no reentrancy on a stale supply

        amountsOut = new uint256[](n);
        for (uint256 i = 0; i < n; i++) {
            address t = cs.constituentList[i];
            Constituent storage c = cs.constituents[t];
            // §7.6: sized against reserve NET of whatever `_creditRoutedValue`
            // has freshly displaced into `ReserveVestStorage` for this token
            // (see `IndexFacetBase._reserveNetOfVest`'s header) — the
            // generalized round-9f guard, enforced at the SAME free exit door
            // the stream legs below are already vesting-gated at.
            // `c.reserve` itself is never rewritten by the netting; only the
            // amount actually PAID out shrinks.
            uint256 net = _reserveNetOfVest(t, c.reserve);
            uint256 out = Math.mulDiv(sharesIn, net, denom);
            if (out > c.reserve) out = c.reserve; // unreachable given the locked seed; belt and braces
            if (out < minAmountsOut[i]) revert SlippageExceeded();
            c.reserve -= out;
            amountsOut[i] = out;
        }

        // Stream legs, sized from the SAME pre-burn denominator, credited
        // DIRECTLY to the deferred-claim ledger with NO external call at all
        // (design doc §5.5). This is what keeps the exit door's external-call
        // count independent of the stream count: still exactly `n` calls
        // below, plus O(1) SSTOREs per stream with no failure mode to defer
        // from in the first place.
        StreamStorage.Layout storage ss = StreamStorage.layout();
        uint256 sn = ss.streamList.length;
        for (uint256 i = 0; i < sn; i++) {
            address t = ss.streamList[i];
            uint256 amt = Math.mulDiv(sharesIn, _probeStreamBalance(t), denom);
            if (amt == 0) continue;
            cs.pendingClaim[msg.sender][t] += amt;
            cs.reservedClaims[t] += amt;
            emit PayoutDeferred(msg.sender, t, amt);
        }

        for (uint256 i = 0; i < n; i++) {
            _payOrDefer(cs.constituentList[i], msg.sender, amountsOut[i]);
        }

        // Adversarial-review fix (2026-08-06): opportunistically reconcile
        // EVERY constituent this redeem just touched (design doc §7.2). Runs
        // strictly AFTER every payout above has already left this contract —
        // reconciling against `c.reserve` before the matching outgoing
        // transfer would misattribute the amount about to be paid out as a
        // freshly-observed surplus and re-credit it, a real double-count.
        // Each call is independently non-blocking, so a failure on one
        // constituent can never stop the others or this redemption. NOTE:
        // `_deployToIndexPoolCore` itself gates every attempt on
        // `_requirePoolQuiescent()`, so at most the first constituent in
        // this loop whose deploy actually reaches the pool this block
        // succeeds — see the identical note in `IndexCoreFacet.mintProRata`.
        for (uint256 i = 0; i < n; i++) {
            _attemptOpportunisticReconcile(cs.constituentList[i]);
        }

        emit RedeemedProRata(msg.sender, sharesIn);
    }

    /**
     * @notice Retry ONE deferred leg, at full gas and loudly.
     *
     * NOT gated on `whenOpen`, on the constituent still being listed, or on any
     * role. A credit is a debt this contract already owes to one named address,
     * and nothing in this diamond's governance can stand between them and it.
     */
    function claimPending(address token) external nonReentrant returns (uint256 amount) {
        CoreStorage.Layout storage cs = CoreStorage.layout();
        amount = cs.pendingClaim[msg.sender][token];
        if (amount == 0) revert ZeroAmount();
        cs.pendingClaim[msg.sender][token] = 0;
        cs.reservedClaims[token] -= amount;
        IERC20(token).safeTransfer(msg.sender, amount);
        emit PendingClaimed(msg.sender, token, amount);
    }

    /**
     * @notice Batch-retry several deferred legs. Tolerant, unlike
     * `claimPending`: a leg that still fails is re-credited by `_payOrDefer`
     * and ends exactly where it started, and the others still pay.
     */
    function claimPendingMany(address[] calldata tokens)
        external
        nonReentrant
        returns (uint256 settled)
    {
        CoreStorage.Layout storage cs = CoreStorage.layout();
        for (uint256 i = 0; i < tokens.length; i++) {
            address t = tokens[i];
            uint256 amount = cs.pendingClaim[msg.sender][t];
            if (amount == 0) continue;
            cs.pendingClaim[msg.sender][t] = 0;
            cs.reservedClaims[t] -= amount;
            if (_payOrDefer(t, msg.sender, amount)) {
                settled++;
                emit PendingClaimed(msg.sender, t, amount);
            }
        }
    }

    // ══ ERC-7540 read-only vocabulary (design doc section 5.6) ════════════
    //
    // A DOCUMENTED PARTIAL CONFORMANCE, and the word "partial" is doing real
    // work. This diamond has a genuine Pending -> Claimable -> Claimed ledger
    // that nobody designed as one: `pendingClaim` / `claimPending*`. Exposing
    // it under 7540's names lets 7540-aware tooling see deferred legs.
    //
    // WHAT IS DELIBERATELY ABSENT, AND WHY: there is NO `requestRedeem`, no
    // `pendingRedeemRequest` that is ever non-zero, no fulfiller, and
    // `supportsInterface(0x620ee8e4)` is NOT advertised. ERC-7540's defining
    // mechanic is escrow-now-settle-later, i.e. a state in which a user's
    // assets are unwithdrawable — the exact shape this repo has refused in
    // every prior round. Claiming the interface id for a half-implementation is
    // standards theatre that makes an auditor trust the wrong thing.

    /// @notice Always zero. Nothing here is ever pending: a credit is
    /// claimable the instant it exists, in the same block, in the same
    /// transaction if the caller wants.
    function pendingRedeemRequest(uint256, address) external pure returns (uint256) {
        return 0;
    }

    /// @notice The deferred credit owed to `controller`, in `dividendAsset`
    /// units. Overload-free by design: 7540's signature carries no token, so
    /// this reports the one asset a 7540 integrator would ask about; the full
    /// per-token ledger is `pendingClaim(holder, token)`.
    function claimableRedeemRequest(uint256, address controller) external view returns (uint256) {
        CoreStorage.Layout storage cs = CoreStorage.layout();
        return cs.pendingClaim[controller][cs.dividendAsset];
    }
}
