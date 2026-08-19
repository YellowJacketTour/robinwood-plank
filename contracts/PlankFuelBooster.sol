// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ReentrancyGuard} from "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import {IPlankProgression} from "./IPlankProgression.sol";

interface IBurnableFrom {
    function burnFrom(address account, uint256 amount) external;
}

interface IFairPriceOracle {
    function consult(address tokenIn, uint256 amountIn) external view returns (uint256 amountOut);
}

interface IVaultFundable {
    function currentRoundId() external view returns (uint256);
    function fundVault() external payable;
}

/**
 * PlankFuelBooster -- "fuel the pad, not your own odds."
 *
 * On the launchpad (the betting/fueling window -- see crash.html's 0->1.00x
 * "fueling" readout), a player can burn real $PLANK. This contract converts
 * that burn's FAIR ETH value (read from the same audited TWAP oracle
 * PlankBurnEngine already trusts) into a boost to the crash's shared Vault
 * -- the never-zero reserve that seeds every future round for EVERYONE, not
 * just the burner.
 *
 * WHY THIS IS NOT PAY-TO-WIN, BY CONSTRUCTION: burning here calls the
 * exact same `fundVault()` any donor could call. It cannot touch the
 * burner's own stake, cash-out timing, or crash-point odds -- those are
 * fixed by drand and the pari-mutuel pool, untouched by this contract. The
 * ONLY effect is growing a POOL EVERYONE draws from equally in future
 * rounds. A whale who burns a fortune buys the whole table a bigger prize
 * pot, not a better bet for themselves.
 *
 * WHERE THE ETH COMES FROM, HONESTLY: burning $PLANK does not conjure ETH.
 * This contract holds a pre-funded `boostPool` (topped up via `fund()` --
 * e.g. from the protocol's own dev/treasury allocation, or a sponsor) and
 * releases up to the fair TWAP value of what was burned, capped by three
 * independent limits so no single burn or round can drain it:
 *   - maxBoostPerBurnWei:  ceiling on any one burnFuel() call.
 *   - maxBoostPerRoundWei: ceiling on total boost released while a given
 *     crash round is current (tracked against the crash's own
 *     currentRoundId(), so it resets automatically every round).
 *   - boostPool itself:    can never release more than it holds.
 * Burning MORE than the caps allow still burns the full amount (real,
 * honored deflation) but only boosts up to the cap -- the event reports
 * both numbers so the UI can be honest about it ("Xk $PLANK burned, Y ETH
 * boosted the Vault, cap reached").
 *
 * PRICING SAFETY: reuses PlankV2TwapOracle, the same manipulation-resistant
 * time-weighted price PlankBurnEngine's buybacks are floored against (see
 * that oracle's own header for the sandwich-resistance argument). If the
 * oracle is unprimed or stale, burnFuel() reverts outright -- atomically,
 * so the player's $PLANK is never burned for an unpriceable, unrewarded
 * boost (the same "funds wait, never move" discipline PlankBurnEngine
 * applies to its own swaps).
 */
