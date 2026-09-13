type Environment = Record<string, string | undefined>;
export const LOCAL_RUNTIME_FIXTURE_ORIGIN = "http://localhost:3018";
export const LOCAL_RUNTIME_FIXTURE_DATABASE = "charmville_acceptance_20260913";

/** One disposable acceptance cluster only, never the general local-playtest switch. */
export function localRuntimeFixtureEnabled(env: Environment): boolean {
  return env.NODE_ENV === "development" && env.CHARMVILLE_LOCAL_RUNTIME_FIXTURE === "1" &&
    env.CHARMVILLE_ACCESS_MODE === "private" && env.PGHOST === "127.0.0.1" && env.PGPORT === "55419" &&
    env.PGUSER === "charmtest" && env.PGDATABASE === LOCAL_RUNTIME_FIXTURE_DATABASE && !!env.CHARMVILLE_RUNTIME_FIXTURE_FILE;
}
export function localRuntimeFixtureRequestAllowed(request: Request, env: Environment): boolean {
  if (!localRuntimeFixtureEnabled(env)) return false;
  try {
    const url = new URL(request.url), host = request.headers.get("host") ?? url.host;
    return request.method === "POST" && url.origin === LOCAL_RUNTIME_FIXTURE_ORIGIN && host === "localhost:3018" &&
      (!request.headers.get("x-forwarded-host") || request.headers.get("x-forwarded-host") === host) &&
      request.headers.get("origin") === LOCAL_RUNTIME_FIXTURE_ORIGIN &&
      (!request.headers.get("sec-fetch-site") || request.headers.get("sec-fetch-site") === "same-origin");
  } catch { return false; }
}
