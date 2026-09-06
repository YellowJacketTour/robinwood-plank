import { MESH_LANES, type MeshCell, type MeshLane, type MeshSource } from "@/lib/market/multichain/mesh/matrix";
import { jailRemainingMs } from "@/lib/market/multichain/mesh/jail";
import { readProviderLedger, type ProviderLedgerRow } from "@/lib/market/multichain/edge/provider-ledger";
import { readProviderBudget, PROVIDER_BUDGET_DEFAULTS } from "@/lib/market/multichain/freshness-budget";

/**
 * Capability-aware source selection, replacing fixed fallback order.
 *
 * docs/marketplank/FABLE-ONESHOT-marketplank-all-chains-peak-2026-09-05.md
 * §3.2: "Fallback order is fixed per cell (mesh/matrix.ts); there is no
 * real-time cost/speed/limit-aware source selector, no cross-source
 * deduplication of the same fact, and no learned per-source reliability."
 *
 * The matrix stays the registry of what a source MAY write for a cell on a
 * chain (that is a capability, not a preference). This module ranks those
 * eligible lanes per (chain, cell) from live evidence:
 *
 *   score = capability (eligible at all)                       gate
 *         − jail            (durable mesh jail for source×chain) gate
 *         − budget pressure (freshness-budget 60s window)        0..1 → −40
 *         + reliability     (ok / calls over the ledger window)  0..1 → +30
 *         − latency         (avg ms over the ledger window)       −(ms/100) capped −20
 *         − cost            (vendor cost units per call)         −(cu/10) capped −15
 *         + evidence        (has any recent ledger rows at all)   +5
 *
 * scoreSources() is pure and unit-tested; selectSources() feeds it real
 * ledger/jail/budget reads. The output is explainable: every candidate
 * carries its terms and a `reason` string, and the mesh can log the choice.
 *
 * Cross-source corroboration of a single fact (name, image, supply, floor)
 * is a separate concern -- see corroborate() at the bottom: two sources
 * that disagree are SURFACED as a disagreement, never averaged.
 */

/** Which provider budget (freshness-budget.ts) a mesh source draws on. */
export function providerForSource(source: MeshSource): string | null {
  if (source.startsWith("opensea") || source === "robinhood-opensea" || source === "robinhood-membership") return "opensea";
  if (source.startsWith("unisat")) return "unisat";
  if (source.startsWith("helius")) return "helius";
  if (source === "magiceden-solana") return "magiceden";
  if (source === "ordiscan-discovery") return "ordiscan";
  if (source === "coingecko-nft") return "coingecko-nft";
  if (source.startsWith("hypersync") || source === "anchored-membership" || source === "token-index-probe" || /-fills(-genesis)?$/.test(source)) return "hypersync";
  return null;
}

/** Documented per-call cost in vendor units, relative (1 = a cheap keyed REST call). */
export function costUnitsForSource(source: MeshSource): number {
  if (source.startsWith("opensea")) return 6; // 600/h per key -- the scarcest paid-tier unit this app has
  if (source.startsWith("unisat")) return 5; // 2,000/day documented
  if (source.startsWith("helius")) return 3;
  if (source === "coingecko-nft") return 4;
  if (source === "magiceden-solana" || source === "ordinals-wallet") return 1; // keyless
  if (source.startsWith("hypersync") || /-fills/.test(source)) return 2; // no documented rate ceiling, but credits are metered
  if (source === "evm-metadata" || source === "ipfs-corroboration" || source === "erc4906-rescan") return 2; // multicall + IPFS
  return 1;
}

export type SourceEvidence = {
  jailedMs: number;
  /** freshness-budget pressure (calls_used / soft_ceiling), unclamped. */
  budgetPressure: number;
  budgetExhausted: boolean;
  calls: number;
  ok: number;
  avgLatencyMs: number | null;
};

export type SourceCandidate = {
  lane: MeshLane;
  eligible: boolean;
  score: number;
  terms: { jail: number; budget: number; reliability: number; latency: number; cost: number; evidence: number };
  reason: string;
};

