import {
  Pool,
  type PoolClient,
  type QueryResult,
  type QueryResultRow,
} from "pg";

/** True inside mesh-tick / mesh-lane / opensea-stream processes (in-process env or the bundle's own argv). */
function isMeshWorkerProcess(): boolean {
  if (process.env.MESH_IN_PROCESS === "1") return true;
  return process.argv.some((a) => /mesh-tick|mesh-lane|opensea-stream/.test(a));
}


type PostgresGlobal = typeof globalThis & {
  __plankPostgresPool?: Pool;
};

const REQUIRED_POSTGRES_ENV = [
  "PGHOST",
  "PGDATABASE",
  "PGUSER",
  "PGPASSWORD",
] as const;

function postgresGlobal(): PostgresGlobal {
  return globalThis as PostgresGlobal;
}

export function hasPostgresConfig(): boolean {
  return REQUIRED_POSTGRES_ENV.every((name) =>
    Boolean(process.env[name]?.trim())
  );
}

function required(name: (typeof REQUIRED_POSTGRES_ENV)[number]): string {
  const raw = process.env[name];
  const value = name === "PGPASSWORD" ? raw : raw?.trim();
  if (!value) {
    throw new Error(
      `DURABLE_KV_BACKEND=postgres requires ${REQUIRED_POSTGRES_ENV.join(", ")}.`
    );
  }
  return value;
}

function postgresPort(): number {
  const raw = process.env.PGPORT?.trim() || "5432";
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("PGPORT must be an integer between 1 and 65535.");
  }
  return port;
}

/**
 * THE CONNECTION BUDGET IS SHARED, AND NOTHING WAS DIVIDING IT.
 *
 * Measured on production 2026-09-09: the same query, `limit=40`, returned in
 * 0.15 s when asked alone and took up to 40.8 s when twelve requests ran
 * back to back. Latency did NOT scale with rows -- `limit=500` came back in
 * 0.96 s with 704 KB while `limit=40` took 3.6 s -- so it was never the query.
 * It was waiting for a connection.
 *
 * The arithmetic nobody had done:
 *
 *     PGPOOL_MAX = 12, and 12 mesh cron workers each build their own pool
 *     => up to 144 connections from background work alone
 *     ... plus the web app's pool, against a Postgres that typically
 *         allows 100.
 *
 * Every process was sized as though it were the only one. Background scans
 * and a visitor's page request compete for the same scarce thing, and the
 * visitor loses, because a mesh lane holds its connection for a long scan
 * while a page request needs one for milliseconds.
 *
 * Two changes, and the second matters more than the first.
 */
function postgresPoolMax(): number {
  const raw = process.env.PGPOOL_MAX?.trim() || "4";
  const max = Number(raw);
  if (!Number.isInteger(max) || max < 1 || max > 20) {
    throw new Error("PGPOOL_MAX must be an integer between 1 and 20.");
  }
  // A MESH WORKER TAKES A SMALLER SHARE. There are twelve of them and one
  // web app; sizing them identically is what oversubscribes the server.
  // Halved rather than minimised, because a lane starved of connections
  // simply moves the stall from the visitor to the archive.
  if (isMeshWorkerProcess()) return Math.max(2, Math.floor(max / 2));
  return max;
}

/**
 * How long a caller waits for a connection before giving up.
 *
 * A web request that waits ten seconds for a CONNECTION has already failed --
 * the visitor left. Worse, it holds a slot in Node's queue while it waits, so
 * a burst turns one slow moment into a pile-up: exactly the 3.6 s / 11.4 s /
 * 40.8 s tail measured above, where each request queued behind the last.
 *
 * Failing fast is not giving up on the request; it is refusing to convert a
 * connection shortage into a latency avalanche. A background worker, which
 * nobody is watching and which can retry a whole lane later, keeps the
 * generous wait.
 */
function connectionTimeoutMs(): number {
  return isMeshWorkerProcess() ? 10_000 : 2_000;
}

