// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// Powerboard's funding surface -- see PlankPowerboard.sol. Kept as a
/// minimal interface so the jackpot implementation can evolve without
/// redeploying the distributor.
interface IPlankJackpot {
    function fund() external payable;
}

/**
 * PlankRakeDistributor -- the single, shared destination every Plank
 * Crash variant (V2/VRF/Entropy/Drand) and PlankDerby.sol should be
 * configured with as their immutable `treasury`, so the rake every one
 * of them already collects (see each contract's own keeperRewardBps/
 * accumulatedRake pattern -- unchanged, not re-litigated here) funds the
 * community mechanics instead of leaking to a disconnected wallet.
 *
 * NOT positive EV for players -- said honestly, not oversold: a rake
 * extracted from a closed pari-mutuel pool is still negative-sum for
 * players as a whole; nothing here changes that math. What this DOES
 * do, for real: the rake stays INSIDE the community instead of leaving
 * it. A share buys and burns real $PLANK (benefiting the token, which
 * players who hold it are often the same people), and a share funds the
 * Powerboard rolling jackpot, redistributed back among active bettors
 * (PlankPowerboard.sol) -- positive-SUM for the community, not
 * positive-EV for any single bet. See PlankPowerboard.sol's own header
 * for the deliberate, research-grounded choice to draw on a fixed
 * schedule rather than a surprise trigger.
 *
 * WHY PUSH, NOT PULL: every recipient here (burnEngine, jackpot,
 * treasury) is this deploy's own trusted, immutable, non-arbitrary
 * contract/address -- none of the "an untrusted payee could grief a
 * push transfer" reasoning that justifies PullPayment elsewhere in this
 * protocol applies here. A plain receive() splitting and forwarding
 * immediately is simpler and has no pull-step griefing surface to worry
 * about in the first place.
 */
contract PlankRakeDistributor {
    address public immutable burnEngine;
    IPlankJackpot public immutable jackpot;
    address public immutable treasury;
    // Real, fixed at deploy -- what fraction of every ETH received goes
    // to burnEngine and the Powerboard jackpot respectively. The remainder (10000 -
    // burnBps - airdropBps) goes to treasury. No setter, anywhere --
    // changing the split requires a new deployment and a deliberate
    // re-point of every rake-generating contract's treasury, not a
    // silent parameter flip.
    uint256 public immutable burnBps;
    uint256 public immutable airdropBps;

    uint256 public totalReceived;
    uint256 public totalToBurn;
    uint256 public totalToAirdrop;
    uint256 public totalToTreasury;
    // Per-leg ETH that a delivery attempt failed to push, retained here
    // and retryable via flush(). See receive() for why delivery is
    // best-effort rather than all-or-nothing.
    uint256 public stuckBurn;
    uint256 public stuckAirdrop;
    uint256 public stuckTreasury;

    event RakeDistributed(uint256 amount, uint256 toBurn, uint256 toAirdrop, uint256 toTreasury);
    event LegStuck(string leg, uint256 amount);
    event LegFlushed(string leg, uint256 amount);

    error ZeroAddress();
    error SplitExceeds100Percent();
    error NothingStuck();

    constructor(address burnEngine_, address jackpot_, address treasury_, uint256 burnBps_, uint256 airdropBps_) {
        if (burnEngine_ == address(0) || jackpot_ == address(0) || treasury_ == address(0)) revert ZeroAddress();
        if (burnBps_ + airdropBps_ > 10000) revert SplitExceeds100Percent();
        burnEngine = burnEngine_;
        jackpot = IPlankJackpot(jackpot_);
        treasury = treasury_;
        burnBps = burnBps_;
        airdropBps = airdropBps_;
    }

    /**
     * BEST-EFFORT, NOT ALL-OR-NOTHING -- a real audit fix. Each leg is
     * attempted independently, and a leg that reverts (a paused/buggy
     * jackpot, a treasury that became a reverting contract) is RETAINED
     * here and retryable via flush(), never reverting the whole receive().
     * Without this, one bad recipient would revert every upstream
     * withdrawPayments-to-distributor forever and strand ALL rake in the
     * crash contracts' escrows. The split accounting is booked in full up
     * front regardless of delivery, so a leg being temporarily stuck never
     * loses or double-counts ETH -- it is either delivered now or held for
     * flush().
     */
    receive() external payable {
        uint256 amount = msg.value;
        uint256 toBurn = (amount * burnBps) / 10000;
        uint256 toAirdrop = (amount * airdropBps) / 10000;
        uint256 toTreasury = amount - toBurn - toAirdrop;

        totalReceived += amount;
        totalToBurn += toBurn;
        totalToAirdrop += toAirdrop;
        totalToTreasury += toTreasury;
        emit RakeDistributed(amount, toBurn, toAirdrop, toTreasury);

        if (toBurn > 0 && !_sendRaw(burnEngine, toBurn)) {
            stuckBurn += toBurn;
            emit LegStuck("burn", toBurn);
        }
        if (toAirdrop > 0 && !_fundJackpot(toAirdrop)) {
            stuckAirdrop += toAirdrop;
            emit LegStuck("airdrop", toAirdrop);
        }
        if (toTreasury > 0 && !_sendRaw(treasury, toTreasury)) {
            stuckTreasury += toTreasury;
            emit LegStuck("treasury", toTreasury);
        }
    }

    /// Permissionless retry of any leg that previously failed to deliver.
    /// No admin, no privilege -- anyone can nudge stuck funds to their
    /// fixed, immutable destination once that destination is healthy again.
    function flush() external {
        bool did;
        uint256 b = stuckBurn;
        if (b > 0 && _sendRaw(burnEngine, b)) {
            stuckBurn = 0;
            did = true;
            emit LegFlushed("burn", b);
        }
        uint256 a = stuckAirdrop;
        if (a > 0 && _fundJackpot(a)) {
            stuckAirdrop = 0;
            did = true;
            emit LegFlushed("airdrop", a);
        }
        uint256 t = stuckTreasury;
        if (t > 0 && _sendRaw(treasury, t)) {
            stuckTreasury = 0;
            did = true;
            emit LegFlushed("treasury", t);
        }
        if (!did) revert NothingStuck();
    }

    function _sendRaw(address to, uint256 value) private returns (bool ok) {
        (ok, ) = to.call{value: value}("");
    }

    function _fundJackpot(uint256 value) private returns (bool) {
        try jackpot.fund{value: value}() {
            return true;
        } catch {
            return false;
        }
    }
}
