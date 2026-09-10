# Notification migration compatibility

Production maintenance can block trigger installation on the events table while all existing application tables remain usable. A failed optional notification upgrade must not require taking database maintenance offline to deploy data correctness repairs.

The deployment runner explicitly permits deferring only migration 110_market_change_notifications.sql with the reviewed normalized SHA-256. It first attempts the transaction with a two-second lock timeout. Deferral requires SQLSTATE 55P03 plus a granted ShareUpdateExclusiveLock on public.plank_market_events held by another database role. The failed transaction rolls back, including every function and trigger it created. No applied-migration record is written. Any changed SQL, other migration, other failure or unmatched blocker remains fatal.

All required migrations still apply normally. The ordinary runner without the deployment flag remains strict. `--check` continues to report the pending notification migration, so backups and future migration attempts remain enforced. Existing backup verification, role restrictions, activation health and rollback paths are unchanged.

The shared feed checks the migration registry. Until notification installation is complete, it emits explicit periodic resync every 15 seconds, scoped through the normal subscription protocol, while keeping the LISTEN connection ready. No notification or event is fabricated. Readiness errors also fall back to resync. Once the registry confirms installation, the feed emits a transition resync and stops periodic invalidations. Telemetry reports checking, periodic-resync or notifications. The timer stops when subscriptions stop or a connection fails.

This is a compatibility mode, not completion of the instant event-delivery rollout. After maintenance clears, run the strict migration under the existing writer guard with the required backup policy. Verify actual post-commit notification delivery before reporting full event mode.

Verification: a real isolated PostgreSQL database is migrated through 109; a separate role holds the production-shaped lock; 110 rolls back and stays pending while later required migrations succeed. The blocker stays alive and no partial triggers remain. Releasing the lock and retrying installs 110 exactly once. Feed tests verify periodic resync and transition without disconnecting; the existing real commit-to-WebSocket suite covers rollback, reconnection and scope identity. These tests are included in the PostgreSQL 9.6 CI lane.
