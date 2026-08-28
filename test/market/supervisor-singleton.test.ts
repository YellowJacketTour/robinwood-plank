import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// Git Bash is required on Windows because the supervisors run in its MSYS
// process namespace. CI runs on Linux, where the native bash is the correct
// interpreter. A Windows-only absolute path made every Linux assertion test
// the spawn error's empty output instead of the guard itself.
const BASH = process.platform === "win32" ? "C:\\Program Files\\Git\\bin\\bash.exe" : "/bin/bash";
const GUARD = join(process.cwd(), "scripts/_supervisor-singleton.sh").replace(/\\/g, "/");

const supervisors = [
  "refresh-market-data-supervisor.sh",
  "other-chains-discovery-supervisor.sh",
  "evm-hypersync-backfill-supervisor.sh",
  "genesis-seaport-backfill-supervisor.sh",
  "coingecko-nft-stats-sync-supervisor.sh",
  "opensea-stats-sync-supervisor.sh",
  "mesh-tick-supervisor.sh",
];

test("every continuous local supervisor enforces its own singleton", () => {
  for (const file of supervisors) {
    const source = readFileSync(new URL(`../../scripts/${file}`, import.meta.url), "utf8");
    assert.match(source, /source scripts\/_supervisor-singleton\.sh/, `${file} must load the shared guard`);
    assert.match(source, /supervisor_singleton "/, `${file} must acquire a named singleton lock`);
    assert.match(source, /supervisor_run node --import tsx /, `${file} must use the bounded direct-Node launcher`);
    assert.doesNotMatch(source, /\bnpx tsx\b/, `${file} must not recreate the npx/cmd/tsx wrapper tree`);
  }
});

function runGuard(script: string): { code: number; out: string } {
  try {
    const out = execFileSync(
      BASH,
      ["-c", `source "${GUARD}"; ${script}`],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
    );
    return { code: 0, out };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

test("a lock held by a dead PID is reclaimed, not refused", () => {
  const lockRoot = mkdtempSync(join(tmpdir(), "plank-lock-test-"));
  try {
    // 999999 is not a real PID on this machine.
    const r = runGuard(
      `mkdir -p "${lockRoot}/dead-owner.lock"; echo 999999 > "${lockRoot}/dead-owner.lock/pid"; echo bogus > "${lockRoot}/dead-owner.lock/stime"; SUPERVISOR_LOCK_ROOT="${lockRoot}" supervisor_singleton "dead-owner"; echo ACQUIRED`
    );
    assert.match(r.out, /ACQUIRED/, "a lock from a nonexistent PID must be reclaimable");
  } finally {
    rmSync(lockRoot, { recursive: true, force: true });
  }
});

test("a lock whose recorded fingerprint no longer matches the live PID is reclaimed", () => {
  const lockRoot = mkdtempSync(join(tmpdir(), "plank-lock-test-"));
  try {
    // Use this test process's own real, live PID, but store a start-time
    // fingerprint that cannot match it -- simulates the recycled-PID case
    // where the number is alive but belongs to a different process.
    const r = runGuard(
      `mkdir -p "${lockRoot}/recycled.lock"; echo $$ > "${lockRoot}/recycled.lock/pid"; echo "99:99:99" > "${lockRoot}/recycled.lock/stime"; SUPERVISOR_LOCK_ROOT="${lockRoot}" supervisor_singleton "recycled"; echo ACQUIRED`
    );
    assert.match(r.out, /ACQUIRED/, "a fingerprint mismatch must be treated as a stale/recycled owner, not a live one");
  } finally {
    rmSync(lockRoot, { recursive: true, force: true });
  }
});

test("a lock whose fingerprint matches a genuinely live PID is refused, never reclaimed", () => {
  // The background process must be spawned from inside the same bash so its
  // PID lives in MSYS PID space -- a PID handed back by Node's own spawn()
  // is a Windows PID, a different numbering space that `ps -p` here can
  // never resolve, which would make this test fail for a reason that has
  // nothing to do with the guard's real logic.
  const lockRoot = mkdtempSync(join(tmpdir(), "plank-lock-test-"));
  try {
    const r = runGuard(
      `sleep 30 >/dev/null 2>&1 & CHILD=$!; FP=$(_supervisor_fingerprint "$CHILD"); mkdir -p "${lockRoot}/live.lock"; echo "$CHILD" > "${lockRoot}/live.lock/pid"; echo "$FP" > "${lockRoot}/live.lock/stime"; SUPERVISOR_LOCK_ROOT="${lockRoot}" supervisor_singleton "live"; echo ACQUIRED; kill "$CHILD" 2>/dev/null`
    );
    assert.doesNotMatch(r.out, /ACQUIRED/, "a genuinely live, fingerprint-matching owner must never be reclaimed");
    assert.match(r.out, /already running/, "must report the real reason for refusal");
  } finally {
    rmSync(lockRoot, { recursive: true, force: true });
  }
});

