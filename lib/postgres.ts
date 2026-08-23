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

function postgresConnectionString(): string | null {
  return process.env.POSTGRES_URL?.trim() || process.env.DATABASE_URL?.trim() || null;
}

function postgresGlobal(): PostgresGlobal {
  return globalThis as PostgresGlobal;
}

export function hasPostgresConfig(): boolean {
  return Boolean(postgresConnectionString()) || REQUIRED_POSTGRES_ENV.every((name) =>
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
    const connectionString = postgresConnectionString();
    state.__plankPostgresPool = new Pool({
      ...(connectionString ? { connectionString } : {
        host: required("PGHOST"),
        port: postgresPort(),
        database: required("PGDATABASE"),
        user: required("PGUSER"),
        password: required("PGPASSWORD"),
      }),
      max: postgresPoolMax(),
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
      statement_timeout: 15_000,
      query_timeout: 20_000,
      application_name: "plank-love-passenger",
      ...(connectionString ? {} : { ssl: postgresSsl() }),
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

export async function withPostgresTransaction<T>(
  run: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await postgresPool().connect();
  try {
    await client.query("BEGIN");
    const result = await run(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
