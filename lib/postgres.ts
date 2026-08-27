import {
  Pool,
  type PoolClient,
  type QueryResult,
  type QueryResultRow,
} from "pg";

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

function postgresPoolMax(): number {
  const raw = process.env.PGPOOL_MAX?.trim() || "4";
  const max = Number(raw);
  if (!Number.isInteger(max) || max < 1 || max > 20) {
    throw new Error("PGPOOL_MAX must be an integer between 1 and 20.");
  }
  return max;
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
      connectionTimeoutMillis: 10_000,
      statement_timeout: 15_000,
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
