import assert from "node:assert/strict";
import test from "node:test";
import { promises as fs } from "node:fs";
import path from "node:path";
import { verifyRecoveryBackup } from "../../scripts/verify-recovery-backup.mjs";

test("recovery accepts only the exact recent completed archive for the unchanged release and database", async () => {
  const work = path.resolve("work");
  await fs.mkdir(work, { recursive: true });
  const appDir = await fs.mkdtemp(path.join(work, "backup-validation-"));
  const baseRelease = "a".repeat(40);
  const now = Date.now();
  const stamp = new Date(now - 60_000).toISOString().replace(/[:.]/g, "-");
  const backupName = `predeploy-${stamp}.dump`;
  const backupDir = path.join(appDir, "shared", "backups");
  try {
    await fs.mkdir(backupDir, { recursive: true });
    await fs.mkdir(path.join(appDir, "releases", baseRelease), { recursive: true });
    await fs.symlink(path.join(appDir, "releases", baseRelease), path.join(appDir, "current"), process.platform === "win32" ? "junction" : "dir");
    await fs.writeFile(path.join(backupDir, backupName), "PGDMPtest");
    const input = { appDir, backupName, expectedBytes: "9", baseRelease, databaseName: "mesh_test", now, inspectArchive: async () => ";     dbname: mesh_test\n" };
    assert.equal((await verifyRecoveryBackup(input)).bytes, "9");
    await assert.rejects(verifyRecoveryBackup({ ...input, expectedBytes: "8" }), /exact completed/);
    await assert.rejects(verifyRecoveryBackup({ ...input, baseRelease: "b".repeat(40) }), /active release changed/);
    await assert.rejects(verifyRecoveryBackup({ ...input, databaseName: "another_db" }), /database does not match/);
    await assert.rejects(verifyRecoveryBackup({ ...input, now: now + 2 * 60 * 60_000 }), /two hours/);
    await assert.rejects(verifyRecoveryBackup({ ...input, backupName: `../${backupName}` }), /exact backup basename/);
    await assert.rejects(verifyRecoveryBackup({ ...input, inspectArchive: async () => { throw new Error("invalid archive"); } }), /invalid archive/);
    await fs.writeFile(path.join(backupDir, backupName), "bad!!test");
    await assert.rejects(verifyRecoveryBackup(input), /exact completed|custom PostgreSQL archive/);
  } finally {
    assert.ok(appDir.startsWith(work + path.sep));
    await fs.rm(appDir, { recursive: true, force: true });
  }
});
