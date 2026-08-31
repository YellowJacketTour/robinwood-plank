export const ROBINHOOD_TESTNET_CHAIN_ID = 46_630n;

export type BlockObservation = {
  number: number;
  timestamp: number;
  hash: string;
  parentHash: string;
  observedAtMs: number;
};

export function assertCanaryNetwork(chainId: bigint, signed: boolean): void {
  if (signed && chainId !== ROBINHOOD_TESTNET_CHAIN_ID) {
    throw new Error(`SIGNED_CANARY_REFUSED: expected Robinhood testnet ${ROBINHOOD_TESTNET_CHAIN_ID}, received ${chainId}`);
  }
}

export function summarizeBlockCadence(blocks: BlockObservation[]) {
  if (blocks.length < 2) throw new RangeError("at least two block observations are required");
  const ordered = blocks.slice();
  const observedIntervalsMs: number[] = [];
  const chainTimestampStepsSeconds: number[] = [];
  let parentContinuity = true;
  let monotonicNumbers = true;
  for (let index = 1; index < ordered.length; index += 1) {
    const previous = ordered[index - 1];
    const current = ordered[index];
    if (current.number !== previous.number + 1) monotonicNumbers = false;
    if (current.parentHash.toLowerCase() !== previous.hash.toLowerCase()) parentContinuity = false;
    observedIntervalsMs.push(current.observedAtMs - previous.observedAtMs);
    chainTimestampStepsSeconds.push(current.timestamp - previous.timestamp);
  }
  const sorted = observedIntervalsMs.slice().sort((a, b) => a - b);
  const percentile = (fraction: number) => sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction))];
  return {
    firstBlock: ordered[0].number,
    lastBlock: ordered.at(-1)!.number,
    samples: ordered.length,
    monotonicNumbers,
    parentContinuity,
    observedIntervalMs: {
      min: sorted[0],
      median: percentile(0.5),
      p95: percentile(0.95),
      max: sorted.at(-1),
    },
    chainTimestampStepsSeconds: {
      min: Math.min(...chainTimestampStepsSeconds),
      max: Math.max(...chainTimestampStepsSeconds),
    },
  };
}
