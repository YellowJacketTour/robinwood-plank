import { createHash } from 'node:crypto';

export const OPTIONAL_NOTIFICATION_MIGRATION = '110_market_change_notifications.sql';

/** Migrations the runner may report PENDING instead of failing when another
 * role holds plank_market_events in SHARE UPDATE EXCLUSIVE mode (notification
 * maintenance). Every entry is reviewed, additive, data-independent, and
 * pinned to the sha256 of its exact text: nothing else can be deferred, and an
 * edit to a listed file un-lists it until the hash is re-reviewed.
 *
 *  110  trigger installation -- delivery uses periodic resync until it lands
 *  149  sort-covering feed indexes on plank_market_events -- the activity
 *       feed's two market_events branches sort instead of seek until it lands
 */
export const OPTIONAL_LOCKED_TABLE_MIGRATIONS = Object.freeze({
  [OPTIONAL_NOTIFICATION_MIGRATION]: '16f5e33aa8f6173bfd44547f8fc774ab5d33fd660c69f1cf18e827bf45027494',
  '149_market_events_feed_indexes.sql': '6eba9a3117ff6e7347eca7f93d4325e17068c06273c2376dfba0a5e843cdf47c',
});

export function isOptionalLockedTableMigration(file) {
  return Object.prototype.hasOwnProperty.call(OPTIONAL_LOCKED_TABLE_MIGRATIONS, file);
}

/** Only a reviewed, data-independent migration on the maintenance-locked
 * table can be deferred, and only when its text is exactly the reviewed text. */
export function notificationDeferralCandidate(enabled, file, sql) {
  return enabled === true && isOptionalLockedTableMigration(file) &&
    createHash('sha256').update(sql.replace(/\r\n/g, '\n')).digest('hex') === OPTIONAL_LOCKED_TABLE_MIGRATIONS[file];
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