export function scoreSources(lanes: MeshLane[], evidence: Map<string, SourceEvidence>): SourceCandidate[] {
  const out: SourceCandidate[] = [];
  for (const lane of lanes) {
    const ev = evidence.get(lane.source) ?? { jailedMs: 0, budgetPressure: 0, budgetExhausted: false, calls: 0, ok: 0, avgLatencyMs: null };
    const terms = { jail: 0, budget: 0, reliability: 0, latency: 0, cost: 0, evidence: 0 };
    let eligible = true;
    const reasons: string[] = [];
    if (ev.jailedMs > 0) {
      eligible = false;
      terms.jail = -1000;
      reasons.push(`jailed ${Math.round(ev.jailedMs / 1000)}s`);
    }
    if (ev.budgetExhausted) {
      eligible = false;
      terms.budget = -1000;
      reasons.push("budget exhausted");
    } else {
      terms.budget = -40 * Math.max(0, Math.min(1, ev.budgetPressure));
      if (ev.budgetPressure > 0.5) reasons.push(`budget pressure ${(ev.budgetPressure * 100).toFixed(0)}%`);
    }
    if (ev.calls > 0) {
      terms.reliability = 30 * (ev.ok / ev.calls);
      terms.evidence = 5;
      reasons.push(`reliability ${((100 * ev.ok) / ev.calls).toFixed(0)}% over ${ev.calls} calls`);
    } else {
      reasons.push("no recent evidence");
    }
    if (ev.avgLatencyMs != null) terms.latency = -Math.min(20, ev.avgLatencyMs / 100);
    terms.cost = -Math.min(15, costUnitsForSource(lane.source) / 10 * 10);
    const score = terms.jail + terms.budget + terms.reliability + terms.latency + terms.cost + terms.evidence;
    out.push({ lane, eligible, score, terms, reason: reasons.join("; ") || "eligible" });
  }
  // Highest score first; deterministic tie-break on matrix order (the old fixed order survives only as a tie-break).
  return out
    .map((c, i) => ({ c, i }))
    .sort((a, b) => (b.c.score - a.c.score) || (a.i - b.i))
    .map(({ c }) => c);
}

export function lanesFor(chainSlug: string, cell: MeshCell): MeshLane[] {
  return MESH_LANES.filter((l) => l.chainSlug === chainSlug && l.cells.includes(cell));
}

async function gatherEvidence(lanes: MeshLane[], chainSlug: string, ledger: ProviderLedgerRow[]): Promise<Map<string, SourceEvidence>> {
  const evidence = new Map<string, SourceEvidence>();
  const budgetCache = new Map<string, { pressure: number; exhausted: boolean }>();
  for (const lane of lanes) {
    const provider = providerForSource(lane.source);
    let budget = { pressure: 0, exhausted: false };
    if (provider && provider in PROVIDER_BUDGET_DEFAULTS) {
      const cached = budgetCache.get(provider);
      if (cached) budget = cached;
      else {
        const b = await readProviderBudget(provider).catch(() => null);
        budget = b ? { pressure: b.pressure, exhausted: b.exhausted } : { pressure: 0, exhausted: false };
        budgetCache.set(provider, budget);
      }
    }
    const jailedMs = await jailRemainingMs(lane.source, chainSlug).catch(() => 0);
    const rows = ledger.filter((r) => (r.source === lane.source || (provider != null && r.source === provider)) && (r.chainSlug === chainSlug || r.chainSlug === ""));
    const calls = rows.reduce((n, r) => n + r.calls, 0);
    const ok = rows.reduce((n, r) => n + r.ok, 0);
    const latencyRows = rows.filter((r) => r.avgLatencyMs != null && r.calls > 0);
    const avgLatencyMs = latencyRows.length > 0
      ? Math.round(latencyRows.reduce((n, r) => n + (r.avgLatencyMs ?? 0) * r.calls, 0) / latencyRows.reduce((n, r) => n + r.calls, 0))
      : null;
    evidence.set(lane.source, { jailedMs: Math.max(0, jailedMs), budgetPressure: budget.pressure, budgetExhausted: budget.exhausted, calls, ok, avgLatencyMs });
  }
  return evidence;
}

/** Live, explainable ranking of every eligible source for one (chain, cell). */
export async function selectSources(chainSlug: string, cell: MeshCell, opts?: { ledgerMinutes?: number }): Promise<SourceCandidate[]> {
  const lanes = lanesFor(chainSlug, cell);
  if (lanes.length === 0) return [];
  const ledger = await readProviderLedger(opts?.ledgerMinutes ?? 30).catch(() => [] as ProviderLedgerRow[]);
  const evidence = await gatherEvidence(lanes, chainSlug, ledger);
  return scoreSources(lanes, evidence);
}

export type Corroboration<T> =
  | { status: "agreed"; value: T; sources: string[] }
  | { status: "single"; value: T; sources: string[] }
  | { status: "disagreed"; values: Array<{ source: string; value: T }> }
  | { status: "empty" };

/**
 * Same fact from several sources. Agreement is exact after `normalize`;
 * anything else is a disagreement the caller must surface (dash + note),
 * never a blend. Numbers are never averaged, strings never fuzzy-matched.
 */
export function corroborate<T>(observations: Array<{ source: string; value: T | null | undefined }>, normalize: (v: T) => string = (v) => JSON.stringify(v)): Corroboration<T> {
  const present = observations.filter((o): o is { source: string; value: T } => o.value != null);
  if (present.length === 0) return { status: "empty" };
  const groups = new Map<string, { value: T; sources: string[] }>();
  for (const o of present) {
    const k = normalize(o.value);
    const g = groups.get(k);
    if (g) g.sources.push(o.source);
    else groups.set(k, { value: o.value, sources: [o.source] });
  }
  if (groups.size === 1) {
    const only = [...groups.values()][0];
    return only.sources.length > 1 ? { status: "agreed", value: only.value, sources: only.sources } : { status: "single", value: only.value, sources: only.sources };
  }
  return { status: "disagreed", values: present.map((o) => ({ source: o.source, value: o.value })) };
}
