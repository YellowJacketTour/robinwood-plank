# Private release migration reconciliation — 2026-09-13

The release integration merges upstream market migrations through `115_foreign_rarity_browse_index.sql`. The undeployed Charmville chain previously occupied 104–134 and collided with twelve upstream versions. This integration assigns the complete Charmville chain to **116–146**, maintaining its internal order and unchanged SQL. Upstream migration filenames and contents remain unchanged. Exact filename references in tests and documentation follow the new names.

Do not rename historical applied entries in any deployed migration ledger. This reconciliation is for the not-yet-deployed release branch. The historical feature checkout retains its original chain until a deliberate merge. The earlier isolated browser fixture database remains available for the ongoing browser run; it is not evidence of the reconciled migration history.

A fresh loopback-only database `charmville_acceptance_20260913_v2` was created on the existing isolated PostgreSQL 16 cluster at port 55419. The canonical migration runner applied the full repository chain through 146 and reported schema current. Evidence: `work/migrations-isolated-v2.log`. No production database was read or changed.

Validation after reconciliation:

- Migration collision/idempotency tests: 2 passed, 0 failed, 0 skipped.
- Social custody, private invites, runtime tickets and renewal tests against PostgreSQL: 12 passed, 0 failed, 0 skipped.

Deployment configuration is server-only via Passenger's `PLANK_ENV_FILE`, defaulting to `shared/.env.production`. Set `CHARMVILLE_ACCESS_MODE=private` and explicitly configure `CHARMVILLE_ADMIN_WALLETS` for the verified account. Global `PLANK_ADMIN_ADDRESSES` is intentionally not inherited. Runtime enablement requires `CHARMVILLE_RUNTIME_READY=1` and the accepted `CHARMVILLE_RUNTIME_RELEASE`; bootstrap derives its root from the immutable application release and rejects missing or incomplete packages.
