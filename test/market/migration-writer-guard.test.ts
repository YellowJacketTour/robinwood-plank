import assert from "node:assert/strict";
import test from "node:test";
import { promises as fs } from "node:fs";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile);

test("migration guard stops owned writers, excludes cron restarts and releases locks after failure", { skip: process.platform !== "linux", timeout: 30_000 }, async () => {
  const work = path.resolve("work");
  await fs.mkdir(work, { recursive: true });
  const appDir = await fs.mkdtemp(path.join(work, "writer-guard-"));
  const scripts = ["mesh-tick-standalone.mjs", "opensea-stream-standalone.mjs", "market-realtime.mjs", "akasha-hose-standalone.mjs"];
  const locks = ["market-mesh.lock", "opensea-stream.lock", "market-realtime.lock", "akasha-hose.lock"].map(name => path.join(appDir, "shared", name));
  const children: ReturnType<typeof spawn>[] = [];
  try {
    await fs.mkdir(path.join(appDir, "current", "scripts"), { recursive: true });
    await fs.mkdir(path.join(appDir, "shared"), { recursive: true });
    for (let i = 0; i < scripts.length; i++) {
      const script = path.join(appDir, "current", "scripts", scripts[i]);
      const ready = path.join(appDir, `ready-${i}`);
      await fs.writeFile(script, "import {writeFileSync} from 'node:fs'; writeFileSync(process.argv[2], 'ready'); setTimeout(() => {}, 15000);");
      // A managed worker may use a cwd-relative path. Its identity remains
      // this deployment even when ps display output is narrow.
      children.push(spawn("flock", ["-n", locks[i], process.execPath, i === 0 ? `scripts/${scripts[i]}` : script, ready], { stdio: "ignore", cwd: path.join(appDir, "current") }));
      let held = false;
      for (let attempt = 0; attempt < 100 && !held; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 20));
        // Readiness happens inside flock's child, after ownership. Probing
        // with another flock first could steal the fixture's initial lock.
        try { await fs.access(ready); held = true; } catch { /* starting */ }
      }
      assert.ok(held, "fixture writer must own the cron lock");
    }
    const action = path.join(appDir, "verify.mjs");
    await fs.writeFile(action, `import {spawnSync} from 'node:child_process'; for(const lock of process.argv.slice(2)) { if(spawnSync('flock',['-n',lock,'true']).status!==1) process.exit(99); } process.exit(17);`);
    await assert.rejects(exec("bash", [path.resolve("scripts/guard-market-migration.sh"), appDir, process.execPath, action, ...locks]), (error: unknown) => (error as { code?: number }).code === 17);
    for (const lock of locks) await exec("flock", ["-n", lock, "true"]);
  } finally {
    for (const child of children) child.kill();
    assert.ok(appDir.startsWith(work + path.sep));
    await fs.rm(appDir, { recursive: true, force: true });
  }
});
