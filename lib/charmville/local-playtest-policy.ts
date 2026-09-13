type Environment = Record<string, string | undefined>;
const localHost = (value: string) => ["localhost", "127.0.0.1", "[::1]"].includes(value);

/** Deliberately unavailable in production, on a remote origin, or on an unconfirmed database. */
export function localPlaytestEnabled(env: Environment): boolean {
  if (env.NODE_ENV !== "development" || env.CHARMVILLE_LOCAL_PLAYTEST !== "1") return false;
  try {
    const test = new URL(env.CHARMVILLE_TEST_DATABASE_URL || "");
    // The isolated showcase cluster, never a developer's ordinary local database.
    if (test.port !== "55417" || decodeURIComponent(test.username) !== "charmville" || test.pathname !== "/postgres") return false;
    return ["postgres:", "postgresql:"].includes(test.protocol) && localHost(test.hostname) &&
      localHost(env.PGHOST || "") && test.hostname === env.PGHOST &&
      (test.port || "5432") === (env.PGPORT || "5432") &&
      decodeURIComponent(test.pathname.slice(1)) === env.PGDATABASE &&
      decodeURIComponent(test.username) === env.PGUSER &&
      decodeURIComponent(test.password) === env.PGPASSWORD;
  } catch { return false; }
}

export function localPlaytestRequestAllowed(request: Request, env: Environment): boolean {
  if (!localPlaytestEnabled(env)) return false;
  try {
    const url = new URL(request.url);
    const host = new URL(`${url.protocol}//${request.headers.get("host") || url.host}`);
    // Next normalizes request.url to localhost even when the browser used 127.0.0.1.
    if (!localHost(url.hostname) || !localHost(host.hostname) || host.port !== url.port) return false;
    const forwarded = request.headers.get("x-forwarded-host");
    if (forwarded && forwarded !== host.host) return false;
    return request.headers.get("origin") === host.origin &&
      (!request.headers.get("sec-fetch-site") || request.headers.get("sec-fetch-site") === "same-origin");
  } catch { return false; }
}
