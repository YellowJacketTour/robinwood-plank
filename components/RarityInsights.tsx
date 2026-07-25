"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { GalleryNft } from "@/lib/gallery-types";
import NftImage from "@/components/NftImage";
import {
  TIER_ORDER,
  computeRaritySnapshot,
  formatRank,
  tierColor,
  type RarityTier,
} from "@/lib/rarity";
import {
  MEME_FAMILY_COLOR,
  MEME_FAMILY_ORDER,
  applyFilters,
  countBy,
  crossTab,
  diversityStats,
  donutSegments,
  emptyFilters,
  enrichTokens,
  filtersActive,
  gradedSplit,
  holoLift,
  mintWaveBuckets,
  scoreByDimension,
  topNWithOther,
  type FilterState,
  type MemeFamily,
  type Slice,
} from "@/lib/collection-analytics";

type Props = {
  items: GalleryNft[];
  onSelectToken?: (tokenId: number) => void;
  /** Push active filtered token ids up so Gallery grid can sync */
  onFilteredIdsChange?: (ids: number[] | null) => void;
  compact?: boolean;
};

type DashTab =
  | "overview"
  | "memetics"
  | "splits"
  | "matrix"
  | "holo"
  | "waves"
  | "table";

function StatPill({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <div className="min-w-0 rounded-xl border border-gold-500/25 bg-black/25 px-3 py-2.5">
      <p className="text-[0.65rem] font-extrabold uppercase tracking-[0.14em] text-gold-300/80">
        {label}
      </p>
      <p className="mt-0.5 truncate text-lg font-black text-foreground sm:text-xl">{value}</p>
      {sub && <p className="mt-0.5 truncate text-xs text-foreground/55">{sub}</p>}
    </div>
  );
}

function Panel({
  title,
  subtitle,
  children,
  className = "",
  action,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  className?: string;
  action?: React.ReactNode;
}) {
  return (
    <div
      className={`rounded-xl border border-gold-500/25 bg-black/20 p-3 sm:p-4 ${className}`}
    >
      <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="font-display text-base text-gold-300 sm:text-lg">{title}</h3>
          {subtitle && (
            <p className="mt-0.5 text-[0.7rem] text-foreground/50">{subtitle}</p>
          )}
        </div>
        {action}
      </div>
      {children}
    </div>
  );
}

