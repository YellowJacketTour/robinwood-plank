# Shared world transport

Run `node scripts/charmville/serve-world-socket.mjs` alongside the local Next server on3017. The gateway binds only127.0.0.1:3023, accepts the two local app origins, authenticates in the first message (never a URL token), and caps connections at32. It targets10 snapshots per second per connection, skipping outstanding reads or writes. It is not a fixed-step simulation scheduler.

Every movement and snapshot uses the existing authenticated actor endpoint. This preserves permission expiry, private-region visibility, collision, epoch, speed and transaction checks. A connection never grants ownership or trusts client positions. Payloads are bounded; authentication times out; slow consumers are closed; closed connections abort outstanding requests. Tokens remain only in process memory.

The browser sends movement through the socket when ready and otherwise uses HTTP. A lost command is not blindly replayed: the movement client reads committed state through HTTP. Snapshots refresh presence metadata and authorized peers. Reconnection authenticates again. This implementation preserves the current16-peer server query cap and standing sprite renderer.

## Scaling requirements before claiming a persistent MMO

This gateway still performs per-client database-backed HTTP reads. Raising its connection cap is not a scaling strategy. A production transport needs a supported TLS WebSocket host, short-lived scoped connection tickets, region ownership and migration, one simulation worker per region partition, a spatial interest index, bounded delta snapshots, and versioned resynchronization. The database should persist committed checkpoints/events and economic transactions rather than serve every render tick.

Separate simulation ticks from rendering. Region workers own actor and creature positions, collision, ability timing and encounter transitions. Render interpolation consumes timestamped snapshots; it must not grant action rights. Dungeons are region instances with explicit admission and party policies. Cross-region travel transfers epoch and authority atomically. The economic ledger remains global and transactional across regions.

Acceptance must measure concurrent real clients, creatures per region, packet delay/loss, p95/p99 tick time, bytes per client, reconnect convergence, worker crash recovery, private access revocation, and overload behavior. No target for the largest conceivable world is certified by this local gateway. Creature simulation, smooth remote animation, distributed regions and production deployment remain unfinished.

Verification: `node scripts/charmville/verify-world-socket.mjs` checks two authenticated clients, durable movement, peer delivery and invalid-session rejection. `node scripts/charmville/verify-native-account-movement.mjs --socket` additionally requires native browser movement to use socket commands and committed acknowledgments.

Creature presentation now receives a separately guarded encounter stream targeting5Hz. Every snapshot uses the authenticated encounter endpoint, and failures clear that stream. Native projection consumes HP and committed event history through its existing deduplication and generation logic. Fresh socket snapshots take priority over the slower HTTP presentation callback for one second; disconnected streams return to the existing polling path. The menu still polls, and battle commands remain transactional HTTP. This is current encounter replication, not autonomous creature simulation.