function postgresSsl(): false | { rejectUnauthorized: boolean } {
  const mode = process.env.PGSSLMODE?.trim().toLowerCase();
  if (!mode || mode === "disable") return false;
  if (mode === "require" || mode === "prefer") {
    return { rejectUnauthorized: false };
  }
  if (mode === "verify-ca" || mode === "verify-full") {
    return { rejectUnauthorized: true };
  }
  throw new Error(
    'PGSSLMODE must be "disable", "prefer", "require", "verify-ca", or "verify-full".'
  );
}

export function postgresPool(): Pool {
  const state = postgresGlobal();
  if (!state.__plankPostgresPool) {
    state.__plankPostgresPool = new Pool({
      host: required("PGHOST"),
      port: postgresPort(),
      database: required("PGDATABASE"),
      user: required("PGUSER"),
      password: required("PGPASSWORD"),
      max: postgresPoolMax(),
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: connectionTimeoutMs(),
      // Keep a warm connection so the first request after an idle period does
      // not pay TCP + TLS + auth before it can even ask a question.
      min: 1,
      // Web requests keep the 15 s guard; mesh workers run bounded but real
      // scans (HyperSync backfill windows, activity tallies) that legitimately
      // exceed it -- 2026-09-07 diagnostics: "canceling statement due to
      // statement timeout" on hypersync-backfill:base-mainnet.
      statement_timeout: isMeshWorkerProcess() ? 120_000 : 15_000,
      query_timeout: 20_000,
      application_name: "plank-love-passenger",
      ssl: postgresSsl(),
    });
    state.__plankPostgresPool.on("error", (error) => {
      console.error("[postgres] idle client error:", error);
    });
  }
  return state.__plankPostgresPool;
}

/** Close and forget the shared pool for finite-lived CLI jobs and tests. */
export async function closePostgres(): Promise<void> {
  const state = postgresGlobal();
  const pool = state.__plankPostgresPool;
  if (!pool) return;
  delete state.__plankPostgresPool;
  await pool.end();
}

export async function postgresQuery<T extends QueryResultRow = QueryResultRow>(
  text: string,
  values: readonly unknown[] = []
): Promise<QueryResult<T>> {
  return postgresPool().query<T>(text, [...values]);
}

/** Postgres error codes that mean "this transaction lost a race with another
 * one, not that anything is wrong" -- 40P01 deadlock_detected, 40001
 * serialization_failure. Both are Postgres's own documented signal that the
 * exact same transaction, retried, will very likely just succeed once the
 * competing transaction clears. */
const RETRYABLE_PG_CODES = new Set(["40P01", "40001"]);

function isRetryablePgError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error
    && RETRYABLE_PG_CODES.has(String((error as { code?: unknown }).code));
}

/**
 * Real gap found live 2026-08-27 (throughput audit: unleashing much more
 * real concurrency -- OpenSea lane count scaled to the real key pool,
 * HyperSync's anchored-membership finally getting a fair claim share --
 * surfaced genuine Postgres deadlocks between concurrent writers touching
 * overlapping cursor/membership rows). Every one of those was previously a
 * hard, unretried failure: mesh-lane.ts's own top-level catch just logged
 * "[mesh-lane] fatal deadlock detected" and exited 1, discarding a whole
 * lane's real work and forcing it to wait for its next natural re-enqueue
 * instead of simply trying again immediately, which Postgres's own docs
 * say is the correct response to exactly these two error codes. A bounded
 * retry here protects every real caller of this helper at once, not just
 * the one lane that happened to surface it first.
 */
export async function withPostgresTransaction<T>(
  run: (client: PoolClient) => Promise<T>,
  maxAttempts = 3
): Promise<T> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const client = await postgresPool().connect();
    try {
      await client.query("BEGIN");
      const result = await run(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      if (attempt < maxAttempts && isRetryablePgError(error)) {
        await new Promise((resolve) => setTimeout(resolve, 50 * attempt + Math.random() * 50));
        continue;
      }
      throw error;
    } finally {
      client.release();
    }
  }
  throw new Error("withPostgresTransaction: unreachable");
}
