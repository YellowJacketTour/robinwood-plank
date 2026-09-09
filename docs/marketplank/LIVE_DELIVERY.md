# Shared live market delivery

The ingestion mesh remains the owner of provider subscriptions and budgets.
Migration 110 adds commit notifications for multichain collections, snapshots,
live orders, activity, tokens, token projection state, foreign rarity, and trait
indexes stored in foreign rarity collection rows.

Migration 111 maintains the browsing rank index in the source transaction,
including newly discovered collections without snapshots. Statement triggers
cover collection insertion/update and snapshot insertion/update/deletion;
rollback also rolls back the derived rank. It repairs existing missing rows.

One dedicated PostgreSQL LISTEN connection fans committed invalidations out to
WebSocket subscribers. A separate SSE route supports hosts where Passenger or
an upstream proxy does not forward WebSocket upgrades. Next's external rewrite
proxies `/api/market/multichain/socket` to a loopback relay on port 3917. There is
no custom Next server and no browser-to-provider subscription.

Notifications are hints to reread snapshots, not a durable event history. They
carry neither executable orders nor a claim that a venue is fully indexed.
Connect/reconnect requests resynchronization. A rollback produces no message;
an earlier transaction that commits later still produces its own message.

## Running it

Use the application's existing PostgreSQL environment, then run:

```sh
npm run db:migrate
npm run build
npm run build:market-realtime
node --env-file=/path/to/runtime.env .next/standalone/scripts/market-realtime.mjs
```

For development, `npm run market:realtime` runs the TypeScript entrypoint.
`MARKET_REALTIME_PORT` defaults to 3917 and must match the value present when
Next was built. `MARKET_REALTIME_ORIGINS` is a comma-separated exact allowlist;
the default is `https://plank.love,https://www.plank.love`. For the local probe,
include `http://127.0.0.1:3809`. The relay binds only 127.0.0.1.

The InMotion workflow packages the relay in normal and mesh-only artifacts.
The existing **provision mesh** operation installs its separate flock-protected
cron entry. Run that provisioning operation when introducing this release;
packaging the bundle alone does not install a new cron entry. The process exits
after 55 minutes and cron restarts it. Browsers resynchronize across restarts.
SSE still functions when the relay has not been provisioned.

Do not enable a new release by editing the dirty original checkout. Feature
work targets `dev`; the reviewed `dev` -> `master` release deploys production.

## Bounds and recovery

| Boundary | Behavior |
| --- | --- |
| SQL statement >32 scopes or >7,000 payload bytes | Broadcast resync with exact `omittedScopes`; never publish a truncated delta as complete |
| WebSocket subscription | At most 64 chain/collection coordinates; invalid messages close with 1008 |
| WebSocket frame | At most 16 KiB; compression disabled |
| Relay | At most 2,000 concurrent sockets; 20-second ping/pong and subscription deadline |
| Slow WebSocket reader | Terminate above 256 KiB buffered; reconnect requires resnapshot |
| SSE consumer | Close a full 64-chunk queue; EventSource reconnects and receives resync |
| Listener failure | Retry after 2–3 seconds; generation fence discards stale connection callbacks |
| Browser hidden | Disconnect; reconnect and resynchronize on return |
| Collection page | Coalesce notification bursts over one second; one callback runs at a time |
| Rankings | Catalog-wide invalidations; changed scopes are coalesced at five seconds and snapshots are read in batches of 64. Reconnect refreshes rendered rankings. Existing 90-second recovery discovers new catalog rows. |

The snapshot batch size is not a catalog or ingestion limit. The legacy market-event SSE API remains separate and is not a durable
replay guarantee. Native RobinWood-only trait tables and native contract order
tables are not notification sources in this migration.

## Release repair review (2026-09-09)

The owner authorized unveiling the global marketplace in this release.
`NEXT_PUBLIC_GLOBAL_MARKET_ENABLED` is now supplied from the repository variable
to the release build (default false). Set the variable to true before building
the release; an environment change alone cannot modify an existing Next bundle.

