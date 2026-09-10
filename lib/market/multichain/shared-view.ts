/** Public read models only. Never use this cache for transaction validation,
 * wallet/private state, or execution quotes. Each entry retains its actual
 * observation time; serving a previous result never renews its freshness. */
export type SharedView<T> = { value: T; capturedAt: number };

export class SharedViewCache {
  private entries = new Map<string, { view: SharedView<unknown>; bytes: number; checkedAt: number }>();
  private pending = new Map<string, Promise<SharedView<unknown>>>();
  private bytes = 0;
  constructor(private maxBytes = 16 * 1024 * 1024, private maxEntries = 128) {}

  async read<T>(key: string, load: () => Promise<SharedView<T>>, options: {
    freshMs: number; retainMs: number;
    defer?: (work: () => Promise<void>) => void;
  }): Promise<SharedView<T>> {
    const entry = this.entries.get(key);
    const previous = entry?.view as SharedView<T> | undefined;
    const age = previous ? Date.now() - previous.capturedAt : Infinity;
    if (previous && age >= 0 && age < options.retainMs && Date.now() - entry!.checkedAt < options.freshMs) return previous;
    const refresh = (): Promise<SharedView<T>> => {
      const active = this.pending.get(key);
      if (active) return active as Promise<SharedView<T>>;
      const request = Promise.resolve().then(load).then(view => {
        if (!Number.isFinite(view.capturedAt) || view.capturedAt > Date.now()) throw new Error("Invalid snapshot time");
        const bytes = Buffer.byteLength(JSON.stringify(view));
        const existing = this.entries.get(key);
        // A slower, older durable read cannot replace a newer local view.
        if (existing && existing.view.capturedAt > view.capturedAt) return existing.view as SharedView<T>;
        if (existing) { this.bytes -= existing.bytes; this.entries.delete(key); }
        if (bytes <= this.maxBytes) {
          while (this.entries.size && (this.bytes + bytes > this.maxBytes || this.entries.size >= this.maxEntries)) {
            const oldest = this.entries.keys().next().value!;
            this.bytes -= this.entries.get(oldest)!.bytes;
            this.entries.delete(oldest);
          }
          this.entries.set(key, {view, bytes, checkedAt:Date.now()}); this.bytes += bytes;
        }
        return view;
      }).finally(() => { if (this.pending.get(key) === request) this.pending.delete(key); });
      this.pending.set(key, request);
      return request;
    };
    if (previous && age >= 0 && age < options.retainMs) {
      const work = async () => {
        await refresh().catch(() => { if (entry) entry.checkedAt = Date.now(); });
      };
      if (options.defer) options.defer(work); else void work();
      return previous;
    }
    return refresh();
  }
}

export const publicCollectionViews = new SharedViewCache();
