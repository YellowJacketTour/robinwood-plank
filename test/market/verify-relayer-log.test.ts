import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const verifier = path.resolve("scripts/verify-relayer-log.mjs");
const vaults = [
  {
    vault: "0xc4b29d7a01603d2a5937b1fc86ea85e488d72e04",
    state: "idle",
    actionable: false,
  },
  {
    vault: "0xb2019fd4ca24502e812c0c73b751fa49979bf708",
    state: "idle",
    actionable: false,
  },
];

test("relayer log verifier accepts a recent two-vault success", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "plank-relayer-log-"));
  try {
    const log = path.join(directory, "relayer.log");
    await writeFile(
      log,
      `RELAYER_STATUS=${JSON.stringify({
        timestamp: new Date().toISOString(),
        vaults,
      })}\n`
    );
    const { stdout } = await execFileAsync(process.execPath, [
      verifier,
      "--require-hours=0",
      "--max-age-minutes=10",
      log,
    ]);
    assert.match(stdout, /RELAYER_LOG_VERIFICATION=.*"status":"ok"/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("relayer log verifier rejects an actionable vault status", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "plank-relayer-log-"));
  try {
    const log = path.join(directory, "relayer.log");
    await writeFile(
      log,
      `RELAYER_STATUS=${JSON.stringify({
        timestamp: new Date().toISOString(),
        vaults: [{ ...vaults[0], state: "error", actionable: true }, vaults[1]],
      })}\n`
    );
    await assert.rejects(
      execFileAsync(process.execPath, [
        verifier,
        "--require-hours=0",
        "--max-age-minutes=10",
        log,
      ]),
      /actionable\/error vault status/
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
