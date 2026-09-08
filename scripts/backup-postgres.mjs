import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";

function required(name) {
  const raw = process.env[name];
  const value = name === "PGPASSWORD" ? raw : raw?.trim();
  if (!value) throw new Error(`Missing ${name}.`);
  return value;
}

function safeTimestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

async function main() {
  const backupDir = path.resolve(required("PLANK_BACKUP_DIR"));
  const appDir = path.resolve(required("INMOTION_APP_DIR"));
  const allowedRoot = path.join(appDir, "shared", "backups");
  if (
    backupDir !== allowedRoot &&
    !backupDir.startsWith(`${allowedRoot}${path.sep}`)
  ) {
    throw new Error(`Backup directory must stay inside ${allowedRoot}.`);
  }

  await fs.mkdir(backupDir, { recursive: true, mode: 0o700 });
  await fs.chmod(backupDir, 0o700);
  // Label lets the same script serve both callers: the pre-migration backup
  // every deploy takes, and the one-off pre-cutover backup.
  const label = (process.env.PLANK_BACKUP_LABEL || "postgres").replace(/[^a-zA-Z0-9._-]/g, "");
  const output = path.join(backupDir, `${label}-${safeTimestamp()}.dump`);

  const args = [
    "--format=custom",
    // Compression 1, not the zlib default of 6.
    //
    // MEASURED 2026-09-08: a pre-migration backup on this database took 97
    // minutes against a pipeline comment that says "40+". Every deploy that
    // carries a migration pays it, and two migrations in a row pay it twice,
    // serialized -- three hours of wall clock for 13 lines of DDL.
    //
    // pg_dump --format=custom is single-threaded and cannot use --jobs (that
    // needs --format=directory, which changes the output shape and the
    // restore command, so it is not a safe drive-by change). Compression
    // level IS safe: identical format, identical `pg_restore` invocation,
    // only the CPU spent squeezing bytes changes. Level 1 typically runs
    // 2-4x faster than 6 for maybe 10-20% more disk on a database that is
    // mostly jsonb and text.
    //
    // Disk is cheap here and bounded: PLANK_BACKUP_KEEP=14 prunes old dumps.
    // A backup that takes 97 minutes is a backup people are tempted to skip,
    // and a skipped backup is worth far less than a slightly larger one.
    "--compress=1",
    "--no-owner",
    "--no-privileges",
    "--host",
    required("PGHOST"),
    "--port",
    process.env.PGPORT?.trim() || "5432",
    "--username",
    required("PGUSER"),
    "--dbname",
    required("PGDATABASE"),
    "--file",
    output,
  ];

  await new Promise((resolve, reject) => {
    const child = spawn("pg_dump", args, {
      env: process.env,
      stdio: ["ignore", "inherit", "inherit"],
      windowsHide: true,
    });
    const heartbeat = setInterval(() => {
      console.error("[postgres-backup] pg_dump is still running");
    }, 30_000);
    heartbeat.unref();
    child.once("close", () => clearInterval(heartbeat));
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`pg_dump failed (${signal || `exit ${code}`}).`));
    });
  });

  await fs.chmod(output, 0o600);
  const stat = await fs.stat(output);
  if (stat.size === 0) throw new Error("pg_dump created an empty backup.");
  console.log(`POSTGRES_BACKUP=${output} (${stat.size} bytes)`);

  // Retention: keep the newest N dumps for this label so shared hosting
  // doesn't fill up. Deletes only files this script's own naming produces.
  const keep = Math.max(1, Number(process.env.PLANK_BACKUP_KEEP || 10) || 10);
  const entries = (await fs.readdir(backupDir))
    .filter((f) => f.startsWith(`${label}-`) && f.endsWith(".dump"))
    .sort()
    .reverse();
  for (const stale of entries.slice(keep)) {
    await fs.rm(path.join(backupDir, stale), { force: true });
    console.log(`POSTGRES_BACKUP_PRUNED=${stale}`);
  }
}

main().catch((error) => {
  console.error(`[postgres-backup] ${error.message}`);
  process.exitCode = 1;
});
