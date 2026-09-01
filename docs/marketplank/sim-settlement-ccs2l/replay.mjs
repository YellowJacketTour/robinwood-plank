/**
 * Replay hook: settle ACTUAL exported live playtest rounds under CCS-2L.
 *
 * NO real round export exists in-repo (searched 2026-08-31: test/market,
 * test/contracts/fixtures, docs/marketplank — the owner's real round-123
 * record was never committed). This file therefore (a) documents the exact
 * expected export format, and (b) when run with no argument, replays a
 * CLEARLY-LABELED SYNTHETIC round-123-SHAPED scenario (the same 10-seat,
 * 40.00x shape reconstructed in docs/marketplank/sim-settlement/run.mjs).
 *
 * Export format (JSON file or object) — all numeric fields decimal strings
 * (wei / bps) to survive JSON round-trips losslessly:
 * {
 *   "roundId": 123,
 *   "label": "optional description",
 *   "crashBps": "400000",               // settled crash multiplier, bps
 *   "seedWei": "50000000",              // house seed committed to the round
 *   "rakeBps": "300",                   // player-pool rake in bps
 *   "reserveAtLockWei": "1000000000",   // reserve snapshot at lock (global cap)
 *   "settlement": {                     // OPTIONAL commitment-time descriptor
 *     "rule": "ccs-2l", "version": 1,   // (lib/casino/settlement-rules.ts);
 *     "paramsHash": "0x…"               // when present it is verified, and a
 *   },                                  // non-ccs-2l rule is refused here
 *   "seats": [
 *     { "id": "0xwallet", "stakeWei": "2000000000", "targetBps": "398300" }
 *   ]
 * }
 * playerDistributable = playerPool * (10000 - rakeBps) / 10000 (floor),
 * identical to lib/casino/economics.ts roundEconomics; the seed is the house
 * purse, exactly as in settleCcs2L(playerDistributable, seedWei, ...).
 *
 * Usage: node replay.mjs [path/to/round-export.json]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { DEFAULT_CCS2L, settleCcs2L, roundEconomics } from "./engine.mjs";

export function loadRoundExport(source) {
  const raw = typeof source === "string" ? JSON.parse(readFileSync(source, "utf8")) : source;
  if (raw == null || typeof raw !== "object") throw new TypeError("round export must be an object");
  const req = (v, name) => {
    if (v === undefined || v === null) throw new TypeError(`missing field: ${name}`);
    return BigInt(v);
  };
  if (raw.settlement && raw.settlement.rule !== "ccs-2l") {
    throw new TypeError(
      `round ${raw.roundId} committed to rule "${raw.settlement.rule}" — replay it under THAT rule ` +
        "(lib/casino/settlement-rules.ts replayCommittedRound), never under ccs-2l",
    );
  }
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
    reserveAtLock: req(raw.reserveAtLockWei ?? "0", "reserveAtLockWei"),
    seats,
  };
}

export function settleRoundExport(round, params = DEFAULT_CCS2L) {
  const econ = roundEconomics(round.seedWei, round.seats.map((s) => s.stake), round.rakeBps);
  const settlement = settleCcs2L(
    econ.playerDistributable,
    round.seedWei,
    round.crashBps,
    round.seats,
    round.reserveAtLock,
    params,
  );
  return { econ, settlement };
}

/** SYNTHETIC round-123-SHAPED scenario — NOT a real exported round. */
export function syntheticRound123() {
  return {
    roundId: "123-SYNTHETIC",
    label: "SYNTHETIC round-123-shaped scenario (no real export exists in-repo)",
    crashBps: "400000",
    seedWei: "50000000",
    rakeBps: "300",
    reserveAtLockWei: "10000000000", // 10 units — global cap 1000 bps => 1 unit
    seats: [
      { id: "DegenAlt", stakeWei: "2000000000", targetBps: "398300" },
      { id: "early1", stakeWei: "3000000000", targetBps: "14000" },
      { id: "early2", stakeWei: "2500000000", targetBps: "15000" },
      { id: "early3", stakeWei: "2000000000", targetBps: "18000" },
      { id: "early4", stakeWei: "4000000000", targetBps: "20000" },
      { id: "early5", stakeWei: "1500000000", targetBps: "22000" },
      { id: "early6", stakeWei: "2000000000", targetBps: "25000" },
      { id: "mid1", stakeWei: "1500000000", targetBps: "32000" },
      { id: "mid2", stakeWei: "1000000000", targetBps: "45000" },
      { id: "buster", stakeWei: "500000000", targetBps: "420000" },
    ],
  };
}

// CLI
const invoked = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop());
if (invoked) {
  const path = process.argv[2];
  const round = loadRoundExport(path ?? syntheticRound123());
  if (!path) console.log("*** SYNTHETIC round-123-SHAPED scenario — no real round export exists in-repo ***");
  const { econ, settlement } = settleRoundExport(round);
  console.log(`round ${round.roundId} ${round.label}`);
  console.log(
    `crash ${Number(round.crashBps) / 1e4}x  D_players=${econ.playerDistributable}  H=${round.seedWei}  mode=${settlement.meta.mode}  lambda=${settlement.meta.lambda}`,
  );
  for (const a of settlement.allocations) {
    console.log(
      `${a.id.padEnd(12)} stake=${String(a.stake).padStart(11)} m=${(Number(a.targetBps) / 1e4).toFixed(2)}x survived=${a.survived} player=${a.playerPayout} bonus=${a.houseBonus} net=${a.net}`,
    );
  }
  console.log(`totalPlayerPaid=${settlement.totalPlayerPaid} totalBonus=${settlement.totalBonus} houseReturned=${settlement.houseReturned} treasuryCapResidue=${settlement.treasuryCapResidue}`);
  if (!path) {
    const out = {
      synthetic: true,
      note: "round-123-SHAPED synthetic replay under ccs-2l v1.1; no real export exists in-repo",
      input: syntheticRound123(),
      output: JSON.parse(JSON.stringify(settlement, (k, v) => (typeof v === "bigint" ? v.toString() : v))),
    };
    writeFileSync(new URL("./replay-round123-synthetic.json", import.meta.url), JSON.stringify(out, null, 2));
  }
}
