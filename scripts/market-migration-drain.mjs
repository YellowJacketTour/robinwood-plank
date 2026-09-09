import { Pool } from 'pg';

// Only market relations covered by this rollout. Never terminate unrelated
// application sessions, other database roles, or readers that do not block DDL.
const RELATIONS = ['plank_collection_tokens','plank_collection_token_projections',
  'plank_foreign_rarity_tokens','plank_foreign_rarity_collections','plank_collection_cells',
  'plank_market_live_orders','plank_market_events','plank_multichain_collections','plank_multichain_snapshots'];

export async function withMarketMigrationDrain(client, poolOptions, operation, { graceMs = 30_000, intervalMs = 2_000, log = console.log } = {}) {
  const observer = new Pool({ ...poolOptions, max: 1, statement_timeout: 5_000,
    application_name: 'plank-market-migration-drain' });
  const migrationPid = client.processID;
  let stopped = false;
  let timer;
  let checking = Promise.resolve();
  const inspect = async () => {
    if (stopped) return;
    try {
      const result = await observer.query(`
        SELECT a.pid, a.state, pg_terminate_backend(a.pid) AS terminated
        FROM pg_stat_activity a
        WHERE a.pid = ANY(pg_blocking_pids($1))
          AND a.datname = current_database() AND a.usename = current_user
          AND a.pid <> pg_backend_pid() AND a.pid <> $1
          AND a.xact_start < clock_timestamp() - ($2::double precision * INTERVAL '1 millisecond')
          AND EXISTS (
            SELECT 1 FROM pg_locks waiting
            JOIN pg_class relation ON relation.oid = waiting.relation
            JOIN pg_namespace ns ON ns.oid = relation.relnamespace
            WHERE waiting.pid = $1 AND NOT waiting.granted
              AND ns.nspname = 'public' AND relation.relname = ANY($3::text[])
          )`, [migrationPid, graceMs, RELATIONS]);
      for (const row of result.rows) log(`[migration-drain] blocker pid=${row.pid} state=${row.state} rolled_back=${row.terminated}`);
    } catch (error) {
      log(`[migration-drain] inspection failed code=${error?.code ?? 'unknown'}`);
    } finally {
      if (!stopped) timer = setTimeout(() => { checking = inspect(); }, intervalMs);
    }
  };
  timer = setTimeout(() => { checking = inspect(); }, graceMs);
  try { return await operation(); }
  finally { stopped = true; clearTimeout(timer); await checking; await observer.end(); }
}
