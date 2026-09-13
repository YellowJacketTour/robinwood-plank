import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

export type RuntimeRoots = Record<'repo' | 'runtime' | 'content' | 'sprite', string>;
type Entry = { root: keyof RuntimeRoots; path: string; route: string; bytes: number; sha256: string };
export class RuntimeArtifactError extends Error {
  constructor(public readonly status: 404 | 405 | 503) { super('Runtime artifact unavailable'); }
}
const fail = (): never => { throw new RuntimeArtifactError(503); };
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
  return value as Record<string, unknown>;
};
function segments(value: string) {
  if (!value || value.includes('\\') || value.includes('%') || value.includes(':') || /[\x00-\x20?#]/.test(value)) return fail();
  const parts = value.split('/');
  if (parts.some(part => !part || part === '.' || part === '..')) return fail();
  return parts;
}
function entriesOf(manifest: unknown): Entry[] {
  const data = record(manifest);
  if (data.schemaVersion !== 1 || data.scope !== 'joined-homestead-private-inventory' || data.completeInventory !== true || !Array.isArray(data.files) || !Array.isArray(data.issues) || data.issues.length) return fail();
  const entries: Entry[] = [], routes = new Set<string>();
  for (const value of data.files) {
    const item = record(value);
    if (item.status !== 'present') return fail();
    if (item.role !== 'served') continue;
    if (!['repo', 'runtime', 'content', 'sprite'].includes(String(item.root)) || typeof item.path !== 'string' || typeof item.route !== 'string' || !item.route.startsWith('/') || !Number.isSafeInteger(item.bytes) || Number(item.bytes) < 0 || typeof item.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(item.sha256)) return fail();
    segments(item.path);
    // /play/ is the only directory-shaped served route in the inventory.
    segments(item.route === '/play/' ? 'play' : item.route.slice(1));
    if (routes.has(item.route)) return fail();
    routes.add(item.route);
    entries.push(item as unknown as Entry);
  }
  return entries;
}
const mime: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json', '.wasm': 'application/wasm', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.ico': 'image/x-icon', '.ogg': 'audio/ogg' };

/** Call only AFTER session/admission checks, including for HEAD. No auth, route,
 * conditional response or Range support is provided here. Inputs describe original
 * inventory bytes: transformed HTML/main.js require a separately verified package.
 * Roots must be immutable, operator-owned release directories, not writable by users.
 */
export async function openRuntimeArtifact(input: {
  manifest: unknown; roots: RuntimeRoots; configuredRelease: string; requestedRelease: string;
  route: string; method: string; signal?: AbortSignal;
}) {
  if (input.method !== 'GET' && input.method !== 'HEAD') throw new RuntimeArtifactError(405);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/.test(input.configuredRelease)) return fail();
  if (input.requestedRelease !== input.configuredRelease) throw new RuntimeArtifactError(404);
  const entry = entriesOf(input.manifest).find(item => item.route === input.route);
  if (!entry) throw new RuntimeArtifactError(404);
  input.signal?.throwIfAborted();
  try {
    const root = path.resolve(input.roots[entry.root]);
    // Reject links in every path component, including configured root ancestors.
    const absolute = path.join(root, ...segments(entry.path));
    let cursor = path.parse(absolute).root;
    for (const component of absolute.slice(cursor.length).split(path.sep)) {
      cursor = path.join(cursor, component);
      if ((await lstat(cursor)).isSymbolicLink()) return fail();
    }
    const resolvedRoot = await realpath(root), resolved = await realpath(absolute);
    const relative = path.relative(resolvedRoot, resolved);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return fail();
    const before = await lstat(resolved);
    if (!before.isFile()) return fail();
    const handle = await open(resolved, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.size !== entry.bytes || opened.dev !== before.dev || opened.ino !== before.ino) return fail();
      // Integrity first; streaming hash keeps large WASM out of JS buffers. The
      // same descriptor supplies the response, avoiding path reopens after checks.
      const hash = createHash('sha256');
      for await (const chunk of handle.createReadStream({ start: 0, autoClose: false, signal: input.signal })) hash.update(chunk);
      if (hash.digest('hex') !== entry.sha256) return fail();
      const headers = {
        'Content-Type': mime[path.extname(entry.path)] || 'application/octet-stream',
        'Content-Length': String(entry.bytes), 'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff', 'Cross-Origin-Resource-Policy': 'same-origin',
      };
      if (input.method === 'HEAD') { await handle.close(); return { status: 200 as const, headers, body: null }; }
      return { status: 200 as const, headers, body: handle.createReadStream({ start: 0, autoClose: true, signal: input.signal }) };
    } catch (error) { await handle.close().catch(() => {}); throw error; }
  } catch (error) {
    if (error instanceof RuntimeArtifactError || input.signal?.aborted) throw error;
    return fail();
  }
}
