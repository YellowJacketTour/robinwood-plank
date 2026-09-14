import {randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {WebSocket, WebSocketServer} from 'ws';
import {createBroadcastProtocol} from './broadcast-protocol';
import type {BroadcastAuthority} from './broadcast-session';

type Connection = {socket: WebSocket; token: string; profileId: string; revision: string; closed: boolean; authenticating: boolean; allowance: number; lastRefill: number; refreshBusy: boolean; closeProtocol: () => void; deadline: ReturnType<typeof setTimeout>};
export type BroadcastGatewayOptions = {
  origins: readonly string[];
  authenticate: (token: string) => Promise<string>;
  resolve: (token: string, ownerId: string) => Promise<BroadcastAuthority>;
  port?: number;
  maxConnections?: number;
  authTimeoutMs?: number;
  refreshMs?: number;
};

/** Development signaling only. Media travels peer-to-peer and cannot be revoked
 * against an uncooperative peer by this server. Never use as a privacy relay. */
export async function startBroadcastGateway(options: BroadcastGatewayOptions) {
  const origins = new Set(options.origins);
  if (!origins.size || [...origins].some(origin => {
    try {const url = new URL(origin); return !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.origin !== origin || !['http:', 'https:'].includes(url.protocol);} catch {return true;}
  })) throw Error('Only explicit loopback browser origins are supported');
  const maxConnections = options.maxConnections ?? 32;
  const authTimeout = options.authTimeoutMs ?? 5000;
  const refreshMs = options.refreshMs ?? 3000;
  if (!Number.isInteger(maxConnections) || maxConnections < 1 || maxConnections > 128 || authTimeout < 100 || authTimeout > 10000 || refreshMs < 100 || refreshMs > 5000) throw Error('Invalid gateway bounds');
  const connections = new Map<string, Connection>();
  const server = createServer((_request, response) => {response.writeHead(404, {'Cache-Control': 'no-store'}); response.end();});
  const sockets = new WebSocketServer({noServer: true, maxPayload: 40960, perMessageDeflate: false});
  function send(id: string, message: object) {
    const connection = connections.get(id);
    if (!connection || connection.closed || connection.socket.readyState !== WebSocket.OPEN) return;
    if (connection.socket.bufferedAmount > 131072) {connection.socket.close(1013, 'Slow signaling consumer'); return;}
    connection.socket.send(JSON.stringify(message), error => {if (error) connection.socket.terminate();});
  }
  const protocol = createBroadcastProtocol({
    resolve: async (connectionId, ownerId) => {
      const connection = connections.get(connectionId);
      if (!connection?.token || connection.closed) throw Error('Authentication required');
      const authority = await options.resolve(connection.token, ownerId);
      if (connection.closed || authority.profileId !== connection.profileId) throw Error('Session changed');
      return authority;
    },
    send, id: randomUUID, now: Date.now,
    disconnect: (connectionId, publicationId) => send(connectionId, {type: 'broadcast:ended', publicationId}),
    maxPublications: maxConnections, maxViewers: maxConnections, leaseMs: 15000,
  });
  server.on('upgrade', (request, socket, head) => {
    if (request.url !== '/broadcast' || !origins.has(request.headers.origin ?? '') || connections.size >= maxConnections) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return;
    }
    sockets.handleUpgrade(request, socket, head, websocket => sockets.emit('connection', websocket));
  });
  sockets.on('connection', socket => {
    const id = randomUUID();
    const handle = protocol.connect(id);
    const connection: Connection = {socket, token: '', profileId: '', revision: '', closed: false, authenticating: false, allowance: 60, lastRefill: Date.now(), refreshBusy: false, closeProtocol: handle.close, deadline: setTimeout(() => socket.close(1008, 'Authentication timeout'), authTimeout)};
    connections.set(id, connection);
    const cleanup = () => {
      if (connection.closed) return;
      connection.closed = true; clearTimeout(connection.deadline); connection.token = '';
      handle.close(); connections.delete(id);
    };
    socket.on('close', cleanup);
    socket.on('error', () => {cleanup(); socket.terminate();});
    socket.on('message', async (data, binary) => {
      const now = Date.now();
      connection.allowance = Math.min(60, connection.allowance + (now - connection.lastRefill) * .03); connection.lastRefill = now;
      if (connection.closed || binary || connection.allowance < 1) {socket.close(1008, 'Invalid signaling rate or encoding'); return;}
      connection.allowance--;
      let message: Record<string, unknown>;
      try {const value = JSON.parse(data.toString()); if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error(); message = value;} catch {socket.close(1008, 'Invalid JSON command'); return;}
      if (!connection.token) {
        if (connection.authenticating || Object.keys(message).length !== 2 || message.type !== 'authenticate' || typeof message.token !== 'string' || !/^[a-f0-9]{64}$/i.test(message.token)) {socket.close(1008, 'Authentication required'); return;}
        connection.authenticating = true;
        try {
          const token = message.token;
          const profileId = await options.authenticate(token);
          const authority = await options.resolve(token, profileId);
          if (connection.closed || socket.readyState !== WebSocket.OPEN) return;
          if (!/^[1-9]\d{0,17}$/.test(profileId) || authority.profileId !== profileId || authority.ownerId !== profileId) throw Error('Invalid identity');
          connection.token = token; connection.profileId = profileId; connection.revision = authority.revision;
          clearTimeout(connection.deadline); send(id, {type: 'broadcast:ready', connectionId: id, profileId, media: 'development-peer-to-peer'});
        } catch {socket.close(1008, 'Admission required');} finally {connection.authenticating = false;}
        return;
      }
      if (message.type === 'authenticate') {socket.close(1008, 'Connection identity is fixed'); return;}
      await handle.receive(message);
    });
  });
  const refresh = setInterval(() => {
    protocol.sweep();
    for (const connection of connections.values()) {
      if (!connection.token || connection.closed || connection.refreshBusy) continue;
      connection.refreshBusy = true;
      void options.resolve(connection.token, connection.profileId).then(authority => {
        if (connection.closed) return;
        if (authority.profileId !== connection.profileId) throw Error('Session changed');
        if (authority.revision !== connection.revision) {protocol.revokeOwner(connection.profileId); connection.revision = authority.revision;}
      }).catch(() => connection.socket.close(1008, 'Admission expired')).finally(() => {connection.refreshBusy = false;});
    }
  }, refreshMs);
  refresh.unref();
  await new Promise<void>((resolve, reject) => {server.once('error', reject); server.listen(options.port ?? 3025, '127.0.0.1', () => {server.removeListener('error', reject); resolve();});});
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('Missing loopback address');
  return {
    url: `ws://127.0.0.1:${address.port}/broadcast`,
    revokeOwner: protocol.revokeOwner,
    async close() {
      clearInterval(refresh);
      for (const connection of connections.values()) {clearTimeout(connection.deadline); connection.closeProtocol(); connection.token = ''; connection.socket.terminate();}
      await new Promise<void>(resolve => sockets.close(() => resolve()));
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}
