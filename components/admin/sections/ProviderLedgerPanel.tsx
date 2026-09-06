"use client";

import { useEffect, useState } from "react";
import { CARD, LABEL } from "../ui";

/**
 * The provider ledger, live, in the admin System section: every external
 * call this deployment made in the last N minutes (source × key × chain),
 * the edge gateway's reads-vs-fetches, the queue backlog with a
 * throughput-derived ETA, jailed sources and rate-limit incidents per day.
 * Reads /api/market/rpc-usage only; every number is labeled with its scope
 * (durable vs this-process) and nothing is fabricated when Postgres is off.
 */

type Usage = {
  edge: { byKind: Array<{ kind: string; reads: number; fetches: number; uniqueCells: number; readsPerFetch: number | null }>; totals: { reads: number; fetches: number; uniqueCells: number } };
  liveFeed: { subscribers: number; pushed: number; ticks: number };
  queue: null | {
    totals: { queued: number; running: number; failed: number; succeededLast15m: number };
    throughputPerMin: number | null;
    etaMinutes: number | null;
    jailed: Array<{ source: string; chainSlug: string | null; remainingSec: number }>;
    rateLimitIncidents: Array<{ day: string; source: string; incidents: number }>;
    backlog: Array<{ chainSlug: string; source: string; queued: number; running: number; failed: number; maxPriority: number | null }>;
  };
  ledger: { scope: string; minutes: number; rows: Array<{ source: string; keyId: string; chainSlug: string; calls: number; ok: number; rateLimited: number; timeouts: number; errors: number; avgLatencyMs: number | null; jailedMs: number | null }>; note: string };
};

const REFRESH_MS = 15_000;

export default function ProviderLedgerPanel() {
  const [usage, setUsage] = useState<Usage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [minutes, setMinutes] = useState(15);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const res = await fetch(`/api/market/rpc-usage?minutes=${minutes}`, { cache: "no-store" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as Usage;
        if (alive) {
          setUsage(data);
          setError(null);
        }
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : "failed");
      }
    };
    void load();
    const t = setInterval(load, REFRESH_MS);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [minutes]);

  return (
    <section className={CARD}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-display text-xl text-gold-300">Provider ledger</h2>
        <label className={LABEL}>
          window{" "}
          <select value={minutes} onChange={(e) => setMinutes(Number(e.target.value))} className="rounded border border-line bg-background px-1 text-xs">
            {[5, 15, 60, 90].map((m) => <option key={m} value={m}>{m} min</option>)}
          </select>
        </label>
      </div>
      {error && <p className="mt-2 text-xs text-red-400">Could not load usage: {error}</p>}
      {!usage && !error && <p className="mt-2 text-xs text-foreground/50">Loading…</p>}
      {usage && (
        <div className="mt-3 space-y-4 text-xs">
          <p className="text-foreground/60">
            Scope: <span className="font-semibold text-foreground">{usage.ledger.scope}</span>. {usage.ledger.note}
          </p>

          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Stat label="edge reads (this process)" value={usage.edge.totals.reads} />
            <Stat label="vendor fetches (this process)" value={usage.edge.totals.fetches} />
            <Stat label="unique cells" value={usage.edge.totals.uniqueCells} />
            <Stat label="live-feed subscribers" value={usage.liveFeed.subscribers} />
          </div>

          {usage.queue ? (
            <div>
              <h3 className="mb-1 font-semibold text-foreground">Mesh queue</h3>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
                <Stat label="queued" value={usage.queue.totals.queued} />
                <Stat label="running" value={usage.queue.totals.running} />
                <Stat label="failed" value={usage.queue.totals.failed} />
                <Stat label="done / 15 min" value={usage.queue.totals.succeededLast15m} />
                <Stat label="ETA (min)" value={usage.queue.etaMinutes ?? "—"} />
              </div>
              {usage.queue.jailed.length > 0 && (
                <p className="mt-2 text-amber-200">
                  Jailed: {usage.queue.jailed.map((j) => `${j.source}${j.chainSlug ? `:${j.chainSlug}` : ""} (${Math.round(j.remainingSec / 60)} min)`).join(", ")}
                </p>
              )}
              {usage.queue.rateLimitIncidents.length > 0 && (
                <p className="mt-1 text-foreground/60">
                  Rate-limit incidents: {usage.queue.rateLimitIncidents.slice(0, 6).map((r) => `${r.day} ${r.source} ×${r.incidents}`).join("; ")}
                </p>
              )}
            </div>
          ) : (
            <p className="text-foreground/50">Queue telemetry unavailable: Postgres is not configured for this process.</p>
          )}

          <div className="overflow-x-auto">
            <table className="w-full text-left">
              <thead className="text-foreground/50">
                <tr>
                  <th className="pr-2">source</th><th className="pr-2">key</th><th className="pr-2">chain</th><th className="pr-2 text-right">calls</th>
                  <th className="pr-2 text-right">ok</th><th className="pr-2 text-right">429</th><th className="pr-2 text-right">timeouts</th><th className="pr-2 text-right">errors</th>
                  <th className="pr-2 text-right">avg ms</th><th className="text-right">jail</th>
                </tr>
              </thead>
              <tbody>
                {usage.ledger.rows.length === 0 && (
                  <tr><td colSpan={10} className="py-2 text-foreground/40">No external calls recorded in this window.</td></tr>
                )}
                {usage.ledger.rows.map((r) => (
                  <tr key={`${r.source}|${r.keyId}|${r.chainSlug}`} className="border-t border-line/60">
                    <td className="pr-2">{r.source}</td><td className="pr-2">{r.keyId || "—"}</td><td className="pr-2">{r.chainSlug || "—"}</td>
                    <td className="pr-2 text-right">{r.calls}</td><td className="pr-2 text-right">{r.ok}</td>
                    <td className={`pr-2 text-right ${r.rateLimited > 0 ? "text-amber-200" : ""}`}>{r.rateLimited}</td>
                    <td className="pr-2 text-right">{r.timeouts}</td><td className="pr-2 text-right">{r.errors}</td>
                    <td className="pr-2 text-right">{r.avgLatencyMs ?? "—"}</td>
                    <td className="text-right">{r.jailedMs != null && r.jailedMs > 0 ? `${Math.round(r.jailedMs / 60_000)} min` : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </section>
  );
}

function Stat({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="rounded-md border border-line bg-background/60 px-2 py-1.5">
      <div className="text-[0.62rem] uppercase tracking-wide text-foreground/50">{label}</div>
      <div className="font-semibold text-foreground">{value}</div>
    </div>
  );
}
