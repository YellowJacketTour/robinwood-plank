// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {IndexFacetBase} from "./IndexFacetBase.sol";
import {CoreStorage, StreamStorage} from "../storage/IndexStorage.sol";

/**
 * ============================================================================
 *  IndexStreamFacet — arbitrary reward streams for the unified index share.
 *
 *  NOT FOR DEPLOYMENT except as a facet.
 *
 *  THIS IS STAGE 5 OF THE DIAMOND MIGRATION (design doc §9). It dissolves
 *  `WrappedIndexShare.sol` — the standalone wIDX wrapper token — into a facet
 *  of the same diamond the share already lives on. There is no second token,
 *  no exchange rate, no wrap/unwrap step: reward streams back the index share
 *  directly, exactly as they backed wIDX, and the same anti-extraction math
 *  applies to the same backing pool.
 *
 *  WHAT MOVED AND WHAT DID NOT (design doc §5.4, §5.5, §7.5)
 *  -----------------------------------------------------------
 *  MOVED VERBATIM, because the math is proven and the mandate is to preserve
 *  it exactly:
 *    - the round-9f re-vest (`_revestOnMint` / `_addVest` / `unvestedOf`,
 *      `M = DILUTION_REVEST_MULTIPLE = 25`, `STREAM_VEST_BLOCKS = 300`) — now
 *      fires from `IndexCoreFacet.mintProRata` and `IndexTradeFacet.mintSingleAsset`
 *      instead of from a standalone `deposit`, because those are the only two
 *      paths that grow `totalSupply` under the unified token;
 *    - the round-9e zero-denominator carry (`_accrueCarry` / `_foldCarry` /
 *      `_armCarry`) — a stream pushed while `totalSupply() == 0` is held aside
 *      rather than captured by the next minter in the same transaction;
 *    - `_netOf`'s three-term subtraction (`reserved + carry + unvestedOf`),
 *      renamed `_netOfStream` here only to avoid a name clash with
 *      `IndexCoreFacet`'s constituent-side accounting — the expression itself
 *      is unchanged;
 *    - per-stream isolation: every read goes through the bounded-gas
 *      `_probeStreamBalance` (STATICCALL, failure reads as zero), so a
 *      hostile stream can brick neither pricing nor a mint nor a redemption;
 *    - `MAX_STREAMS = 32`, the finite, disclosed cap;
 *    - the admission model: `ROLE_STREAM_LISTER` can only queue (timelocked)
 *      and delist a stream. It cannot touch backing, cannot move a token this
 *      contract already holds, and cannot reach `depositStream`, `redeemProRata`,
 *      `claimPending` or `claimPendingMany`. Delisting NEVER claws back held
 *      backing — see `delistStream`.
 *
 *  GENUINELY CHANGED (an improvement, not a compromise — design doc §5.5):
 *    - There is no `withdraw` on this facet and no `harvest`. Redemption pays
 *      constituents AND stream legs from ONE function, `IndexCoreFacet.redeemProRata`.
 *      Stream legs are credited DIRECTLY to `pendingClaim` / `reservedClaims`
 *      — the SAME deferred-claim ledger constituent legs already use — with
 *      **no external call at all** on the exit path. That makes the exit
 *      door's external-call count independent of the stream count: still
 *      exactly `n_constituents` calls, plus O(1) SSTOREs per stream, with no
 *      failure mode to defer from in the first place.
 *    - There is no `harvest()` here because there is no second "vault" this
 *      facet is a holder of: the dividend leg already lives on the same
 *      diamond, in `DividendStorage`, and needs no pull.
 *    - `exchangeRate`, `previewWithdraw` and `quoteDividendAssetIn` are
 *      retired as a SURFACE (there is no second token to quote a rate
 *      between) but not as a MECHANISM: `streamHeld`/`streams` still expose
 *      every stream's live backing for discovery, and a burn still prices
 *      pro-rata against net backing at redemption time, inside `IndexCoreFacet`.
 * ============================================================================
 */
