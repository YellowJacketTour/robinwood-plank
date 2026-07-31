/**
 * Compute-unit accounting for outbound JSON-RPC.
 *
 * The provider bill is denominated in compute units, not requests, and the two
 * diverge by ~6x across the methods this app uses (eth_call 26 vs eth_getLogs
 * 60). Without this the only way to find out what was expensive was to read the
 * provider dashboard after the fact and guess which code path produced it.
 *
 * Costs from https://www.alchemy.com/docs/reference/compute-unit-costs
 */

const CU_BY_METHOD: Record<string, number> = {
  eth_call: 26,
  eth_getLogs: 60,
  eth_blockNumber: 10,
  eth_getBlockByNumber: 20,
  eth_getTransactionByHash: 17,
  eth_getTransactionReceipt: 15,
  eth_getBalance: 19,
  eth_chainId: 0,
  eth_gasPrice: 19,
  eth_getCode: 19,
};

/** Unknown methods are not free — assume eth_call-ish rather than zero. */
const DEFAULT_CU = 26;

export function cuForMethod(method: string): number {
  return CU_BY_METHOD[method] ?? DEFAULT_CU;
}

export type RpcMeterSnapshot = {
  since: number;
  calls: number;
  computeUnits: number;
  byMethod: Record<string, { calls: number; computeUnits: number }>;
};

type MeterGlobal = typeof globalThis & { __plankRpcMeter?: RpcMeterSnapshot };

function meter(): RpcMeterSnapshot {
  const g = globalThis as MeterGlobal;
  if (!g.__plankRpcMeter) {
    g.__plankRpcMeter = { since: Date.now(), calls: 0, computeUnits: 0, byMethod: {} };
  }
  return g.__plankRpcMeter;
}

/**
 * Record one outbound RPC. `count` is the number of billed methods — a JSON-RPC
 * array batch is billed per entry, not per HTTP request, so batching saves
 * round-trips but no compute units.
 */
export function recordRpc(method: string, count = 1): void {
  const m = meter();
  const cu = cuForMethod(method) * count;
  m.calls += count;
  m.computeUnits += cu;
  const entry = (m.byMethod[method] ??= { calls: 0, computeUnits: 0 });
  entry.calls += count;
  entry.computeUnits += cu;
}

export function readRpcMeter(): RpcMeterSnapshot {
  const m = meter();
  return {
    since: m.since,
    calls: m.calls,
    computeUnits: m.computeUnits,
    byMethod: JSON.parse(JSON.stringify(m.byMethod)) as RpcMeterSnapshot["byMethod"],
  };
}

export function resetRpcMeter(): void {
  const g = globalThis as MeterGlobal;
  g.__plankRpcMeter = { since: Date.now(), calls: 0, computeUnits: 0, byMethod: {} };
}

/** Projected 30-day compute units at the rate observed so far. */
export function projectedMonthlyCu(snapshot = readRpcMeter()): number | null {
  const elapsedMs = Date.now() - snapshot.since;
  if (elapsedMs < 1_000 || snapshot.computeUnits === 0) return null;
  return Math.round((snapshot.computeUnits / elapsedMs) * 30 * 24 * 60 * 60 * 1000);
}
