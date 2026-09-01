/**
 * Replay hook: settle ACTUAL exported live rounds under CCS.
 *
 * Input format (JSON file or object). All numeric fields are decimal strings
 * (wei / bps) to survive JSON round-trips losslessly:
 * {
 *   "roundId": 123,                     // number or string
 *   "label": "optional description",
 *   "crashBps": "400000",              // settled crash multiplier, bps
 *   "seedWei": "50000000000000000",    // house seed added to the pool
 *   "rakeBps": "300",                  // player-pool rake in bps
 *   "seats": [
 *     { "id": "0xwallet-or-name", "stakeWei": "2000000000000000000", "targetBps": "398300" }
 *   ]
 * }
 * distributable = seedWei + playerPool * (10000 - rakeBps) / 10000  (floor),
 * identical to lib/casino/economics.ts roundEconomics.
 *
 * Usage: node replay.mjs path/to/round-export.json
 * (The owner's real round-123 record is not in-repo; run.mjs exercises this
 * loader with a clearly-labeled SYNTHETIC round-123-shaped scenario.)
 */
import { readFileSync } from "node:fs";
import { BPS, DEFAULT_CCS, settleCcs, roundEconomics } from "./engine.mjs";

export function loadRoundExport(source) {
  const raw = typeof source === "string" ? JSON.parse(readFileSync(source, "utf8")) : source;
  if (raw == null || typeof raw !== "object") throw new TypeError("round export must be an object");
  const req = (v, name) => {
    if (v === undefined || v === null) throw new TypeError(`missing field: ${name}`);
    return BigInt(v);
  };
  const seats = (raw.seats ?? []).map((s, i) => ({
    id: String(s.id ?? `seat${i}`),
    stake: req(s.stakeWei, `seats[${i}].stakeWei`),
    targetBps: req(s.targetBps, `seats[${i}].targetBps`),
  }));
  return {
    roundId: String(raw.roundId ?? "?"),
    label: raw.label ? String(raw.label) : "",
    crashBps: req(raw.crashBps, "crashBps"),
    seedWei: req(raw.seedWei ?? "0", "seedWei"),
    rakeBps: req(raw.rakeBps ?? "0", "rakeBps"),
    seats,
  };
}

export function settleRoundExport(round, params = DEFAULT_CCS) {
  const econ = roundEconomics(round.seedWei, round.seats.map((s) => s.stake), round.rakeBps);
  const settlement = settleCcs(econ.distributable, round.crashBps, round.seats, params);
  return { econ, settlement };
}

// CLI
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop())) {
  const path = process.argv[2];
  if (!path) {
    console.error("usage: node replay.mjs <round-export.json>");
    process.exit(2);
  }
  const round = loadRoundExport(path);
  const { econ, settlement } = settleRoundExport(round);
  console.log(`round ${round.roundId} ${round.label}`);
  console.log(`crash ${Number(round.crashBps) / 1e4}x  D=${econ.distributable}  mode=${settlement.meta.mode}  lambda=${settlement.meta.lambda}`);
  for (const a of settlement.allocations) {
    console.log(
      `${a.id.padEnd(20)} stake=${a.stake} m=${Number(a.targetBps) / 1e4}x survived=${a.survived} payout=${a.payout} net=${a.net}`,
    );
  }
  console.log(`vaultRemainder=${settlement.vaultRemainder} capExcess=${settlement.capExcess}`);
}