function DonutChart({
  slices,
  size = 168,
  centerLabel,
  centerSub,
  onSliceClick,
}: {
  slices: Slice[];
  size?: number;
  centerLabel?: string;
  centerSub?: string;
  onSliceClick?: (key: string) => void;
}) {
  const display = topNWithOther(slices, 8);
  const cx = size / 2;
  const cy = size / 2;
  const segs = donutSegments(display, cx, cy, size * 0.42, size * 0.24);

  return (
    <div className="flex flex-col items-center gap-3 sm:flex-row sm:items-start">
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        className="shrink-0"
        role="img"
        aria-label="Pie chart"
      >
        {segs.map((seg) =>
          seg.d ? (
            <path
              key={seg.key}
              d={seg.d}
              fill={seg.color}
              stroke="rgba(0,0,0,0.35)"
              strokeWidth={1}
              className={onSliceClick ? "cursor-pointer opacity-95 hover:opacity-100" : ""}
              onClick={() => onSliceClick?.(seg.key)}
            >
              <title>
                {seg.label}: {seg.count} ({seg.pct.toFixed(1)}%)
              </title>
            </path>
          ) : null,
        )}
        <circle cx={cx} cy={cy} r={size * 0.22} fill="rgba(20,16,11,0.92)" />
        {centerLabel && (
          <text
            x={cx}
            y={cy - 4}
            textAnchor="middle"
            className="fill-[#f8d98a] text-[0.7rem] font-black"
            style={{ fontSize: 13, fontWeight: 900 }}
          >
            {centerLabel}
          </text>
        )}
        {centerSub && (
          <text
            x={cx}
            y={cy + 12}
            textAnchor="middle"
            style={{ fontSize: 10, fill: "rgba(255,242,207,0.55)" }}
          >
            {centerSub}
          </text>
        )}
      </svg>
      <ul className="min-w-0 flex-1 space-y-1">
        {display.map((s) => (
          <li key={s.key}>
            <button
              type="button"
              disabled={!onSliceClick || s.key === "__other__"}
              onClick={() => onSliceClick?.(s.key)}
              className="flex w-full min-w-0 items-center gap-2 rounded-md px-1 py-0.5 text-left text-[0.7rem] hover:bg-white/5 disabled:cursor-default sm:text-xs"
            >
              <span
                className="h-2.5 w-2.5 shrink-0 rounded-sm"
                style={{ background: s.color }}
              />
              <span className="min-w-0 flex-1 truncate font-bold text-foreground/85">
                {s.label}
              </span>
              <span className="shrink-0 font-mono text-foreground/55">
                {s.count} · {s.pct.toFixed(1)}%
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function HBar({
  slices,
  maxBars = 12,
  onClick,
  valueFormat,
}: {
  slices: Slice[];
  maxBars?: number;
  onClick?: (key: string) => void;
  valueFormat?: (s: Slice) => string;
}) {
  const rows = slices.slice(0, maxBars);
  const max = Math.max(1, ...rows.map((r) => r.count));
  return (
    <div className="space-y-1.5">
      {rows.map((row) => (
        <button
          key={row.key}
          type="button"
          disabled={!onClick}
          onClick={() => onClick?.(row.key)}
          className="block w-full min-w-0 text-left disabled:cursor-default"
        >
          <div className="mb-0.5 flex items-center justify-between gap-2 text-[0.7rem] sm:text-xs">
            <span className="min-w-0 truncate font-bold text-foreground/85" title={row.label}>
              {row.label}
            </span>
            <span className="shrink-0 font-mono text-foreground/55">
              {valueFormat
                ? valueFormat(row)
                : `${row.count} · ${row.pct < 1 ? row.pct.toFixed(2) : row.pct.toFixed(1)}%`}
            </span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-black/40">
            <div
              className="h-full rounded-full transition-[width] duration-500"
              style={{
                width: `${(row.count / max) * 100}%`,
                background: `linear-gradient(90deg, ${row.color}99, ${row.color})`,
              }}
            />
          </div>
        </button>
      ))}
    </div>
  );
}

function Stacked100({
  segments,
}: {
  segments: Array<{ label: string; pct: number; color: string; count: number }>;
}) {
  return (
    <div>
      <div className="flex h-8 w-full overflow-hidden rounded-lg border border-gold-500/20">
        {segments.map((s) =>
          s.pct > 0 ? (
            <div
              key={s.label}
              style={{ width: `${s.pct}%`, background: s.color }}
              title={`${s.label}: ${s.count} (${s.pct.toFixed(1)}%)`}
              className="min-w-[2px] transition-[width]"
            />
          ) : null,
        )}
      </div>
      <ul className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[0.65rem]">
        {segments.map((s) => (
          <li key={s.label} className="flex items-center gap-1.5 font-bold text-foreground/70">
            <span className="h-2 w-2 rounded-sm" style={{ background: s.color }} />
            {s.label} {s.pct.toFixed(0)}%
          </li>
        ))}
      </ul>
    </div>
  );
}

function Heatmap({
  rows,
  cols,
  cells,
  max,
  onCell,
}: {
  rows: string[];
  cols: string[];
  cells: { row: string; col: string; count: number; pct: number }[];
  max: number;
  onCell?: (row: string, col: string) => void;
}) {
  const lookup = useMemo(() => {
    const m = new Map<string, { count: number; pct: number }>();
    for (const c of cells) m.set(`${c.row}\0${c.col}`, c);
    return m;
  }, [cells]);

  // Cap display size for readability
  const showRows = rows.slice(0, 14);
  const showCols = cols.slice(0, 10);

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[520px] border-collapse text-[0.65rem] sm:text-xs">
        <thead>
          <tr>
            <th className="sticky left-0 bg-wood-950/90 p-1 text-left font-bold text-gold-300/80">
              Base \ BG
            </th>
            {showCols.map((c) => (
              <th
                key={c}
                className="max-w-[4.5rem] truncate p-1 text-center font-bold text-foreground/55"
                title={c}
              >
                {c.replace(/Graded/i, "G")}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {showRows.map((r) => (
            <tr key={r}>
              <th
                className="sticky left-0 max-w-[7rem] truncate bg-wood-950/90 p-1 text-left font-bold text-foreground/80"
                title={r}
              >
                {r}
              </th>
              {showCols.map((c) => {
                const cell = lookup.get(`${r}\0${c}`);
                const count = cell?.count || 0;
                const intensity = count / Math.max(1, max);
                return (
                  <td key={c} className="p-0.5">
                    <button
                      type="button"
                      disabled={!count || !onCell}
                      onClick={() => onCell?.(r, c)}
                      className="flex h-8 w-full items-center justify-center rounded font-mono text-[0.65rem] font-bold disabled:cursor-default"
                      style={{
                        background:
                          count === 0
                            ? "rgba(0,0,0,0.25)"
                            : `rgba(217,164,65,${0.12 + intensity * 0.75})`,
                        color: intensity > 0.55 ? "#1a0b03" : "#fff2cf",
                      }}
                      title={`${r} × ${c}: ${count}`}
                    >
                      {count || "·"}
                    </button>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      {(rows.length > showRows.length || cols.length > showCols.length) && (
        <p className="mt-2 text-[0.65rem] text-foreground/45">
          Showing top {showRows.length} bases × {showCols.length} backgrounds by volume.
        </p>
      )}
    </div>
  );
}

function CheckboxGroup({
  title,
  options,
  selected,
  onToggle,
  colors,
  maxVisible = 12,
}: {
  title: string;
  options: Array<{ key: string; label: string; count: number }>;
  selected: Set<string>;
  onToggle: (key: string) => void;
  colors?: Record<string, string>;
  maxVisible?: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const list = expanded ? options : options.slice(0, maxVisible);
  return (
    <div className="min-w-0">
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <p className="text-[0.65rem] font-extrabold uppercase tracking-[0.12em] text-gold-300/85">
          {title}
        </p>
        {selected.size > 0 && (
          <span className="text-[0.65rem] font-bold text-gold-300">{selected.size} on</span>
        )}
      </div>
      <ul className="max-h-40 space-y-0.5 overflow-y-auto overscroll-contain pr-1">
        {list.map((opt) => {
          const on = selected.has(opt.key);
          return (
            <li key={opt.key}>
              <label className="flex cursor-pointer items-center gap-2 rounded-md px-1 py-1 hover:bg-white/5">
                <input
                  type="checkbox"
                  checked={on}
                  onChange={() => onToggle(opt.key)}
                  className="h-3.5 w-3.5 accent-[#d9a441]"
                />
                {colors?.[opt.key] && (
                  <span
                    className="h-2 w-2 shrink-0 rounded-sm"
                    style={{ background: colors[opt.key] }}
                  />
                )}
                <span className="min-w-0 flex-1 truncate text-[0.7rem] font-bold text-foreground/85">
                  {opt.label}
                </span>
                <span className="shrink-0 font-mono text-[0.65rem] text-foreground/45">
                  {opt.count}
                </span>
              </label>
            </li>
          );
        })}
      </ul>
      {options.length > maxVisible && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="mt-1 text-[0.65rem] font-extrabold text-gold-300"
        >
          {expanded ? "Show less" : `+${options.length - maxVisible} more`}
        </button>
      )}
    </div>
  );
}

function toggleSet<T>(set: Set<T>, key: T): Set<T> {
  const next = new Set(set);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
}

export default function RarityInsights({
  items,
  onSelectToken,
  onFilteredIdsChange,
  compact = false,
}: Props) {
  const [filters, setFilters] = useState<FilterState>(() => emptyFilters());
  const [tab, setTab] = useState<DashTab>("overview");
  const [compareA, setCompareA] = useState("");
  const [compareB, setCompareB] = useState("");

  const snapshot = useMemo(() => computeRaritySnapshot(items), [items]);
  const enriched = useMemo(() => enrichTokens(items, snapshot), [items, snapshot]);
  const filtered = useMemo(() => applyFilters(enriched, filters), [enriched, filters]);
  const active = filtersActive(filters);

  // Notify parent of filter membership for optional grid sync
  useEffect(() => {
    if (!onFilteredIdsChange) return;
    if (!active) onFilteredIdsChange(null);
    else onFilteredIdsChange(filtered.map((t) => t.tokenId));
  }, [active, filtered, onFilteredIdsChange]);

  const itemById = useMemo(() => {
    const map = new Map<number, GalleryNft>();
    for (const item of items) map.set(item.tokenId, item);
    return map;
  }, [items]);

  // Dimension catalogs from full sample (for filter checkboxes)
  const allBaseOpts = useMemo(
    () =>
      countBy(enriched, (t) => t.traits.Base).map((s) => ({
        key: s.key,
        label: s.label,
        count: s.count,
      })),
    [enriched],
  );
  const allBgOpts = useMemo(
    () =>
      countBy(enriched, (t) => t.traits.Background).map((s) => ({
        key: s.key,
        label: s.label,
        count: s.count,
      })),
    [enriched],
  );
  const allHoloOpts = useMemo(
    () =>
      countBy(enriched, (t) => t.traits.Holographic || "—").map((s) => ({
        key: s.key,
        label: s.label,
        count: s.count,
      })),
    [enriched],
  );
  const allFamilyOpts = useMemo(() => {
    const counts = countBy(enriched, (t) => t.family);
    const map = new Map(counts.map((s) => [s.key, s.count]));
    return MEME_FAMILY_ORDER.filter((f) => map.has(f)).map((f) => ({
      key: f,
      label: f,
      count: map.get(f) || 0,
    }));
  }, [enriched]);

  // Visual data on filtered set
  const baseSlices = useMemo(() => countBy(filtered, (t) => t.traits.Base), [filtered]);
  const bgSlices = useMemo(() => countBy(filtered, (t) => t.traits.Background), [filtered]);
  const holoSlices = useMemo(
    () => countBy(filtered, (t) => t.traits.Holographic || "—"),
    [filtered],
  );
  const familySlices = useMemo(() => {
    const raw = countBy(filtered, (t) => t.family);
    return raw.map((s) => ({
      ...s,
      color: MEME_FAMILY_COLOR[s.key as MemeFamily] || s.color,
    }));
  }, [filtered]);
  const tierSlices = useMemo(() => {
    const counts = new Map<string, number>();
    for (const t of filtered) {
      const tier = t.rarity?.tier || "Unscored";
      counts.set(tier, (counts.get(tier) || 0) + 1);
    }
    return TIER_ORDER.filter((t) => counts.has(t)).map((tier, i) => ({
      key: tier,
      label: tier,
      count: counts.get(tier) || 0,
      pct: filtered.length ? ((counts.get(tier) || 0) / filtered.length) * 100 : 0,
      color: tierColor(tier),
    }));
  }, [filtered]);

  const matrix = useMemo(
    () =>
      crossTab(
        filtered,
        (t) => t.traits.Base,
        (t) => t.traits.Background,
      ),
    [filtered],
  );
  const familyBgMatrix = useMemo(
    () =>
      crossTab(
        filtered,
        (t) => t.family,
        (t) => t.traits.Background,
      ),
    [filtered],
  );
  const graded = useMemo(() => gradedSplit(filtered), [filtered]);
  const lift = useMemo(() => holoLift(filtered), [filtered]);
  const diversity = useMemo(() => diversityStats(filtered), [filtered]);
  const waves = useMemo(() => mintWaveBuckets(filtered, 100), [filtered]);
  const scoreByBase = useMemo(
    () => scoreByDimension(filtered, (t) => t.traits.Base).slice(0, 12),
    [filtered],
  );
  const scoreByFamily = useMemo(
    () => scoreByDimension(filtered, (t) => t.family),
    [filtered],
  );

  const compareStats = useMemo(() => {
    if (!compareA || !compareB || compareA === compareB) return null;
    const a = filtered.filter((t) => t.traits.Base === compareA);
    const b = filtered.filter((t) => t.traits.Base === compareB);
    const avg = (xs: typeof a) => {
      const s = xs.map((t) => t.rarity?.normalizedScore).filter((x): x is number => x != null);
      return s.length ? s.reduce((p, c) => p + c, 0) / s.length : 0;
    };
    const holo = (xs: typeof a) =>
      xs.length
        ? (xs.filter((t) => /yes/i.test(t.traits.Holographic)).length / xs.length) * 100
        : 0;
    const bgDist = (xs: typeof a) => countBy(xs, (t) => t.traits.Background);
    return {
      a: { n: a.length, avg: avg(a), holo: holo(a), bg: bgDist(a) },
      b: { n: b.length, avg: avg(b), holo: holo(b), bg: bgDist(b) },
    };
  }, [compareA, compareB, filtered]);

  const clearFilters = useCallback(() => {
    setFilters(emptyFilters());
  }, []);

  const setBaseOnly = useCallback((base: string) => {
    if (base === "__other__") return;
    setFilters((f) => ({
      ...emptyFilters(),
      bases: new Set([base]),
      search: f.search,
    }));
    setTab("table");
  }, []);

  if (snapshot.sampleSize === 0) {
    return (
      <div className="rounded-xl border border-gold-500/20 bg-black/20 px-4 py-8 text-center text-sm text-foreground/60">
        Indexing revealed metadata for live analytics…
      </div>
    );
  }

  const tabs: Array<{ id: DashTab; label: string }> = [
    { id: "overview", label: "Overview" },
    { id: "memetics", label: "Memetics" },
    { id: "splits", label: "Splits" },
    { id: "matrix", label: "Matrix" },
    { id: "holo", label: "Holo" },
    { id: "waves", label: "Mint waves" },
    { id: "table", label: "Table" },
  ];

  return (
    <div className={`space-y-3 ${compact ? "" : "sm:space-y-4"}`}>
      {/* KPI strip */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6 sm:gap-3">
        <StatPill
          label={active ? "Filtered" : "Scored"}
          value={filtered.length.toLocaleString()}
          sub={active ? `of ${enriched.length.toLocaleString()} revealed` : "with full traits"}
        />
        <StatPill
          label="Base art"
          value={diversity.uniqueBases.toLocaleString()}
          sub={`${diversity.uniqueCombos} unique combos`}
        />
        <StatPill
          label="Holo rate"
          value={`${lift.overallHoloPct.toFixed(1)}%`}
          sub="Yes holographic"
        />
        <StatPill
          label="Graded BG"
          value={`${graded.gradedPct.toFixed(1)}%`}
          sub={`${graded.graded} graded slabs`}
        />
        <StatPill
          label="Diversity"
          value={diversity.simpsonBase.toFixed(2)}
          sub="Simpson · bases"
        />
        <StatPill
          label="Top base share"
          value={`${diversity.topBaseShare.toFixed(1)}%`}
          sub="concentration risk"
        />
      </div>

      {/* Filter rail */}
      <Panel
        title="Dissect filters"
        subtitle="Checkbox · multi-select · live recompute — Tableau-style cut of the woodpile"
        action={
          active ? (
            <button
              type="button"
              onClick={clearFilters}
              className="min-h-9 rounded-lg border border-gold-500/40 px-3 py-1.5 text-xs font-extrabold text-gold-300"
            >
              Clear all
            </button>
          ) : null
        }
      >
        <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center">
          <input
            type="search"
            value={filters.search}
            onChange={(e) => setFilters((f) => ({ ...f, search: e.target.value }))}
            placeholder="Search base, bg, id, family…"
            className="min-h-10 min-w-0 flex-1 rounded-lg border border-gold-500/40 bg-wood-950 px-3 py-2 text-sm font-bold outline-none focus:border-gold-300"
          />
          <div className="flex flex-wrap gap-1.5">
            <button
              type="button"
              onClick={() =>
                setFilters((f) => ({
                  ...f,
                  gradedOnly: f.gradedOnly === true ? null : true,
                }))
              }
              className={`min-h-10 rounded-lg px-3 py-2 text-xs font-extrabold ${
                filters.gradedOnly === true
                  ? "bg-gold-500 text-wood-950"
                  : "border border-gold-500/40 text-gold-300"
              }`}
            >
              Graded only
            </button>
            <button
              type="button"
              onClick={() =>
                setFilters((f) => ({
                  ...f,
                  gradedOnly: f.gradedOnly === false ? null : false,
                }))
              }
              className={`min-h-10 rounded-lg px-3 py-2 text-xs font-extrabold ${
                filters.gradedOnly === false
                  ? "bg-gold-500 text-wood-950"
                  : "border border-gold-500/40 text-gold-300"
              }`}
            >
              Ungraded
            </button>
            <button
              type="button"
              onClick={() =>
                setFilters((f) => ({
                  ...f,
                  holos: f.holos.has("Yes") && f.holos.size === 1
                    ? new Set()
                    : new Set(["Yes"]),
                }))
              }
              className={`min-h-10 rounded-lg px-3 py-2 text-xs font-extrabold ${
                filters.holos.has("Yes") && filters.holos.size === 1
                  ? "bg-gold-500 text-wood-950"
                  : "border border-gold-500/40 text-gold-300"
              }`}
            >
              Holo only
            </button>
          </div>
        </div>

        <div className="mb-3 grid gap-2 sm:grid-cols-2">
          <label className="text-[0.7rem] font-bold text-foreground/70">
            Score {filters.minScore}–{filters.maxScore}
            <div className="mt-1 flex items-center gap-2">
              <input
                type="range"
                min={0}
                max={100}
                value={filters.minScore}
                onChange={(e) =>
                  setFilters((f) => ({
                    ...f,
                    minScore: Math.min(Number(e.target.value), f.maxScore),
                  }))
                }
                className="w-full accent-[#d9a441]"
              />
              <input
                type="range"
                min={0}
                max={100}
                value={filters.maxScore}
                onChange={(e) =>
                  setFilters((f) => ({
                    ...f,
                    maxScore: Math.max(Number(e.target.value), f.minScore),
                  }))
                }
                className="w-full accent-[#d9a441]"
              />
            </div>
          </label>
          <div>
            <p className="mb-1 text-[0.65rem] font-extrabold uppercase tracking-[0.12em] text-gold-300/85">
              Rarity tier
            </p>
            <div className="flex flex-wrap gap-1">
              {TIER_ORDER.map((tier) => {
                const on = filters.tiers.has(tier);
                return (
                  <button
                    key={tier}
                    type="button"
                    onClick={() =>
                      setFilters((f) => ({
                        ...f,
                        tiers: toggleSet(f.tiers, tier),
                      }))
                    }
                    className="rounded-full px-2.5 py-1 text-[0.65rem] font-extrabold"
                    style={{
                      color: tierColor(tier),
                      border: `1px solid ${tierColor(tier)}${on ? "ff" : "55"}`,
                      background: on ? `${tierColor(tier)}33` : "transparent",
                    }}
                  >
                    {tier}
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <CheckboxGroup
            title="Base (meme art)"
            options={allBaseOpts}
            selected={filters.bases}
            onToggle={(key) =>
              setFilters((f) => ({ ...f, bases: toggleSet(f.bases, key) }))
            }
          />
          <CheckboxGroup
            title="Background (grade)"
            options={allBgOpts}
            selected={filters.backgrounds}
            onToggle={(key) =>
              setFilters((f) => ({
                ...f,
                backgrounds: toggleSet(f.backgrounds, key),
              }))
            }
          />
          <CheckboxGroup
            title="Holographic"
            options={allHoloOpts}
            selected={filters.holos}
            onToggle={(key) =>
              setFilters((f) => ({ ...f, holos: toggleSet(f.holos, key) }))
            }
          />
          <CheckboxGroup
            title="Meme family"
            options={allFamilyOpts}
            selected={filters.families as Set<string>}
            colors={MEME_FAMILY_COLOR as Record<string, string>}
            onToggle={(key) =>
              setFilters((f) => ({
                ...f,
                families: toggleSet(f.families, key as MemeFamily),
              }))
            }
          />
        </div>
      </Panel>

      {/* Tab bar */}
      <div className="flex flex-wrap gap-1.5">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className={`min-h-9 rounded-lg px-3 py-1.5 text-xs font-extrabold sm:text-sm ${
              tab === t.id
                ? "bg-gold-500 text-wood-950"
                : "border border-gold-500/40 text-gold-300"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* ─── OVERVIEW ─── */}
      {tab === "overview" && (
        <div className="grid gap-3 lg:grid-cols-2">
          <Panel title="Background mix" subtitle="Grade slabs · pie">
            <DonutChart
              slices={bgSlices}
              centerLabel={`${bgSlices.length}`}
              centerSub="grades"
              onSliceClick={(key) => {
                if (key === "__other__") return;
                setFilters((f) => ({
                  ...f,
                  backgrounds: toggleSet(f.backgrounds, key),
                }));
              }}
            />
          </Panel>
          <Panel title="Holographic split" subtitle="Yes vs No · pie">
            <DonutChart
              slices={holoSlices.map((s, i) => ({
                ...s,
                color: /yes/i.test(s.key) ? "#67e8f9" : i === 0 ? "#78716c" : s.color,
              }))}
              centerLabel={`${lift.overallHoloPct.toFixed(0)}%`}
              centerSub="holo"
            />
          </Panel>
          <Panel title="Base art share" subtitle="Memetic faces of the collection">
            <DonutChart slices={baseSlices} centerLabel={String(baseSlices.length)} centerSub="bases" onSliceClick={setBaseOnly} />
          </Panel>
          <Panel title="Tier mix" subtitle="Statistical rarity tiers">
            <DonutChart slices={tierSlices} centerLabel={String(filtered.length)} centerSub="scored" />
            <div className="mt-3">
              <HBar slices={tierSlices} maxBars={6} />
            </div>
          </Panel>
          <Panel
            title="Score distribution"
            subtitle="Common → rare histogram"
            className="lg:col-span-2"
          >
            <div className="flex h-32 items-end gap-1 sm:h-36 sm:gap-1.5">
              {snapshot.histogram.map((bucket) => {
                const max = Math.max(1, ...snapshot.histogram.map((b) => b.count));
                // Recompute counts on filtered set for accuracy
                const count = filtered.filter((t) => {
                  const s = t.rarity?.normalizedScore ?? -1;
                  return s >= bucket.min && (bucket.max >= 100 ? s <= 100 : s < bucket.max);
                }).length;
                const height = Math.max(4, (count / max) * 100);
                return (
                  <div key={bucket.label} className="flex min-w-0 flex-1 flex-col items-center gap-1">
                    <span className="font-mono text-[0.6rem] text-foreground/50">{count || ""}</span>
                    <div
                      className="w-full rounded-t-md bg-gradient-to-t from-gold-500/40 to-gold-300/90"
                      style={{ height: `${height}%` }}
                      title={`${bucket.label}: ${count}`}
                    />
                    <span className="w-full truncate text-center font-mono text-[0.55rem] text-foreground/45">
                      {bucket.label}
                    </span>
                  </div>
                );
              })}
            </div>
          </Panel>
        </div>
      )}

      {/* ─── MEMETICS ─── */}
      {tab === "memetics" && (
        <div className="space-y-3">
          <Panel
            title="Meme family taxonomy"
            subtitle="How the woodpile jokes — wood puns, net classics, RH lore, meta-art"
          >
            <div className="grid gap-4 lg:grid-cols-2">
              <DonutChart
                slices={familySlices}
                centerLabel={String(familySlices.length)}
                centerSub="families"
                onSliceClick={(key) => {
                  if (key === "__other__") return;
                  setFilters((f) => ({
                    ...f,
                    families: toggleSet(f.families, key as MemeFamily),
                  }));
                }}
              />
              <HBar
                slices={familySlices}
                maxBars={13}
                onClick={(key) =>
                  setFilters((f) => ({
                    ...f,
                    families: toggleSet(f.families, key as MemeFamily),
                  }))
                }
              />
            </div>
          </Panel>

          <Panel
            title="Family × background heatmap"
            subtitle="Which grades dress which meme tribes"
          >
            <Heatmap
              rows={familyBgMatrix.rows}
              cols={familyBgMatrix.cols}
              cells={familyBgMatrix.cells}
              max={familyBgMatrix.max}
            />
          </Panel>

          <Panel title="Base vs base compare" subtitle="Side-by-side meme A/B">
            <div className="mb-3 grid gap-2 sm:grid-cols-2">
              <label className="text-xs font-bold text-foreground/70">
                Meme A
                <select
                  value={compareA}
                  onChange={(e) => setCompareA(e.target.value)}
                  className="mt-1 min-h-10 w-full rounded-lg border border-gold-500/40 bg-wood-950 px-2 py-2 text-sm font-bold text-foreground"
                >
                  <option value="">Select base…</option>
                  {allBaseOpts.map((o) => (
                    <option key={o.key} value={o.key}>
                      {o.label} ({o.count})
                    </option>
                  ))}
                </select>
              </label>
              <label className="text-xs font-bold text-foreground/70">
                Meme B
                <select
                  value={compareB}
                  onChange={(e) => setCompareB(e.target.value)}
                  className="mt-1 min-h-10 w-full rounded-lg border border-gold-500/40 bg-wood-950 px-2 py-2 text-sm font-bold text-foreground"
                >
                  <option value="">Select base…</option>
                  {allBaseOpts.map((o) => (
                    <option key={o.key} value={o.key}>
                      {o.label} ({o.count})
                    </option>
                  ))}
                </select>
              </label>
            </div>
            {compareStats ? (
              <div className="grid gap-3 sm:grid-cols-2">
                {(
                  [
                    [compareA, compareStats.a],
                    [compareB, compareStats.b],
                  ] as const
                ).map(([name, st]) => (
                  <div
                    key={name}
                    className="rounded-lg border border-gold-500/20 bg-black/30 p-3"
                  >
                    <p className="truncate font-display text-gold-300">{name}</p>
                    <dl className="mt-2 grid grid-cols-3 gap-2 text-center">
                      <div>
                        <dt className="text-[0.6rem] uppercase text-foreground/50">n</dt>
                        <dd className="font-mono font-black">{st.n}</dd>
                      </div>
                      <div>
                        <dt className="text-[0.6rem] uppercase text-foreground/50">avg</dt>
                        <dd className="font-mono font-black">{st.avg.toFixed(1)}</dd>
                      </div>
                      <div>
                        <dt className="text-[0.6rem] uppercase text-foreground/50">holo</dt>
                        <dd className="font-mono font-black">{st.holo.toFixed(0)}%</dd>
                      </div>
                    </dl>
                    <div className="mt-2">
                      <HBar slices={st.bg} maxBars={6} />
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-foreground/55">
                Pick two Base arts to contrast supply, avg score, holo rate, and grade mix.
              </p>
            )}
          </Panel>

          <Panel title="Avg score by meme family" subtitle="Which joke families punch above weight">
            <div className="space-y-1.5">
              {scoreByFamily.map((row) => {
                const max = Math.max(1, ...scoreByFamily.map((r) => r.avg));
                return (
                  <div key={row.key}>
                    <div className="mb-0.5 flex justify-between gap-2 text-[0.7rem]">
                      <span
                        className="font-bold"
                        style={{
                          color: MEME_FAMILY_COLOR[row.key as MemeFamily] || undefined,
                        }}
                      >
                        {row.key}
                      </span>
                      <span className="font-mono text-foreground/55">
                        avg {row.avg.toFixed(1)} · n={row.n}
                      </span>
                    </div>
                    <div className="h-1.5 overflow-hidden rounded-full bg-black/40">
                      <div
                        className="h-full rounded-full"
                        style={{
                          width: `${(row.avg / max) * 100}%`,
                          background:
                            MEME_FAMILY_COLOR[row.key as MemeFamily] || "#d9a441",
                        }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          </Panel>
        </div>
      )}

      {/* ─── SPLITS ─── */}
      {tab === "splits" && (
        <div className="grid gap-3 lg:grid-cols-2">
          <Panel title="100% stacked · Background" subtitle="Composition bar">
            <Stacked100
              segments={bgSlices.map((s) => ({
                label: s.label,
                pct: s.pct,
                color: s.color,
                count: s.count,
              }))}
            />
          </Panel>
          <Panel title="100% stacked · Holo" subtitle="Binary foil split">
            <Stacked100
              segments={holoSlices.map((s) => ({
                label: s.label,
                pct: s.pct,
                color: /yes/i.test(s.key) ? "#67e8f9" : "#78716c",
                count: s.count,
              }))}
            />
          </Panel>
          <Panel title="100% stacked · Meme family">
            <Stacked100
              segments={familySlices.map((s) => ({
                label: s.label,
                pct: s.pct,
                color: s.color,
                count: s.count,
              }))}
            />
          </Panel>
          <Panel title="100% stacked · Tier">
            <Stacked100
              segments={tierSlices.map((s) => ({
                label: s.label,
                pct: s.pct,
                color: s.color,
                count: s.count,
              }))}
            />
          </Panel>
          <Panel title="Graded vs plain backgrounds" subtitle="Slab culture">
            <DonutChart
              slices={[
                {
                  key: "graded",
                  label: "Graded",
                  count: graded.graded,
                  pct: graded.gradedPct,
                  color: "#f8d98a",
                },
                {
                  key: "plain",
                  label: "Plain",
                  count: graded.plain,
                  pct: 100 - graded.gradedPct,
                  color: "#5c3a1e",
                },
              ]}
              centerLabel={`${graded.gradedPct.toFixed(0)}%`}
              centerSub="graded"
            />
            <div className="mt-3">
              <HBar slices={graded.byBgTier} maxBars={10} />
            </div>
          </Panel>
          <Panel title="Rarest bases by avg score" subtitle="Power ranking · min sample in filter">
            <div className="space-y-1.5">
              {scoreByBase.map((row, i) => (
                <button
                  key={row.key}
                  type="button"
                  onClick={() => setBaseOnly(row.key)}
                  className="block w-full text-left"
                >
                  <div className="mb-0.5 flex justify-between gap-2 text-[0.7rem]">
                    <span className="truncate font-bold text-foreground/90">
                      <span className="text-foreground/40">{i + 1}.</span> {row.key}
                    </span>
                    <span className="shrink-0 font-mono text-foreground/55">
                      {row.avg.toFixed(1)} · n={row.n}
                    </span>
                  </div>
                  <div className="h-1.5 overflow-hidden rounded-full bg-black/40">
                    <div
                      className="h-full rounded-full bg-gold-500"
                      style={{
                        width: `${(row.avg / Math.max(1, scoreByBase[0]?.avg || 1)) * 100}%`,
                      }}
                    />
                  </div>
                </button>
              ))}
            </div>
          </Panel>
        </div>
      )}

      {/* ─── MATRIX ─── */}
      {tab === "matrix" && (
        <div className="space-y-3">
          <Panel
            title="Base × Background cross-tab"
            subtitle="Click a cell to filter that intersection"
          >
            <Heatmap
              rows={matrix.rows}
              cols={matrix.cols}
              cells={matrix.cells}
              max={matrix.max}
              onCell={(row, col) => {
                setFilters((f) => ({
                  ...f,
                  bases: new Set([row]),
                  backgrounds: new Set([col]),
                }));
                setTab("table");
              }}
            />
          </Panel>
          <Panel title="Top bases (volume)" subtitle="Click to isolate">
            <HBar slices={baseSlices} maxBars={16} onClick={setBaseOnly} />
          </Panel>
        </div>
      )}

      {/* ─── HOLO ─── */}
      {tab === "holo" && (
        <div className="grid gap-3 lg:grid-cols-2">
          <Panel title="Holo rate overall" subtitle="Collection foil density">
            <DonutChart
              slices={holoSlices.map((s) => ({
                ...s,
                color: /yes/i.test(s.key) ? "#67e8f9" : "#57534e",
              }))}
              centerLabel={`${lift.overallHoloPct.toFixed(1)}%`}
              centerSub="Yes"
            />
          </Panel>
          <Panel
            title="Holo lift by Base"
            subtitle=">1.0 = more holo than average · meme foil magnets"
          >
            <div className="space-y-1.5">
              {lift.byBase.map((row) => (
                <button
                  key={row.base}
                  type="button"
                  onClick={() => setBaseOnly(row.base)}
                  className="block w-full text-left"
                >
                  <div className="mb-0.5 flex justify-between gap-2 text-[0.7rem]">
                    <span className="truncate font-bold">{row.base}</span>
                    <span className="shrink-0 font-mono text-foreground/55">
                      lift {row.lift.toFixed(2)}× · {row.holo}/{row.total}
                    </span>
                  </div>
                  <div className="h-1.5 overflow-hidden rounded-full bg-black/40">
                    <div
                      className="h-full rounded-full bg-cyan-400/90"
                      style={{
                        width: `${Math.min(100, (row.lift / 3) * 100)}%`,
                      }}
                    />
                  </div>
                </button>
              ))}
              {!lift.byBase.length && (
                <p className="text-sm text-foreground/55">Need more holo samples in filter.</p>
              )}
            </div>
          </Panel>
          <Panel title="Holo lift by Background" subtitle="Which grades get the foil">
            <div className="space-y-1.5">
              {lift.byBackground.map((row) => (
                <div key={row.bg}>
                  <div className="mb-0.5 flex justify-between gap-2 text-[0.7rem]">
                    <span className="truncate font-bold">{row.bg}</span>
                    <span className="shrink-0 font-mono text-foreground/55">
                      lift {row.lift.toFixed(2)}× · {row.holo}/{row.total}
                    </span>
                  </div>
                  <div className="h-1.5 overflow-hidden rounded-full bg-black/40">
                    <div
                      className="h-full rounded-full bg-cyan-300/80"
                      style={{
                        width: `${Math.min(100, (row.lift / 3) * 100)}%`,
                      }}
                    />
                  </div>
                </div>
              ))}
            </div>
          </Panel>
          <Panel title="Holo strip across mint waves" subtitle="Did foil rate change over time?">
            <div className="flex h-28 items-end gap-0.5 sm:h-32">
              {waves.map((w) => (
                <div
                  key={w.label}
                  className="flex min-w-0 flex-1 flex-col items-center justify-end"
                  title={`${w.label}: ${w.holoPct.toFixed(1)}% holo`}
                >
                  <div
                    className="w-full rounded-t bg-cyan-400/85"
                    style={{ height: `${Math.max(3, w.holoPct)}%` }}
                  />
                </div>
              ))}
            </div>
            <p className="mt-1 text-center text-[0.6rem] text-foreground/45">
              token id → time · bar = holo %
            </p>
          </Panel>
        </div>
      )}

      {/* ─── WAVES ─── */}
      {tab === "waves" && (
        <div className="space-y-3">
          <Panel
            title="Mint waves (by token id)"
            subtitle="Early wood vs late wood — supply, avg score, holo"
          >
            <div className="overflow-x-auto">
              <table className="w-full min-w-[480px] text-left text-xs">
                <thead>
                  <tr className="border-b border-gold-500/20 text-gold-300/80">
                    <th className="p-2">Wave</th>
                    <th className="p-2">n</th>
                    <th className="p-2">Avg score</th>
                    <th className="p-2">Holo %</th>
                    <th className="p-2 w-[40%]">Volume</th>
                  </tr>
                </thead>
                <tbody>
                  {waves.map((w) => {
                    const maxN = Math.max(1, ...waves.map((x) => x.count));
                    return (
                      <tr key={w.label} className="border-b border-white/5">
                        <td className="p-2 font-mono font-bold text-gold-300">{w.label}</td>
                        <td className="p-2 font-mono">{w.count}</td>
                        <td className="p-2 font-mono">{w.avgScore.toFixed(1)}</td>
                        <td className="p-2 font-mono">{w.holoPct.toFixed(1)}%</td>
                        <td className="p-2">
                          <div className="h-2 overflow-hidden rounded-full bg-black/40">
                            <div
                              className="h-full rounded-full bg-gold-500"
                              style={{ width: `${(w.count / maxN) * 100}%` }}
                            />
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Panel>
          <Panel title="Avg score by wave" subtitle="Did rarer combos print later?">
            <div className="flex h-36 items-end gap-1">
              {waves.map((w) => {
                const max = Math.max(1, ...waves.map((x) => x.avgScore));
                return (
                  <div key={w.label} className="flex min-w-0 flex-1 flex-col items-center gap-1">
                    <span className="font-mono text-[0.55rem] text-foreground/50">
                      {w.avgScore.toFixed(0)}
                    </span>
                    <div
                      className="w-full rounded-t-md bg-gradient-to-t from-violet-500/50 to-gold-300/90"
                      style={{ height: `${Math.max(4, (w.avgScore / max) * 100)}%` }}
                    />
                    <span className="w-full truncate text-center font-mono text-[0.5rem] text-foreground/40">
                      {w.from}
                    </span>
                  </div>
                );
              })}
            </div>
          </Panel>
        </div>
      )}

      {/* ─── TABLE ─── */}
      {tab === "table" && (
        <div className="space-y-3">
          <Panel
            title="Filtered Planks"
            subtitle={`${filtered.length.toLocaleString()} rows · click to open`}
          >
            <div className="max-h-[28rem] overflow-auto">
              <table className="w-full min-w-[640px] text-left text-xs">
                <thead className="sticky top-0 bg-wood-950/95">
                  <tr className="border-b border-gold-500/25 text-gold-300/85">
                    <th className="p-2">ID</th>
                    <th className="p-2">Preview</th>
                    <th className="p-2">Base</th>
                    <th className="p-2">Background</th>
                    <th className="p-2">Holo</th>
                    <th className="p-2">Family</th>
                    <th className="p-2">Tier</th>
                    <th className="p-2">Rank</th>
                    <th className="p-2">Score</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered
                    .slice()
                    .sort(
                      (a, b) =>
                        (a.rarity?.rank ?? 99999) - (b.rarity?.rank ?? 99999) ||
                        a.tokenId - b.tokenId,
                    )
                    .slice(0, 200)
                    .map((t) => (
                      <tr
                        key={t.tokenId}
                        className="cursor-pointer border-b border-white/5 hover:bg-gold-500/10"
                        onClick={() => onSelectToken?.(t.tokenId)}
                      >
                        <td className="p-2 font-mono font-bold text-gold-300">#{t.tokenId}</td>
                        <td className="p-1">
                          <div className="h-9 w-9 overflow-hidden rounded bg-wood-950">
                            <NftImage
                              imageUri={t.imageUri}
                              alt=""
                              className="h-full w-full object-cover"
                            />
                          </div>
                        </td>
                        <td className="max-w-[8rem] truncate p-2 font-bold" title={t.traits.Base}>
                          {t.traits.Base}
                        </td>
                        <td className="max-w-[7rem] truncate p-2" title={t.traits.Background}>
                          {t.traits.Background}
                        </td>
                        <td className="p-2 font-mono">
                          {/yes/i.test(t.traits.Holographic) ? (
                            <span className="text-cyan-300">Yes</span>
                          ) : (
                            <span className="text-foreground/45">No</span>
                          )}
                        </td>
                        <td
                          className="max-w-[7rem] truncate p-2 text-[0.65rem] font-bold"
                          style={{ color: MEME_FAMILY_COLOR[t.family] }}
                        >
                          {t.family}
                        </td>
                        <td
                          className="p-2 font-bold"
                          style={{
                            color: t.rarity ? tierColor(t.rarity.tier) : undefined,
                          }}
                        >
                          {t.rarity?.tier || "—"}
                        </td>
                        <td className="p-2 font-mono">
                          {t.rarity ? formatRank(t.rarity.rank) : "—"}
                        </td>
                        <td className="p-2 font-mono">
                          {t.rarity ? t.rarity.normalizedScore.toFixed(1) : "—"}
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
              {filtered.length > 200 && (
                <p className="mt-2 text-center text-[0.7rem] text-foreground/45">
                  Showing first 200 of {filtered.length.toLocaleString()} — tighten filters to
                  zoom in.
                </p>
              )}
            </div>
          </Panel>
        </div>
      )}

      {/* Rarest strip always visible */}
      <Panel
        title="Rarest in current cut"
        subtitle="Live ranks · revealed only"
        action={
          <span className="text-[0.65rem] font-bold uppercase tracking-wide text-foreground/45">
            {active ? "filtered" : "full sample"}
          </span>
        }
      >
        <ul className="grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-6">
          {filtered
            .filter((t) => t.rarity)
            .sort((a, b) => (a.rarity!.rank) - (b.rarity!.rank))
            .slice(0, compact ? 6 : 12)
            .map((t) => {
              const nft = itemById.get(t.tokenId);
              const rarity = t.rarity!;
              if (!nft) return null;
              return (
                <li key={t.tokenId}>
                  <button
                    type="button"
                    onClick={() => onSelectToken?.(t.tokenId)}
                    className="group flex w-full flex-col overflow-hidden rounded-lg border border-gold-500/25 bg-wood-950/60 text-left transition-transform hover:-translate-y-0.5"
                  >
                    <div className="relative aspect-square w-full bg-wood-950">
                      <NftImage
                        imageUri={nft.imageUri}
                        alt=""
                        className="h-full w-full object-cover"
                      />
                      <span
                        className="absolute left-1 top-1 rounded px-1.5 py-0.5 text-[0.6rem] font-black"
                        style={{
                          background: `${tierColor(rarity.tier)}22`,
                          color: tierColor(rarity.tier),
                          border: `1px solid ${tierColor(rarity.tier)}66`,
                        }}
                      >
                        {formatRank(rarity.rank)}
                      </span>
                    </div>
                    <div className="p-1.5">
                      <p className="truncate font-mono text-[0.65rem] text-gold-300">
                        #{t.tokenId}
                      </p>
                      <p className="truncate text-[0.6rem] font-bold text-foreground/70">
                        {t.traits.Base}
                      </p>
                      <p
                        className="truncate text-[0.6rem] font-bold"
                        style={{ color: tierColor(rarity.tier) }}
                      >
                        {rarity.tier} · {rarity.normalizedScore.toFixed(0)}
                      </p>
                    </div>
                  </button>
                </li>
              );
            })}
        </ul>
      </Panel>

      <p className="text-center text-[0.7rem] text-foreground/45">
        Analytics recompute on the live revealed sample · memetic families are heuristic name
        clusters · graded = Background ends with &quot;Graded&quot;
      </p>
    </div>
  );
}

export { computeRaritySnapshot };
