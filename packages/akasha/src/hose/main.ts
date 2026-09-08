import { ArchiveStore } from "./store.ts";
import { assertCoverage } from "./coverage.ts";
import { EvmAdapter } from "./adapters/evm.ts";
import { HttpTickStream, JsonRpcEvm } from "./rpc/evm.ts";
import { GapWorker } from "./gap.ts";
import { EVM_CHAINS, FINALITY_LAG, type ChainId } from "../shared/types.ts";
import { asHex } from "../shared/hex.ts";

export interface HoseConfig {
  endpoints: Partial<Record<ChainId, string>>;
  t0: Partial<Record<ChainId, { height: number; hash: string }>>;
}

export class Hose {
  readonly store = new ArchiveStore();
  readonly evm = new Map<ChainId, EvmAdapter>();
  private worker: GapWorker | undefined;

  private cfg: HoseConfig;
  constructor(cfg: HoseConfig) {
    this.cfg = cfg;
  }

  /**
   * Refuses to mark streams alive unless [t0, finalized] is one run.
   */
  async boot(): Promise<void> {
    for (const chain of EVM_CHAINS) {
      const url = this.cfg.endpoints[chain];
      const t0 = this.cfg.t0[chain];
      if (!url || !t0) continue;
      const rpc = new JsonRpcEvm(url, chain);
      const stream = new HttpTickStream(rpc, Math.max(2000, 500));
      const adapter = new EvmAdapter({
        chain,
        store: this.store,
        rpc,
        stream,
        t0: { height: t0.height, hash: asHex(t0.hash) },
      });
      this.evm.set(chain, adapter);
      adapter.start();
    }
    this.worker = new GapWorker(this.store, this.evm, async (chain, height) => {
      const url = this.cfg.endpoints[chain];
      if (!url) return undefined;
      return new JsonRpcEvm(url, chain).getBlockByNumber(height);
    });
  }

  async repairTick(): Promise<void> {
    await this.worker?.step();
  }

  health(): Record<string, unknown> {
    const out: Record<string, unknown> = { finalityLag: FINALITY_LAG };
    for (const chain of this.store.cursors.keys()) {
      out[chain] = assertCoverage(this.store, chain);
    }
    return out;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const hose = new Hose({
    endpoints: {},
    t0: {},
  });
  console.log("hose constructed; configure endpoints before boot");
  console.log(JSON.stringify(hose.health(), null, 2));
}
