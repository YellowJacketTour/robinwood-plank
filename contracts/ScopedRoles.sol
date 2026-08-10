// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * ============================================================================
 *  ScopedRoles — scoped-capability administration, replacing blanket `admin`
 *
 *  NOT FOR DEPLOYMENT. Inherited by GlobalIndexVault.sol and PlankGauge.sol,
 *  both of which carry the same no-network gate; see their headers.
 *
 *  WHY THIS EXISTS
 *  ---------------
 *  Both contracts previously carried ONE `admin` address that could queue
 *  every timelocked change there was: concentration caps, the platform
 *  allocation that routes value to an operator, ramp durations, gauge
 *  multipliers, the allowlists. That is exactly the shape behind 2026's
 *  Drift Protocol loss and its cousins — one key, compromised or
 *  socially-engineered, holding every capability at once. The timelock bounds
 *  WHEN such a change lands; it does nothing to bound WHAT one key can reach.
 *
 *  This contract bounds the WHAT. Capabilities are split into named roles,
 *  each independently keyed to a different address, each function gated on
 *  exactly one role and never on a broader one. A compromised risk-parameter
 *  key cannot touch the platform allocation; a compromised admission key
 *  cannot retune the gauge curve; and so on, in both directions, for every
 *  pair. The blast radius of any single key is the enumerated set of
 *  functions carrying that role's modifier, full stop.
 *
 *  THE THREE RULES THIS FILE ENFORCES
 *  ----------------------------------
 *  1. NO SUPER-ROLE OVER PARAMETERS. `ROLE_ADMIN` — the role-management role
 *     — can reassign role holders and can do NOTHING else. It cannot queue a
 *     parameter, a listing, an allowlist entry, or a treasury. It is not a
 *     root key with extra steps; it is a key-rotation key.
 *
 *  2. ROLE REASSIGNMENT IS ITSELF TIMELOCKED, on the same delay as every
 *     parameter, exactly as the old single-admin handover was. `queueRole`
 *     only writes a pending record; `executeRole` is the only thing that
 *     moves a holder, and it reverts before the eta. So `ROLE_ADMIN` CAN
 *     eventually grant itself another role — that is unavoidable for any
 *     key-rotation authority that can rotate to an arbitrary address — but it
 *     can never do so in one transaction, and never without the full delay of
 *     public, on-chain, cancellable-by-successor warning. Self-escalation is
 *     therefore observable and slow, which is the entire property a timelock
 *     is for.
 *
 *  3. NO ROLE CAN BLOCK AN EXIT. Nothing in this file has a pause, a freeze,
 *     a role-lock, or any other flag, and neither inheriting contract gained
 *     one. This is deliberate and it is the single most important invariant
 *     in the design: a "safety" mechanism that can hold user assets in an
 *     unmovable state — even temporarily, even for a legitimate reason, even
 *     for less than the timelock ceiling — is a hostage mechanism wearing a
 *     safety hat. GlobalIndexVault's `redeemProRata` carries no role modifier
 *     and no state flag on any branch it takes, so it works while a change is
 *     queued, works with every role key simultaneously malicious, and works
 *     if every role holder is a dead address. See the "the exit door" tests.
 *
 *  EXTENSIBILITY, WITHOUT A PROXY
 *  ------------------------------
 *  Roles are `bytes32` keys in a mapping, not a fixed struct of addresses, so
 *  a future role costs one constant plus one line in `_isKnownRole`. That is
 *  as far as future-proofing goes here on purpose: there is no upgradeability,
 *  no proxy, no delegatecall, and no admin-settable implementation pointer,
 *  because those are themselves the canonical path to "the admin bricked or
 *  rugged the vault". A redeploy is the upgrade mechanism, and a redeploy
 *  cannot touch the reserves of a contract already holding them.
 * ============================================================================
 */