Next.js 16.3.4 and sharp 0.35.4 resolve the release-blocking advisories. The
Solana layout library uses the pinned Exodus bigint-buffer fork, whose published
runtime removes the native binding loader. Account decoding and transfer
instruction tests retain exact u64 values. The legacy jayson client uses uuid
11.1.1. Three moderate production audit entries remain: stream-json and its
jayson/web3.js parents. Its fixed major version is ESM with incompatible import
paths; forcing it into the CommonJS RPC client would break that client. The
application uses Jayson's browser JSON-RPC client, not its streaming filters.
Development-only advisories remain in unused transitive contract packages.

Bitcoin boot repairs now normalize hashes at the Esplora boundary and replace
the height-index entry as well as the hash-index entry. Complete raw blocks
replace the former 500-transaction pagination cap. Hash, transaction/witness
commitments, serialized length, and weight are checked before indexing.
Backfill verifies each seam and never crosses a missing header. Phase timeout
terminates the writer process instead of allowing late concurrent writes.
Shutdown waits for the active tick before closing PostgreSQL, within the
existing bounded exit grace.
The public worker verdict uses current timestamps and progress, rather than
mistaking historical unmatched attempts for live hung jobs.

Run `node scripts/test-release-repair-mutations.mjs` separately from other
builds/tests to verify the repair guards against applied mutations. The root
test command now includes the archive package suite.

The relay writes counts every minute: connections, rejected connections,
invalid subscriptions, timed-out and slow readers, notification delivery,
listener failures, malformed notifications, omitted scopes and reconnects.
`MarketChangeFeed.stats` exposes the equivalent process-local feed counters.
SQL `changedRows` counts transition row images (an UPDATE includes old and new).
NOTIFY depends on PostgreSQL queue capacity; this is not a claim of unlimited
write throughput. Measure production queue pressure before raising limits.

## Hydration and identity

Live token/rarity reads pass `projection=1` to avoid re-enqueuing their own
hydration cycle. Collection statistics use the stored snapshot endpoint.
Listing/offer refreshes reuse existing cached marketplace readers and provider
budgets; an invalidation does not bypass their freshness policy. Partial books
retain the last good nonempty view. Execution still requires the existing
quote and order checks.

Token-store lookups and metadata updates use chain-aware identity. Solana and
Bitcoin preserve case; EVM matches remain case-insensitive. Attention dedupe
includes every subject and token ID, exact money value, and context.

## Verification

Use a disposable PostgreSQL database whose name contains `test`:

```sh
npx tsx --test test/market/market-realtime.test.ts test/market/live-projection.test.ts test/market/swr-invalidation.test.ts
node scripts/test-market-realtime-mutations.mjs
node scripts/probe-market-realtime.mjs http://127.0.0.1:3809
```

The mutation runner temporarily edits source and a function in the test DB;
run it without another build/test job reading the checkout. It verifies each
mutation was applied, requires an assertion failure, and restores originals.
The integration probe needs a built Next server plus relay. It exercises 100
sockets through the actual Next upgrade rewrite, verifies one PG listener,
checks a stored snapshot read, and checks the SSE resync fallback. Measurements
are synthetic local evidence, not public-network latency promises.

The ordinary repository lint, typecheck, contract/market tests, build, migration
and PostgreSQL storage verifier remain release requirements. This transport
does not establish exhaustive marketplace coverage or supply missing private
order signatures, metadata, provider entitlements, or historical data.

## Rollback

Roll back the application release and stop the relay/provisioned cron entry.
Migration 110 is additive; the previous application can keep writing its
tables while the unused notifications remain. If notification overhead itself
requires rollback, drop only the `plank_changes_insert`,
`plank_changes_update`, and `plank_changes_delete` triggers on the nine tables
listed in migration 110, then drop `plank_notify_market_changes()`. Do not
delete market tables or their data.

Migration 111 is also compatible with the previous application. Its
`plank_hub_rank_insert/update` triggers on collections and
`plank_hub_rank_insert/update/delete` triggers on snapshots can be dropped to
restore previous index maintenance, at the cost of delayed catalog visibility.
