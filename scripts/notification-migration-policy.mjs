import { createHash } from 'node:crypto';

export const OPTIONAL_NOTIFICATION_MIGRATION = '110_market_change_notifications.sql';
const REVIEWED_SQL_SHA256 = '16f5e33aa8f6173bfd44547f8fc774ab5d33fd660c69f1cf18e827bf45027494';

/** Only this reviewed, data-independent trigger installation can be deferred.
 * The migration remains pending and the feed explicitly uses periodic resync. */
export function notificationDeferralCandidate(enabled, file, sql) {
  return enabled === true && file === OPTIONAL_NOTIFICATION_MIGRATION &&
    createHash('sha256').update(sql.replace(/\r\n/g, '\n')).digest('hex') === REVIEWED_SQL_SHA256;
}

export async function canDeferNotificationLock(client, candidate, error) {
  if (!candidate || error?.code !== '55P03') return false;
  const result = await client.query(`SELECT EXISTS (
    SELECT 1 FROM pg_locks l JOIN pg_class c ON c.oid=l.relation
    JOIN pg_namespace n ON n.oid=c.relnamespace
    JOIN pg_stat_activity a ON a.pid=l.pid
    WHERE n.nspname='public' AND c.relname='plank_market_events'
      AND l.granted AND l.mode='ShareUpdateExclusiveLock'
      AND a.datname=current_database() AND a.usename<>current_user
  ) AS blocked`);
  return result.rows[0]?.blocked === true;
}
