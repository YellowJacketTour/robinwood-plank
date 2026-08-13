// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

interface IConfirmedOwnable {
    function acceptOwnership() external;
}

/**
 * A real, genuine finding while wiring up Chainlink VRF for
 * PlankCrashVRF.sol: Chainlink's ConfirmedOwner (which
 * VRFConsumerBaseV2Plus requires inheriting) has NO renounceOwnership().
 * Its transferOwnership() is a real two-step handoff -- the current owner
 * proposes a new owner, and that exact address must itself call
 * acceptOwnership() to complete the transfer. Calling
 * transferOwnership(address(0)) does NOT renounce anything: it sets a
 * pending transfer that nobody can ever complete (nobody can transact as
 * address(0)), so the ORIGINAL owner silently keeps full control forever
 * -- the opposite of what "renounce" is supposed to mean, and a real
 * trap for a deploy script that assumed OpenZeppelin's Ownable API (which
 * does have a real renounceOwnership()).
 *
 * This is the correct fix: a real, deployed, immutable contract whose
 * only capability is completing that one handoff, and which exposes
 * NOTHING else -- no owner of its own, no other function, no fallback.
 * Once ownership is burned here, PlankCrashVRF's owner() is permanently
 * this contract's address, and no path exists, ever, for anyone to make
 * it call transferOwnership() or setCoordinator() again. That is a real
 * renunciation, verified by the fact that this contract has no code path
 * that could do otherwise -- not by trusting a name on a function that
 * doesn't behave the way its name implies.
 *
 * Usage (must be this exact order -- see PlankCrashVRF.sol's own deploy
 * checklist):
 *   1. Deploy PlankCrashVRF (owner = deployer).
 *   2. Deploy OwnershipBurner(address(plankCrashVRF)).
 *   3. Deployer calls plankCrashVRF.transferOwnership(address(burner)).
 *   4. Anyone calls burner.burn() -- completes the handoff. From this
 *      point on, plankCrashVRF.owner() == address(burner), permanently.
 */
contract OwnershipBurner {
    address public immutable target;
    bool public burned;

    error AlreadyBurned();

    constructor(address _target) {
        target = _target;
    }

    /// Permissionless on purpose -- there is no reason to gate who
    /// triggers the final step of a transfer the real owner already
    /// proposed in step 3 above; gating it would just be a needless extra
    /// admin action on top of a mechanism whose whole point is removing
    /// admin control.
    function burn() external {
        if (burned) revert AlreadyBurned();
        burned = true;
        IConfirmedOwnable(target).acceptOwnership();
    }
}
