/** Reputation is accepted reaction history, never a user's spendable inventory. */
export const REPUTATION_FACES = ["stalk", "splinter", "knock", "hum", "pith", "gleam", "knot"] as const;
export type ReputationFace = typeof REPUTATION_FACES[number];
export type ReputationBasis = "current" | "lifetime";
export type ReputationMetric = "totals" | "supporters";
export type MetricKey = { face: ReputationFace; basis: ReputationBasis; metric: ReputationMetric };
export type ReputationFilter =
  | (MetricKey & { op: "gte" | "lte" | "eq"; value: string })
  | (MetricKey & { op: "between"; min: string; max: string })
  | { op: "all" | "any"; children: ReputationFilter[] }
  | { op: "not"; child: ReputationFilter };
export type ReputationSort = MetricKey & { direction: "asc" | "desc" };
export type AcceptedReaction = {
  receiptId: string; contentId: string; profileId: string; face: ReputationFace;
  quantity: string;
  /** Derived from authoritative attachment state; never supplied by a browser. */
  active: boolean;
};
export type ReputationCounts = Record<ReputationFace, Record<ReputationBasis, Record<ReputationMetric, string>>>;
export type ReputationRow = { contentId: string; counts: ReputationCounts };

function integer(value: unknown): bigint {
  if (typeof value !== "string" || !/^(0|[1-9]\d{0,39})$/.test(value)) throw new Error("Expected a nonnegative decimal count");
  return BigInt(value);
}
function key(value: MetricKey) {
  if (!REPUTATION_FACES.includes(value.face) || !["current", "lifetime"].includes(value.basis) || !["totals", "supporters"].includes(value.metric)) throw new Error("Invalid reputation metric");
}

/** Bound parser work before evaluating a shareable filter supplied by a client. */
export function validateReputationFilter(filter: ReputationFilter): void {
  let nodes = 0;
  const visit = (f: ReputationFilter, depth: number) => {
    if (!f || typeof f !== "object" || ++nodes > 128 || depth > 12) throw new Error("Reputation filter is too complex");
    if (f.op === "all" || f.op === "any") {
      if (!Array.isArray(f.children) || !f.children.length) throw new Error("Choose at least one filter");
      f.children.forEach(child => visit(child, depth + 1));
    } else if (f.op === "not") visit(f.child, depth + 1);
    else {
      const leaf = f as MetricKey & { op: string; value?: string; min?: string; max?: string };
      key(leaf);
      if (leaf.op === "between") {
        if (integer(leaf.min) > integer(leaf.max)) throw new Error("Range minimum exceeds maximum");
      } else if (["gte", "lte", "eq"].includes(leaf.op)) integer(leaf.value);
      else throw new Error("Invalid reputation comparison");
    }
  };
  visit(filter, 0);
}

/** Only pass content IDs already authorized by the content adapter. Missing faces are real zeroes. */
export function projectReputation(eligibleContentIds: readonly string[], reactions: readonly AcceptedReaction[]): ReputationRow[] {
  const eligible = new Set(eligibleContentIds);
  const seen = new Map<string, string>();
  const accepted = new Map<string, AcceptedReaction[]>();
  for (const r of reactions) {
    if (!eligible.has(r.contentId)) continue;
    key({ face: r.face, basis: "current", metric: "totals" });
    if (!r.receiptId || !r.profileId || typeof r.active !== "boolean" || integer(r.quantity) === 0n) throw new Error("Invalid accepted reaction");
    const identity = JSON.stringify([r.contentId, r.profileId, r.face, r.quantity, r.active]);
    if (seen.has(r.receiptId)) {
      if (seen.get(r.receiptId) !== identity) throw new Error("Conflicting receipt history");
      continue;
    }
    seen.set(r.receiptId, identity);
    const list = accepted.get(r.contentId) ?? [];
    list.push(r); accepted.set(r.contentId, list);
  }
  return [...eligible].map(contentId => {
    const counts = {} as ReputationCounts;
    for (const face of REPUTATION_FACES) {
      const lifetime = (accepted.get(contentId) ?? []).filter(r => r.face === face);
      const current = lifetime.filter(r => r.active);
      const summarize = (items: AcceptedReaction[]) => ({
        totals: items.reduce((sum, r) => sum + BigInt(r.quantity), 0n).toString(),
        supporters: new Set(items.map(r => r.profileId)).size.toString(),
      });
      counts[face] = { current: summarize(current), lifetime: summarize(lifetime) };
    }
    return { contentId, counts };
  });
}

function matches(row: ReputationRow, filter: ReputationFilter): boolean {
  if (filter.op === "all") return filter.children.every(child => matches(row, child));
  if (filter.op === "any") return filter.children.some(child => matches(row, child));
  if (filter.op === "not") return !matches(row, filter.child);
  const leaf = filter as Exclude<ReputationFilter, { children: ReputationFilter[] } | { op: "not" }>;
  const count = BigInt(row.counts[leaf.face][leaf.basis][leaf.metric]);
  if (leaf.op === "between") return count >= BigInt(leaf.min) && count <= BigInt(leaf.max);
  const threshold = BigInt(leaf.value);
  return leaf.op === "gte" ? count >= threshold : leaf.op === "lte" ? count <= threshold : count === threshold;
}

/** Sort/filter one materialized snapshot. Keep its rows server-side for stable multi-page reads. */
export function discoverReputation(rows: readonly ReputationRow[], filter?: ReputationFilter, sorts: readonly ReputationSort[] = []): ReputationRow[] {
  if (filter) validateReputationFilter(filter);
  if (sorts.length > 8) throw new Error("Too many sort keys");
  for (const sort of sorts) {
    key(sort);
    if (sort.direction !== "asc" && sort.direction !== "desc") throw new Error("Invalid sort direction");
  }
  return rows.filter(row => !filter || matches(row, filter)).sort((a, b) => {
    for (const sort of sorts) {
      const av = BigInt(a.counts[sort.face][sort.basis][sort.metric]);
      const bv = BigInt(b.counts[sort.face][sort.basis][sort.metric]);
      if (av !== bv) return (av < bv ? -1 : 1) * (sort.direction === "asc" ? 1 : -1);
    }
    return a.contentId < b.contentId ? -1 : a.contentId > b.contentId ? 1 : 0;
  });
}
