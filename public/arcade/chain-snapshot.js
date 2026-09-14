// Every field belongs to one block. Never combine a new round ID with an old
// round body, stake or clock while settlement advances the chain.
export async function readRoundSnapshot(provider, crash, wallet = null) {
  const block = await provider.getBlock("latest");
  if (!block) throw new Error("Chain block unavailable");
  const at = { blockTag: block.number };
  const roundId = await crash.currentRoundId(at);
  const [round, seats, stake, target] = await Promise.all([
    crash.rounds(roundId, at), crash.seatCount(roundId, at),
    wallet ? crash.stakeOf(roundId, wallet, at) : 0n,
    wallet ? crash.targetOf(roundId, wallet, at) : 0n,
  ]);
  const canonical = await provider.getBlock(block.number);
  if (!canonical || canonical.hash !== block.hash) throw new Error("Snapshot reorganized; retry");
  return { roundId, round, seats, stake, target, blockNum: block.number, chainNow: block.timestamp };
}

export function netRoundRake(pool, rakeBps, keeperBps) {
  const gross = pool - pool * (10000n - rakeBps) / 10000n;
  return gross - gross * keeperBps / 10000n;
}

// Hosted table: the keeper publishes one round snapshot for every player (see
// invite gateway /api/invite/state and /feed). BigInts arrive as decimal
// strings; rebuild them so callers see exactly what readRoundSnapshot returns.
// Per-player stake/target are still read from the chain at the snapshot block.
const bigish = (v) => typeof v === "string" && /^-?\d+$/.test(v) ? BigInt(v) : v;
export function reviveState(state) {
  if (!state || !state.ready) return null;
  const round = {}; for (const [k, v] of Object.entries(state.round || {})) round[k] = bigish(v);
  return { roundId: BigInt(state.roundId), round, seats: BigInt(state.seatCount), blockNum: Number(state.blockNum), blockHash: state.blockHash, chainNow: Number(state.chainNow), publishedAtMs: Number(state.publishedAtMs) };
}
export async function readRoundSnapshotFromState(state, crash, wallet = null) {
  const base = reviveState(state);
  if (!base) throw new Error("Snapshot unavailable");
  const at = { blockTag: base.blockNum };
  const [stake, target] = await Promise.all([
    wallet ? crash.stakeOf(base.roundId, wallet, at) : 0n,
    wallet ? crash.targetOf(base.roundId, wallet, at) : 0n,
  ]);
  return { ...base, stake, target };
}
