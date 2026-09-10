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
