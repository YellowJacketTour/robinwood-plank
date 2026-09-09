import { promises as fs } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

const exec = promisify(execFile);
const MAX_AGE_MS = 2 * 60 * 60_000;

export async function verifyRecoveryBackup({ appDir, backupName, expectedBytes, baseRelease, databaseName, now = Date.now(), inspectArchive }) {
  const match = /^predeploy-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z\.dump$/.exec(backupName ?? "");
  if (!match || !/^[1-9]\d*$/.test(expectedBytes ?? "") || !/^[a-f0-9]{40}$/.test(baseRelease ?? "")) {
    throw new Error("Recovery requires an exact backup basename, successful-run byte count and base release SHA.");
  }
  const started = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5]), Number(match[6]), Number(match[7]));
  if (started > now || now - started > MAX_AGE_MS) throw new Error("Recovery backup must have started within the last two hours.");
  const root = await fs.realpath(path.join(appDir, "shared", "backups"));
  const file = path.join(root, backupName);
  const stat = await fs.lstat(file, { bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== BigInt(expectedBytes) || stat.size < 5n) {
    throw new Error("Recovery backup is not the exact completed regular file.");
  }
  const current = await fs.realpath(path.join(appDir, "current"));
  if (path.basename(current) !== baseRelease || path.dirname(current) !== await fs.realpath(path.join(appDir, "releases"))) {
    throw new Error("The active release changed since the failed migration; take a fresh backup.");
  }
  const handle = await fs.open(file, "r");
  try {
    const header = Buffer.alloc(5);
    await handle.read(header, 0, 5, 0);
    if (header.toString() !== "PGDMP") throw new Error("Recovery file is not a custom PostgreSQL archive.");
  } finally { await handle.close(); }
  const toc = inspectArchive
    ? await inspectArchive(file)
    : (await exec("pg_restore", ["--list", file], { maxBuffer: 64 * 1024 * 1024, timeout: 60_000, windowsHide: true })).stdout;
  const db = /^;\s*dbname:\s*(.+)$/mi.exec(toc)?.[1]?.trim();
  if (!databaseName || db !== databaseName.trim()) throw new Error("Recovery archive database does not match the deployment database.");
  return { bytes: stat.size.toString(), ageMs: now - started };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  verifyRecoveryBackup({ appDir: process.argv[2], backupName: process.argv[3], expectedBytes: process.argv[4], baseRelease: process.argv[5], databaseName: process.env.PGDATABASE })
    .then(result => console.log(`[postgres-backup] verified completed recovery archive (${result.bytes} bytes; age ${Math.round(result.ageMs / 60_000)} minutes)`))
    .catch(error => { console.error(`[postgres-backup] ${error.message}`); process.exitCode = 1; });
}
