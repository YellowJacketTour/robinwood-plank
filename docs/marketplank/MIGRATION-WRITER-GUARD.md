# Migration writer guard and verified retry backup

Production release 579c4ae reached PostgreSQL 9.6.23 successfully, completed a 25,363,533,140-byte custom archive, then failed migration110 with SQLSTATE55P03 while creating a trigger on plank_market_events. The old release remained active. The rollout had omitted the Bitcoin hose from its pre-migration stop, and a one-time kill did not prevent cron from restarting writers.

The guard now stops only this application's managed worker paths and holds the same four flock files cron uses for mesh, OpenSea stream, realtime and Bitcoin hose. It runs migration while owning those locks and releases them on exit. It does not edit crontab or pause the web app. The PostgreSQL lock timeout remains bounded.

An explicit workflow-dispatch recovery option can select a previously completed predeploy archive by its exact basename, successful-run byte count and unchanged active release SHA. Validation requires an archive started less than two hours ago, a regular nonsymlink file under this app's backup directory, matching byte count, PGDMP header, a successful pg_restore listing and the same database name. Failure refuses deployment; normal pushes retain the full backup path. Operators must select only a backup whose successful completion was observed, never infer completeness from a filename.

This is a retained recovery point, not continuous point-in-time recovery. It does not claim to include writes after the archive snapshot began. The existing failed run's verified completion is recorded separately in the delivery evidence.

Tests validate rejection of stale, wrong-size, wrong-release, wrong-database, path-traversal and invalid archives. The Linux integration test starts real flock-held worker fixtures, confirms the guard excludes cron restarts during its action, and verifies release of all locks after a failed action.
