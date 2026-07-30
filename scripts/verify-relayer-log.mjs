import { readFile } from "node:fs/promises";

function numberArg(name, fallback) {
  const prefix = `--${name}=`;
  const raw = process.argv.find((value) => value.startsWith(prefix));
  const value = Number(raw ? raw.slice(prefix.length) : fallback);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`--${name} must be a non-negative number.`);
  }
  return value;
}

function parsePayload(line, marker) {
  const index = line.indexOf(marker);
  if (index < 0) return null;
  try {
    return JSON.parse(line.slice(index + marker.length));
  } catch {
    throw new Error(`Invalid structured relayer log after ${marker}.`);
  }
}

async function main() {
  const logPath = process.argv
    .slice(2)
    .find((value) => !value.startsWith("--"));
  if (!logPath) throw new Error("Pass the relayer log path.");
  const requireHours = numberArg("require-hours", 0);
  const maxAgeMinutes = numberArg("max-age-minutes", 10);
  const now = Date.now();
  const content = await readFile(logPath, "utf8");
  const statuses = [];
  const fatals = [];

  for (const line of content.split(/\r?\n/)) {
    const status = parsePayload(line, "RELAYER_STATUS=");
    if (status) statuses.push(status);
    const fatal = parsePayload(line, "RELAYER_FATAL=");
    if (fatal) fatals.push(fatal);
  }
  if (statuses.length === 0) throw new Error("No RELAYER_STATUS entries found.");

  const valid = statuses
    .map((status) => ({
      ...status,
      timestampMs: Date.parse(status.timestamp),
    }))
    .filter((status) => Number.isFinite(status.timestampMs))
    .sort((left, right) => left.timestampMs - right.timestampMs);
  if (valid.length === 0) throw new Error("No timestamped relayer status entries.");

  for (const status of valid) {
    if (!Array.isArray(status.vaults) || status.vaults.length !== 2) {
      throw new Error("A relayer status entry did not contain both vaults.");
    }
    if (
      status.vaults.some(
        (vault) =>
          vault.state === "error" ||
          vault.actionable === true
      )
    ) {
      throw new Error("An actionable/error vault status exists in the log.");
    }
  }

  const latest = valid.at(-1);
  if (now - latest.timestampMs > maxAgeMinutes * 60_000) {
    throw new Error("The latest successful relayer status is stale.");
  }

  const windowStart = now - requireHours * 3_600_000;
  const inWindow =
    requireHours > 0
      ? valid.filter((status) => status.timestampMs >= windowStart)
      : valid;
  if (requireHours > 0) {
    const earliest = valid[0];
    if (earliest.timestampMs > windowStart) {
      throw new Error(`Relayer history is shorter than ${requireHours} hours.`);
    }
    const minimumExpected = Math.floor(requireHours * 60 * 0.9);
    if (inWindow.length < minimumExpected) {
      throw new Error(
        `Only ${inWindow.length} successful runs in ${requireHours} hours; expected at least ${minimumExpected}.`
      );
    }
    const fatalInWindow = fatals.some((fatal) => {
      const timestamp = Date.parse(fatal.timestamp);
      return Number.isFinite(timestamp) && timestamp >= windowStart;
    });
    if (fatalInWindow) {
      throw new Error("A fatal relayer run exists in the verification window.");
    }
  }

  console.log(
    `RELAYER_LOG_VERIFICATION=${JSON.stringify({
      status: "ok",
      requireHours,
      successfulRunsInWindow: inWindow.length,
      firstSuccess: valid[0].timestamp,
      latestSuccess: latest.timestamp,
      fatalCount: fatals.length,
    })}`
  );
}

main().catch((error) => {
  console.error(`RELAYER_LOG_VERIFICATION_ERROR=${JSON.stringify({
    detail: error.message,
  })}`);
  process.exitCode = 1;
});
