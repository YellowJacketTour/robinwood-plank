import { COVERAGE_STYLE, COVERAGE_LABEL, type MarketCoverage } from "@/lib/market/multichain/venue-registry";
import { coverageShortLabel, relativeAsOf } from "@/lib/market/multichain/collection-coverage";

type Props = {
  venueLabel: string;
  coverage: MarketCoverage;
  /** Real ISO timestamp this collection's numbers were last observed/synced -- renders "as of Xm ago" when present. Omit rather than fabricate one. */
  asOf?: string | null;
  className?: string;
};

/**
 * Small, non-alarming inline badge -- venue name + coverage level (same
 * exact colors/labels as app/market/multichain/known-limitations/page.tsx's
 * COVERAGE_STYLE, imported from lib/market/multichain/venue-registry.ts so
 * the two can never drift) + an optional "Xm ago" relative timestamp. This
 * is the "source chip" pattern from Issue 4 of docs/marketplank/
 * GROK-FINDINGS-biggest-issues-unified-vision-2026-08-25.md
 * ("OpenSea · live" / "Tensor · settlements only" / "UniSat · 12m ago") --
 * brought inline onto the actual ranking/detail surfaces rather than only
 * living on the dedicated known-limitations page.
 *
 * Deliberately renders nothing for `indexed` coverage anywhere it's used --
 * callers should not mount this component at all for a fully-indexed row
 * (see isFullyIndexedCoverage in collection-coverage.ts). This component
 * itself also no-ops on `indexed` as a second line of defense, matching
 * Grok's explicit "no doom disclaimer on every pixel" guidance: severity
 * should match real risk, not apply uniformly.
 */
export default function DataSourceChip({ venueLabel, coverage, asOf, className }: Props) {
  if (coverage === "indexed") return null;
  const asOfLabel = relativeAsOf(asOf);
  const title = `${venueLabel} · ${COVERAGE_LABEL[coverage]}${asOfLabel ? ` · as of ${asOfLabel}` : ""}`;
  return (
    <span
      className={`inline-flex min-h-5 items-center gap-1 rounded-md border px-1.5 text-[0.58rem] font-bold uppercase tracking-wide ${COVERAGE_STYLE[coverage]} ${className ?? ""}`}
      title={title}
    >
      <span className="max-w-[6rem] truncate normal-case">{venueLabel}</span>
      <span aria-hidden="true">·</span>
      <span>{coverageShortLabel(coverage)}</span>
      {asOfLabel && (
        <>
          <span aria-hidden="true">·</span>
          <span className="normal-case">{asOfLabel}</span>
        </>
      )}
    </span>
  );
}
