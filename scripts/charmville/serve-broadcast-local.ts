import {Pool} from 'pg';
import {broadcastAuthority} from '../../lib/charmville/broadcast-authority';
import {homeActor} from '../../lib/charmville/home-access-store';
import {startBroadcastGateway} from '../../lib/charmville/broadcast-gateway';

async function main() {
  if (process.env.NODE_ENV === 'production' || process.env.CHARMVILLE_LOCAL_BROADCAST !== '1') throw Error('Explicit local broadcast development mode required');
  if (!['127.0.0.1', 'localhost', '::1'].includes(process.env.PGHOST ?? '')) throw Error('A loopback PostgreSQL database is required');
  const origins = (process.env.CHARMVILLE_BROADCAST_ORIGINS ?? 'http://localhost:3018').split(',');
  const port = Number(process.env.CHARMVILLE_BROADCAST_PORT ?? 3025);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw Error('Invalid local signaling port');
  const pool = new Pool({max: 8, connectionTimeoutMillis: 3000, query_timeout: 5000, statement_timeout: 5000});
  try {
    const gateway = await startBroadcastGateway({origins, port,
      authenticate: async token => {
        const client = await pool.connect();
        try {await client.query('BEGIN'); const profileId = await homeActor(client, token); await client.query('COMMIT'); return profileId;}
        catch (error) {await client.query('ROLLBACK'); throw error;} finally {client.release();}
      },
      resolve: (token, ownerId) => broadcastAuthority(pool, token, ownerId),
    });
    console.log(`Local authenticated signaling ready at ${gateway.url}. P2P media is not a revocable privacy relay.`);
    let closing = false;
    const stop = async () => {if (closing) return; closing = true; await gateway.close(); await pool.end();};
    process.once('SIGINT', () => {void stop();}); process.once('SIGTERM', () => {void stop();});
  } catch (error) {await pool.end(); throw error;}
}
void main().catch(() => {console.error('Local broadcast gateway failed. Check local admission and database configuration.'); process.exitCode = 1;});
