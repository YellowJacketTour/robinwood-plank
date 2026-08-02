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