contract PlankFuelBooster is ReentrancyGuard {
    IBurnableFrom public immutable plank;
    IFairPriceOracle public immutable oracle;
    IVaultFundable public immutable crash;
    uint256 public immutable maxBoostPerBurnWei;
    uint256 public immutable maxBoostPerRoundWei;

    // ── Optional progression/leveling layer -- see setProgression() and
    // PlankProgression.sol's own header. Same pattern as PlankCrashDrand's
    // own wiring: _deployer captured automatically, not a parameter or an
    // ongoing admin role.
    address private immutable _deployer;
    IPlankProgression public progression;

    uint256 public boostPool;
    uint256 public totalPlankBurned;
    uint256 public totalEthBoosted;

    // Rolling per-round stats, keyed off the crash's OWN round counter so
    // they reset automatically with no separate epoch bookkeeping. Tracks
    // BOTH the boost used (for the cap) and the raw PLANK burned (for the
    // UI's "X $PLANK burned this round" readout) -- the two can diverge
    // once a cap is hit, since burning past a cap still burns in full.
    uint256 private _capRoundId;
    uint256 private _capUsedThisRound;
    uint256 private _plankBurnedThisRound;

    event Funded(address indexed from, uint256 amount, uint256 poolAfter);
    event FuelBurned(
        uint256 indexed roundId,
        address indexed player,
        uint256 plankAmount,
        uint256 fairEthValue,
        uint256 boosted
    );

    error ZeroAddress();
    error BadConfig();
    error ZeroAmount();
    error NothingToFund();
    error ProgressionAlreadySet();
    error NotDeployer();

    constructor(address plank_, address oracle_, address crash_, uint256 maxBoostPerBurnWei_, uint256 maxBoostPerRoundWei_) {
        _deployer = msg.sender;
        if (plank_ == address(0) || oracle_ == address(0) || crash_ == address(0)) revert ZeroAddress();
        if (maxBoostPerBurnWei_ == 0 || maxBoostPerRoundWei_ == 0) revert BadConfig();
        if (maxBoostPerBurnWei_ > maxBoostPerRoundWei_) revert BadConfig();
        plank = IBurnableFrom(plank_);
        oracle = IFairPriceOracle(oracle_);
        crash = IVaultFundable(crash_);
        maxBoostPerBurnWei = maxBoostPerBurnWei_;
        maxBoostPerRoundWei = maxBoostPerRoundWei_;
    }

    /// Wires this contract to a deployed PlankProgression, EXACTLY once, by
    /// whoever deployed THIS contract -- see PlankCrashDrand.setProgression's
    /// own comment for the full reasoning (same pattern, same narrow,
    /// one-shot, non-fund-touching privilege).
    function setProgression(address progression_) external {
        if (msg.sender != _deployer) revert NotDeployer();
        if (address(progression) != address(0)) revert ProgressionAlreadySet();
        progression = IPlankProgression(progression_);
    }

    /// Tops up the ETH boost pool. Open to anyone -- treasury, a sponsor, a
    /// well-wisher -- for the same reason PlankCrashDrand.fundVault() is
    /// open: there is no reason to gate funding a community mechanic.
    function fund() external payable {
        if (msg.value == 0) revert NothingToFund();
        boostPool += msg.value;
        emit Funded(msg.sender, msg.value, boostPool);
    }

    /// Burns `plankAmount` of the caller's $PLANK (via burnFrom -- approve
    /// this contract first) and boosts the crash's Vault by the fair ETH
    /// value of that burn, capped per-burn / per-round / by the pool's own
    /// balance. The burn is real and unconditional; only the BOOST is capped.
    function burnFuel(uint256 plankAmount) external nonReentrant {
        if (plankAmount == 0) revert ZeroAmount();

        // Price FIRST (reverts if unprimed/stale) -- the player's PLANK is
        // never spent on an unpriceable, unrewarded boost.
        uint256 fairEth = oracle.consult(address(plank), plankAmount);

        uint256 roundId = crash.currentRoundId();
        if (roundId != _capRoundId) {
            _capRoundId = roundId;
            _capUsedThisRound = 0;
            _plankBurnedThisRound = 0;
        }

        uint256 boost = fairEth;
        if (boost > maxBoostPerBurnWei) boost = maxBoostPerBurnWei;
        uint256 roomLeft = maxBoostPerRoundWei > _capUsedThisRound ? maxBoostPerRoundWei - _capUsedThisRound : 0;
        if (boost > roomLeft) boost = roomLeft;
        if (boost > boostPool) boost = boostPool;

        // Real, unconditional burn -- happens regardless of how much of it
        // actually converts into a Vault boost above the caps.
        plank.burnFrom(msg.sender, plankAmount);
        totalPlankBurned += plankAmount;
        _plankBurnedThisRound += plankAmount;

        if (boost > 0) {
            _capUsedThisRound += boost;
            boostPool -= boost;
            totalEthBoosted += boost;
            crash.fundVault{value: boost}();
        }

        emit FuelBurned(roundId, msg.sender, plankAmount, fairEth, boost);
        // MEDIUM-severity fix, 2026-08-18: PlankProgression.sol's own header
        // claims this call "can't revert a caller's OWN core action" because
        // it's the last statement in the function -- that claim was false as
        // written: Solidity's default unwind-on-revert doesn't care about
        // statement order, only about whether the transaction as a whole
        // succeeds. A misbehaving/misconfigured `progression` (wired once by
        // the deployer via setProgression()) could brick every burnFuel()
        // call by reverting here, unwinding the burn/boost that had already
        // completed above. try/catch makes the documented guarantee real:
        // progression bookkeeping can fail without taking the caller's real
        // action down with it.
        if (address(progression) != address(0)) {
            // Real, confirmed bug -- see PlankPowerboard.claimTickets's
            // identical try/catch for the full writeup: a genuinely EMPTY
            // try-block body was empirically, deterministically unreliable
            // under this project's viaIR compile pipeline (8/8 fail vs 8/8
            // pass, reproduced repeatedly). Never leave a try-block body
            // truly empty -- a real event closes the bug and adds real
            // observability for free.
            try progression.recordFuelBurn(msg.sender) {
                emit ProgressionRecorded(msg.sender, true);
            } catch {
                emit ProgressionRecorded(msg.sender, false);
            }
        }
    }

    /// @notice Whether the optional progression hook succeeded for this burn. false is NOT a fund-safety issue -- it's real signal that progression.sol is misconfigured or broken and needs operator attention.
    event ProgressionRecorded(address indexed player, bool succeeded);

    /// UI helper: how much boost headroom is left for the round that is
    /// current RIGHT NOW (a view, so it doesn't itself roll the cap).
    function roundBoostRemaining() external view returns (uint256 roundId, uint256 used, uint256 cap) {
        roundId = crash.currentRoundId();
        used = roundId == _capRoundId ? _capUsedThisRound : 0;
        cap = maxBoostPerRoundWei;
    }

    /// UI helper: the full "how much fuel has THIS round's tank received"
    /// readout -- raw $PLANK burned (uncapped -- burning past the boost cap
    /// still counts here) alongside the ETH that actually boosted the
    /// Vault (capped). Burning is allowed at ANY time -- there is no phase
    /// check in burnFuel() -- so this simply reports against whichever
    /// round is current right now; a burn always feeds the NEXT launch.
    function roundFuelStats()
        external
        view
        returns (uint256 roundId, uint256 plankBurnedThisRound, uint256 ethBoostedThisRound, uint256 boostCapWei)
    {
        roundId = crash.currentRoundId();
        bool sameRound = roundId == _capRoundId;
        plankBurnedThisRound = sameRound ? _plankBurnedThisRound : 0;
        ethBoostedThisRound = sameRound ? _capUsedThisRound : 0;
        boostCapWei = maxBoostPerRoundWei;
    }
}