contract IndexStreamFacet is IndexFacetBase {
    using SafeERC20 for IERC20;

    // ── views ════════════════════════════════════════════════════════════

    /// @notice A single stream's backing, net of reservations, carry and any
    /// still-vesting displacement. Returns 0 for an untracked token AND for a
    /// tracked token whose `balanceOf` misbehaves.
    function streamHeld(address token) external view returns (uint256) {
        if (!StreamStorage.layout().tracked[token]) return 0;
        return _probeStreamBalance(token);
    }

    /// @notice How much of `token` is currently displaced by a recent mint,
    /// excluded from backing, and re-entering linearly as blocks pass.
    function unvestedOf(address token) external view returns (uint256) {
        return _unvestedOf(token);
    }

    /// @notice The block at which `token`'s displaced backing is fully back
    /// in the redeemable pool. Informational; nothing prices off it.
    function streamVestEndsAt(address token) external view returns (uint256) {
        return StreamStorage.layout().vest[token].end;
    }

    /// @notice How many stream slots of `MAX_STREAMS` are occupied.
    function streamCount() external view returns (uint256) {
        return StreamStorage.layout().streamList.length;
    }

    /// @notice Per-asset carry: value that arrived while there was no
    /// eligible holder, held out of backing until real stake exists again.
    function streamCarry(address token) external view returns (uint256) {
        return StreamStorage.layout().carry[token];
    }

    /// @notice The block at or after which carried value rejoins backing.
    /// `0` means nothing is carried; `type(uint256).max` means something is
    /// carried and there is no holder to release it to yet.
    function carryUnlockBlock() external view returns (uint256) {
        return StreamStorage.layout().carryUnlockBlock;
    }

    /// @notice Pending timelocked listing for `token`.
    function queuedStreams(address token) external view returns (uint64 eta, bool pending) {
        StreamStorage.QueuedStream storage q = StreamStorage.layout().queuedStreams[token];
        return (q.eta, q.pending);
    }

    /// @notice Currently accepting `depositStream` pushes.
    function isStream(address token) external view returns (bool) {
        return StreamStorage.layout().isStream[token];
    }

    /**
     * @notice Stream discovery for a UI or an external agent: every tracked
     * stream, its current held backing, and whether it still accepts pushes.
     * A token with `accepting == false` and `held > 0` is a DELISTED stream
     * whose backing remains fully withdrawable — the intended, permanent
     * state after a delisting, not a stuck one.
     */
    function streams()
        external
        view
        returns (address[] memory tokens, uint256[] memory held, bool[] memory accepting)
    {
        StreamStorage.Layout storage ss = StreamStorage.layout();
        uint256 n = ss.streamList.length;
        tokens = new address[](n);
        held = new uint256[](n);
        accepting = new bool[](n);
        for (uint256 i = 0; i < n; i++) {
            address t = ss.streamList[i];
            tokens[i] = t;
            held[i] = _probeStreamBalance(t);
            accepting[i] = ss.isStream[t];
        }
    }

    // ══ funding — permissionless ═════════════════════════════════════════

    /**
     * @notice Push value into an already-listed stream. PERMISSIONLESS — a
     * bribe, a partner incentive, or an RWA-airdrop forwarder funds
     * index-share holders, including pooled ones that can never claim
     * anything themselves.
     *
     * Credits the MEASURED BALANCE DELTA, never the nominal `amount`, so a
     * fee-on-transfer stream token cannot credit value that never arrived.
     * Reverts if `token` is not CURRENTLY accepting pushes.
     */
    function depositStream(address token, uint256 amount)
        external
        nonReentrant
        returns (uint256 credited)
    {
        StreamStorage.Layout storage ss = StreamStorage.layout();
        if (!ss.isStream[token]) revert NotAStream();
        if (amount == 0) revert ZeroAmount();
        _foldCarry();
        uint256 before = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        uint256 nowBal = IERC20(token).balanceOf(address(this));
        credited = nowBal > before ? nowBal - before : 0;
        if (credited == 0) revert NothingCredited();
        // No-op with any wrapped supply. With none, held aside rather than
        // left for the next actor to flash-capture. See "THE ZERO-DENOMINATOR
        // CARRY" (round 9e) in the header.
        _accrueCarry(token, credited);
        emit StreamFunded(token, msg.sender, credited);
    }

    // ══ admission — the ONLY administered surface ═══════════════════════

    /**
     * @notice Queue a token onto the stream whitelist. `ROLE_STREAM_LISTER`
     * only, and it lands no sooner than the vault's own timelock from now —
     * the same clock as a role rotation or a risk parameter, so a listing is
     * always publicly visible and contestable before it can take effect.
     *
     * @dev WHAT THE LISTING ROLE IS ACCEPTING RESPONSIBILITY FOR — see
     * WrappedIndexShare.sol's `queueStream` NatSpec for the full list of
     * judgment calls (rebasing tokens must not be listed; the token must be a
     * real, non-reentrant contract with a working `transfer`/`balanceOf`; a
     * KYC-gated RWA token is acceptable but restricted holders accumulate
     * `pendingClaim` credits rather than receiving the token; listing dilutes
     * existing holders on that stream's leg, offset by the round-9f re-vest).
     * None of that changed by moving into a facet.
     */
    function queueStream(address token) external onlyRole(ROLE_STREAM_LISTER_) {
        _validateStreamCandidate(token);
        uint64 eta = uint64(block.timestamp + CoreStorage.layout().timelockDelay);
        StreamStorage.layout().queuedStreams[token] = StreamStorage.QueuedStream({eta: eta, pending: true});
        emit StreamQueued(token, eta);
    }

    /**
     * @notice Apply a queued listing once the delay has elapsed.
     * Permissionless after the eta — the timelock is the gate, not a second
     * discretionary approval. Re-validates from scratch, so a queue made when
     * a slot was free cannot be executed past the cap.
     */
    function executeStream(address token) external {
        StreamStorage.Layout storage ss = StreamStorage.layout();
        StreamStorage.QueuedStream memory q = ss.queuedStreams[token];
        if (!q.pending) revert NoStreamQueued();
        if (block.timestamp < q.eta) revert StreamTimelockNotElapsed();
        _validateStreamCandidate(token);
        delete ss.queuedStreams[token];
        ss.streamList.push(token);
        ss.tracked[token] = true;
        ss.isStream[token] = true;
        emit StreamListed(token);
    }

    /// @notice Withdraw a queued listing. `ROLE_STREAM_LISTER` only. Grants no
    /// capability — it only undoes something the same role scheduled.
    function cancelStream(address token) external onlyRole(ROLE_STREAM_LISTER_) {
        StreamStorage.Layout storage ss = StreamStorage.layout();
        if (!ss.queuedStreams[token].pending) revert NoStreamQueued();
        delete ss.queuedStreams[token];
        emit StreamQueued(token, 0);
    }

    /**
     * @notice Stop accepting NEW pushes into a stream. `ROLE_STREAM_LISTER`
     * only.
     *
     * @dev DELISTING NEVER CLAWS BACK BACKING, AND THIS IS THE POINT. The
     * facet's existing balance of a delisted token stays in the backing pool,
     * stays in `streamList`, stays iterated by `redeemProRata`, and stays
     * fully redeemable pro rata by every holder forever. A listing role that
     * could remove value already promised to holders would be a lever over
     * user assets, which this codebase does not build. Immediate rather than
     * timelocked, and that direction is the safe one: a delay here could only
     * prolong exposure to a token just discovered to be hostile.
     */
    function delistStream(address token) external onlyRole(ROLE_STREAM_LISTER_) {
        StreamStorage.Layout storage ss = StreamStorage.layout();
        if (!ss.isStream[token]) revert NotAStream();
        ss.isStream[token] = false;
        emit StreamDelisted(token);
    }

    /**
     * @notice Free a stream's slot once it is delisted, fully drained, and
     * owes nobody. PERMISSIONLESS — it can only ever remove a token that has
     * nothing left to give.
     *
     * Requires `held == 0`, `reservedClaims == 0`, `carry == 0` AND
     * `unvestedOf == 0`, so pruning can never orphan a holder's pro-rata
     * slice, a deferred credit, a carried balance, or a still-vesting
     * displacement off the iteration list.
     */
    function pruneStream(address token) external {
        StreamStorage.Layout storage ss = StreamStorage.layout();
        if (!ss.tracked[token]) revert NotAStream();
        if (ss.isStream[token]) revert StreamStillListed();
        if (
            _probeStreamBalance(token) != 0 ||
            CoreStorage.layout().reservedClaims[token] != 0 ||
            ss.carry[token] != 0 ||
            _unvestedOf(token) != 0
        ) {
            revert StreamNotEmpty();
        }

        uint256 n = ss.streamList.length;
        for (uint256 i = 0; i < n; i++) {
            if (ss.streamList[i] == token) {
                ss.streamList[i] = ss.streamList[n - 1];
                ss.streamList.pop();
                break;
            }
        }
        ss.tracked[token] = false;
        emit StreamPruned(token);
    }

    // ── internals ════════════════════════════════════════════════════════

    function _validateStreamCandidate(address token) private view {
        CoreStorage.Layout storage cs = CoreStorage.layout();
        if (
            token == address(0) ||
            token == address(this) ||
            token == cs.dividendAsset ||
            cs.constituents[token].listed ||
            token.code.length == 0
        ) revert InvalidStream();
        StreamStorage.Layout storage ss = StreamStorage.layout();
        if (ss.tracked[token]) revert StreamAlreadyListed();
        if (ss.streamList.length >= MAX_STREAMS) revert StreamCapReached();
    }
}
