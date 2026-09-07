/**
 * Parity oracle (2026-09-07, owner: "sites like Dune or DefiLlama ... we can
 * cross-verify against these sources to prove our work is accurate").
 *
 * Pure comparison of OUR cells against an independent reference for the
 * same collection. A field matches within a tolerance, is "near" within a
 * wider band, or diverges. A collection's parity is the worst field. A
 * chain's parity is the share of sampled collections at match-or-near.
 * Every number here is relative, so it works the same for a 0.01 ETH floor
 * and a 60 SOL floor.
 *
 * Tolerances: floors move between two reads, so 5% is a match and 15% is
 * near; listed counts differ by venue coverage, 10% / 30%; sales and
 * volume windows are not aligned to the minute, 15% / 40%; supply must be
 * exact within 0.5%.
 */
export type ParityField = "floor" | "listed" | "supply" | "sales24h" | "volume24h";

export type ParityVerdict = "match" | "near" | "diverge" | "unverified";

export type ParityInput = Partial<Record<ParityField, number | null>>;

export type FieldParity = { field: ParityField; ours: number | null; theirs: number | null; relDiff: number | null; verdict: ParityVerdict };

const TOLERANCE: Record<ParityField, { match: number; near: number }> = {
  floor: { match: 0.05, near: 0.15 },
  listed: { match: 0.1, near: 0.3 },
  supply: { match: 0.005, near: 0.02 },
  sales24h: { match: 0.15, near: 0.4 },
  volume24h: { match: 0.15, near: 0.4 },
};

export function compareField(field: ParityField, ours: number | null | undefined, theirs: number | null | undefined): FieldParity {
  const o = ours == null || !Number.isFinite(ours) ? null : ours;
  const t = theirs == null || !Number.isFinite(theirs) ? null : theirs;
  if (o == null || t == null) return { field, ours: o, theirs: t, relDiff: null, verdict: "unverified" };
  if (o === 0 && t === 0) return { field, ours: o, theirs: t, relDiff: 0, verdict: "match" };
  const denom = Math.max(Math.abs(o), Math.abs(t));
  const rel = Math.abs(o - t) / denom;
  const tol = TOLERANCE[field];
  const verdict: ParityVerdict = rel <= tol.match ? "match" : rel <= tol.near ? "near" : "diverge";
  return { field, ours: o, theirs: t, relDiff: Number(rel.toFixed(4)), verdict };
}

export type CollectionParity = { fields: FieldParity[]; verdict: ParityVerdict; verifiedFields: number };

const ORDER: ParityVerdict[] = ["match", "near", "diverge"];

export function compareCollection(ours: ParityInput, theirs: ParityInput): CollectionParity {
  const fields = (Object.keys(TOLERANCE) as ParityField[]).map((f) => compareField(f, ours[f], theirs[f]));
  const verified = fields.filter((f) => f.verdict !== "unverified");
  if (verified.length === 0) return { fields, verdict: "unverified", verifiedFields: 0 };
  let worst: ParityVerdict = "match";
  for (const f of verified) if (ORDER.indexOf(f.verdict) > ORDER.indexOf(worst)) worst = f.verdict;
  return { fields, verdict: worst, verifiedFields: verified.length };
}

export type ChainParitySummary = { sampled: number; verified: number; match: number; near: number; diverge: number; agreement: number | null };

export function summarise(rows: CollectionParity[]): ChainParitySummary {
  const verifiedRows = rows.filter((r) => r.verdict !== "unverified");
  const count = (v: ParityVerdict) => verifiedRows.filter((r) => r.verdict === v).length;
  const match = count("match");
  const near = count("near");
  const diverge = count("diverge");
  return {
    sampled: rows.length,
    verified: verifiedRows.length,
    match,
    near,
    diverge,
    agreement: verifiedRows.length > 0 ? Number(((match + near) / verifiedRows.length).toFixed(3)) : null,
  };
}