abstract contract ScopedRoles {
    struct QueuedRole {
        address holder;
        uint64 eta;
        bool pending;
    }

    /// @notice The role-management role. Reassigns role holders — and only
    /// ever role holders. Gates no parameter, no listing, no allowlist, no
    /// treasury, and no value path anywhere in either inheriting contract.
    bytes32 public constant ROLE_ADMIN = "role.admin";

    /**
     * @notice AUDIT M-1 (2026-08-09) — the grace period, mirroring the
     * diamond's `IndexFacetBase.TIMELOCK_GRACE_PERIOD` exactly.
     *
     * `executeRole` used to check only `block.timestamp >= eta`, with no upper
     * bound, so a queued handover stayed executable FOREVER: a successor who
     * never showed up could be installed a year later by whoever still held
     * the calldata, long after the public scrutiny window closed. Uniswap's
     * Timelock has enforced `timestamp <= eta + GRACE_PERIOD` since 2020 for
     * this reason. 14 days — 7x the deployed 48h delay, so a gas spike or a
     * holiday can never turn a liveness hiccup into a lost rotation, while
     * still being far shorter than the interval over which the circumstances
     * a handover was judged against can turn over.
     *
     * A `constant`, never a governed value: a settable grace period is the
     * unbounded behaviour one parameter change away.
     */
    uint256 public constant GRACE_PERIOD = 14 days;

    /// @notice role key => current holder. The single source of truth for
    /// every privileged check in the inheriting contracts.
    mapping(bytes32 => address) public roleHolder;

    /// @notice role key => pending timelocked reassignment.
    mapping(bytes32 => QueuedRole) public queuedRoles;

    error NotRoleHolder(bytes32 role);
    error UnknownRole(bytes32 role);
    error BadRoleHolder();
    error NoRoleQueued();
    error RoleTimelockNotElapsed();
    /// @dev AUDIT M-1. Matured, but past `GRACE_PERIOD`. Distinct from
    /// `RoleTimelockNotElapsed` so the two boundary failures are never
    /// confused by a caller, a monitor, or a test.
    error QueueExpired();

    event RoleQueued(bytes32 indexed role, address indexed next, uint64 eta);
    event RoleApplied(bytes32 indexed role, address indexed previous, address indexed next);

    /// @dev The inheriting contract's immutable timelock delay. Immutable
    /// there, so a role rotation can never be scheduled on a shorter clock
    /// than a parameter change.
    function _timelockDelay() internal view virtual returns (uint256);

    /// @dev The inheriting contract's complete role set. Anything outside it
    /// is rejected at queue time, so `ROLE_ADMIN` cannot mint capability by
    /// populating a key no modifier reads (harmless, but it would pollute the
    /// on-chain record of who holds what).
    function _isKnownRole(bytes32 role) internal pure virtual returns (bool);

    modifier onlyRole(bytes32 role) {
        if (msg.sender != roleHolder[role]) revert NotRoleHolder(role);
        _;
    }

    /// @dev Constructor-only seeding. Every post-construction change goes
    /// through the timelock.
    function _initRole(bytes32 role, address holder) internal {
        if (holder == address(0)) revert BadRoleHolder();
        roleHolder[role] = holder;
        emit RoleApplied(role, address(0), holder);
    }

    /**
     * @notice Queue a role reassignment. ROLE_ADMIN only, and it lands no
     * sooner than `_timelockDelay()` from now — including when the role being
     * reassigned is ROLE_ADMIN itself, which is the old admin handover.
     *
     * Note what is NOT here: no batch, no "grant" that adds a second holder
     * (a role has exactly one holder, so granting is always also revoking),
     * and no immediate path of any kind.
     */
    function queueRole(bytes32 role, address next) external onlyRole(ROLE_ADMIN) {
        if (!_isKnownRole(role)) revert UnknownRole(role);
        if (next == address(0)) revert BadRoleHolder();
        uint64 eta = uint64(block.timestamp + _timelockDelay());
        queuedRoles[role] = QueuedRole({holder: next, eta: eta, pending: true});
        emit RoleQueued(role, next, eta);
    }

    /// @notice Apply a queued reassignment once the delay has elapsed.
    /// Permissionless after the eta, exactly as `executeParam` is: the
    /// timelock is the gate, not a second discretionary approval.
    function executeRole(bytes32 role) external {
        QueuedRole memory q = queuedRoles[role];
        if (!q.pending) revert NoRoleQueued();
        if (block.timestamp < q.eta) revert RoleTimelockNotElapsed();
        if (block.timestamp > uint256(q.eta) + GRACE_PERIOD) revert QueueExpired(); // AUDIT M-1
        delete queuedRoles[role];
        address previous = roleHolder[role];
        roleHolder[role] = q.holder;
        emit RoleApplied(role, previous, q.holder);
    }

    /**
     * @notice Withdraw a queued reassignment. ROLE_ADMIN only.
     *
     * @dev This grants no capability: the only thing it can prevent is a
     * change ROLE_ADMIN itself scheduled and could equally have overwritten
     * by re-queueing. It exists so a mis-typed successor address does not
     * have to be corrected by racing the eta.
     */
    function cancelRole(bytes32 role) external onlyRole(ROLE_ADMIN) {
        if (!queuedRoles[role].pending) revert NoRoleQueued();
        delete queuedRoles[role];
        emit RoleQueued(role, address(0), 0);
    }

    /// @notice Convenience view: the holder of `role`, or address(0) if the
    /// role is not part of this contract's set.
    function hasRole(bytes32 role, address who) external view returns (bool) {
        return who != address(0) && roleHolder[role] == who;
    }
}
