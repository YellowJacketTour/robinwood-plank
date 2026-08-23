import type { MarketCapability, MarketCoverage } from "./venue-registry";

export type CoverageState = MarketCoverage | "backfilling" | "live" | "complete" | "degraded" | "error";

export type CapabilityCoverageCell = {
  chainSlug: string;
  venueId: string;
  protocol: string;
  protocolVersion: string;
  capability: MarketCapability;
  state: CoverageState;
  indexedFrom: string | null;
  indexedThrough: string | null;
  observedHead: string | null;
  lastSuccessAt: string | null;
  evidenceSource: string | null;
};

export function coverageCellKey(cell: Pick<CapabilityCoverageCell, "chainSlug" | "venueId" | "protocolVersion" | "capability">): string {
  return [cell.chainSlug, cell.venueId, cell.protocolVersion, cell.capability].join("::");
}

/** Complete means a proved contiguous range through the observed head. */
export function isProvenComplete(cell: CapabilityCoverageCell): boolean {
  return cell.state === "complete"
    && cell.indexedFrom != null
    && cell.indexedThrough != null
    && cell.observedHead != null
    && BigInt(cell.indexedThrough) >= BigInt(cell.observedHead)
    && Boolean(cell.lastSuccessAt && cell.evidenceSource);
}

export function summarizeCoverage(cells: readonly CapabilityCoverageCell[]) {
  const total = cells.length;
  const complete = cells.filter(isProvenComplete).length;
  return {
    total,
    complete,
    degraded: cells.filter((cell) => cell.state === "degraded" || cell.state === "error").length,
    unknown: cells.filter((cell) => cell.state === "planned" || cell.state === "unavailable").length,
    percentComplete: total === 0 ? 0 : (complete / total) * 100,
  };
}
