"use client";

type Props = {
  counts: Record<string, Record<string, number>> | null;
  selected: Record<string, string>;
  onChange: (next: Record<string, string>) => void;
  building?: boolean;
  scanned?: number;
  totalSupply?: number | null;
};

/** Compact chain-agnostic facets. Never invents values: missing data is an
 * explicit indexing/unavailable state instead of a silently absent control. */
export default function TraitFacetFilters({ counts, selected, onChange, building, scanned, totalSupply }: Props) {
  const groups = Object.entries(counts ?? {}).filter(([, values]) => Object.keys(values).length > 0)
    .sort(([a], [b]) => a.localeCompare(b));
  return (
    <fieldset>
      <legend className="mb-2 text-[0.62rem] font-black uppercase tracking-wider text-gold-300">Traits</legend>
      {groups.length === 0 ? (
        <p className="rounded-md border border-line bg-wood-950/60 px-2.5 py-2 text-[0.65rem] leading-relaxed text-foreground/50" role="status">
          {building
            ? `Indexing verified traits${scanned ? ` · ${scanned.toLocaleString()}${totalSupply ? ` / ${totalSupply.toLocaleString()}` : ""}` : ""}…`
            : "No verified trait metadata is available for this collection yet."}
        </p>
      ) : (
        <div className="space-y-1.5">
          {building && (
            <p className="rounded-md border border-gold-500/25 bg-gold-500/5 px-2 py-1.5 text-[0.6rem] text-gold-200/70" role="status">
              Verified coverage {scanned?.toLocaleString() ?? "in progress"}{totalSupply ? ` / ${totalSupply.toLocaleString()}` : ""}; filters expand as indexing completes.
            </p>
          )}
          {groups.map(([traitType, values], index) => {
            const active = selected[traitType] ?? "";
            const sorted = Object.entries(values).sort(([, a], [, b]) => b - a);
            return (
              <details key={traitType} open={index < 2 || Boolean(active)} className="rounded-md border border-line bg-wood-950/60">
                <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 px-2 text-xs font-bold text-foreground marker:hidden">
                  <span className="min-w-0 flex-1 truncate">{traitType}</span>
                  {active && <span className="max-w-20 truncate text-gold-300">{active}</span>}
                  <span className="rounded-full bg-foreground/10 px-1.5 py-0.5 text-[0.58rem] tabular-nums text-foreground/55">{sorted.length}</span>
                  <span aria-hidden="true" className="text-foreground/45">⌄</span>
                </summary>
                <div className="max-h-52 overflow-y-auto border-t border-line p-1">
                  {sorted.map(([value, count]) => (
                    <label key={value} className="flex min-h-10 cursor-pointer items-center gap-2 rounded-md px-2 text-xs text-foreground/75 hover:bg-gold-500/10">
                      <input type="checkbox" checked={active === value}
                        onChange={() => onChange({ ...selected, [traitType]: active === value ? "" : value })}
                        className="accent-gold-500" />
                      <span className="min-w-0 flex-1 break-words">{value}</span>
                      <span className="rounded-full bg-foreground/10 px-1.5 py-0.5 text-[0.58rem] tabular-nums text-foreground/55">{count}</span>
                    </label>
                  ))}
                </div>
              </details>
            );
          })}
        </div>
      )}
    </fieldset>
  );
}
