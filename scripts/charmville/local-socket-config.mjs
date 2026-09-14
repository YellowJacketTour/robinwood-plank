/** Loopback-only developer gateway configuration; never a public deploy target. */
export function localSocketConfig(env = process.env) {
 const upstream = new URL(env.CHARMVILLE_LOCAL_UPSTREAM || 'http://localhost:3017');
 if (upstream.protocol !== 'http:' || !['localhost','127.0.0.1'].includes(upstream.hostname) || upstream.username || upstream.password || upstream.pathname !== '/' || upstream.search || upstream.hash) throw Error('Choose a loopback HTTP application origin.');
 const raw = env.CHARMVILLE_LOCAL_SOCKET_PORT || '3023';
 if (!/^\d{4,5}$/.test(raw) || Number(raw) > 65535 || Number(raw) < 1024) throw Error('Choose a valid local socket port.');
 const port=Number(raw);
 if (String(port) === upstream.port) throw Error('Game and socket ports must differ.');
 return {upstream:upstream.origin,port,origins:new Set([`http://localhost:${upstream.port || '80'}`,`http://127.0.0.1:${upstream.port || '80'}`].map(origin=>new URL(origin).origin))};
}
