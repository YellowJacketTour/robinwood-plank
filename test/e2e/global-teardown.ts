import { execSync } from "node:child_process";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIRNAME = path.dirname(fileURLToPath(import.meta.url));
const NODE_PIDFILE = path.join(DIRNAME, ".hardhat-node.pid");
const KEEPER_PIDFILE = path.join(DIRNAME, ".casino-keeper.pid");

function killFromPidfile(pidfile: string) {
  if (!existsSync(pidfile)) return;
  const raw = readFileSync(pidfile, "utf8").trim();
  unlinkSync(pidfile);
  if (!raw) return;
  const pid = Number(raw);
  if (!Number.isInteger(pid)) return;
  // These were spawned via `npx ... --shell true`, so the tracked pid is a
  // wrapper whose actual node.exe child process.kill() alone won't reach --
  // /T kills the whole tree, matching what actually needs to die.
  try {
    execSync(`taskkill /PID ${pid} /T /F`, { stdio: "ignore" });
  } catch {
    // already gone
  }
}

export default async function globalTeardown() {
  killFromPidfile(KEEPER_PIDFILE);
  killFromPidfile(NODE_PIDFILE);
}
