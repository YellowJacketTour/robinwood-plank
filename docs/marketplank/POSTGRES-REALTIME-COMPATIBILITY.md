# Market realtime PostgreSQL compatibility

The first production deployment of migrations 110 and 111 failed before activation:
PostgreSQL rejected `REFERENCING` in migration 110, which rolled back. Neither
migration was recorded as applied. This repair updates those unapplied migrations;
migrations 109 and earlier are unchanged.

PostgreSQL 10+ uses statement transition tables. PostgreSQL 9.5/9.6 uses a
transaction-local temporary scope accumulator with BEFORE STATEMENT, AFTER ROW,
and AFTER STATEMENT triggers. Scope counts include old and new identities and
remain exact even when a notification must request resynchronization. A mixed
UPSERT is aggregated into one notification on the legacy path. Notifications
remain commit-bound; rollback publishes nothing. Nested statements are separated
by relation and trigger depth. Rank maintenance uses row triggers on the legacy
path and statement triggers on modern servers.

The migration checker logs only the numeric server version and checks legacy TEMP
privilege before backup. It does not log connection configuration. A newer database
retains the faster bulk transition-table path automatically.

`test/market/market-trigger-compat.test.ts` executes both paths against isolated
schemas on CI's PostgreSQL 16. The legacy branch is selected in test SQL, not by a
production environment override. It covers rollback, batch counts, case-sensitive
renames, mixed UPSERTs, scope overflow, initial discovery rank, and snapshot removal.
The existing real WebSocket and transactional rank tests also pass locally with
legacy triggers installed on PostgreSQL 17. These are execution-path checks, not a
claim that the local runtime is PostgreSQL 9.6.

The normal deployment backup requirement remains in force. The successful backup
from the failed release is retained; it is not silently substituted for a fresh
rollback point on a later deployment.
