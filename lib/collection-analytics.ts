/**
 * Tableau-style analytics for RobinWood Plank collection.
 * Traits: Base (meme art), Background (grade), Holographic (Yes/No).
 */

import type { NftAttribute } from "@/lib/ipfs";
import {
  computeRaritySnapshot,
  type RaritySnapshot,
  type RarityTier,
  type TokenRarity,
} from "@/lib/rarity";

export type AnalyticToken = {
  tokenId: number;
  name: string;
  imageUri: string;
  attributes: NftAttribute[];
  loaded: boolean;
  owner?: string;
};

export type TraitMap = {
  Base: string;
  Background: string;
  Holographic: string;
  /** other traits if any */
  extra: Record<string, string>;
};

/** Memetic families — how the woodpile tells jokes */
export type MemeFamily =
  | "Swag / Merch"
  | "Chalk Crew"
  | "Pop Culture Parody"
  | "Wood Puns"
  | "Internet Classics"
  | "Finance / Crypto"
  | "Trains & Vehicles"
  | "Art / Meta"
  | "Personas / Characters"
  | "Robinhood Lore"
  | "Redacted / Mystery"
  | "Other Wood";

export type Slice = {
  key: string;
  label: string;
  count: number;
  pct: number;
  color: string;
};

export type CrossCell = {
  row: string;
  col: string;
  count: number;
  pct: number;
};

export type FilterState = {
  bases: Set<string>;
  backgrounds: Set<string>;
  holos: Set<string>;
  tiers: Set<RarityTier>;
  families: Set<MemeFamily>;
  gradedOnly: boolean | null; // null = any, true = *Graded, false = plain
  minScore: number; // 0–100
  maxScore: number;
  search: string;
};

export function emptyFilters(): FilterState {
  return {
    bases: new Set(),
    backgrounds: new Set(),
    holos: new Set(),
    tiers: new Set(),
    families: new Set(),
    gradedOnly: null,
    minScore: 0,
    maxScore: 100,
    search: "",
  };
}

export function filtersActive(f: FilterState): boolean {
  return (
    f.bases.size > 0 ||
    f.backgrounds.size > 0 ||
    f.holos.size > 0 ||
    f.tiers.size > 0 ||
    f.families.size > 0 ||
    f.gradedOnly !== null ||
    f.minScore > 0 ||
    f.maxScore < 100 ||
    f.search.trim().length > 0
  );
}

const PALETTE = [
  "#d9a441",
  "#f8d98a",
  "#86efac",
  "#93c5fd",
  "#c4b5fd",
  "#f0abfc",
  "#fca5a5",
  "#67e8f9",
  "#fdba74",
  "#a5b4fc",
  "#6ee7b7",
  "#fcd34d",
  "#e879f9",
  "#34d399",
  "#60a5fa",
  "#fb7185",
  "#a3e635",
  "#38bdf8",
  "#c084fc",
  "#fbbf24",
];

export function colorAt(i: number): string {
  return PALETTE[i % PALETTE.length];
}

export function parseTraits(attributes: NftAttribute[]): TraitMap {
  const map: TraitMap = {
    Base: "",
    Background: "",
    Holographic: "",
    extra: {},
  };
  for (const a of attributes) {
    const trait = String(a.trait_type ?? "").trim();
    const value = String(a.value ?? "—").trim() || "—";
    if (trait === "Base") map.Base = value;
    else if (trait === "Background") map.Background = value;
    else if (trait === "Holographic") map.Holographic = value;
    else if (trait) map.extra[trait] = value;
  }
  return map;
}

export function isGradedBackground(bg: string): boolean {
  return /graded/i.test(bg);
}

export function backgroundTierLabel(bg: string): string {
  return bg.replace(/Graded$/i, "").trim() || bg;
}

/**
 * Classify Base art into memetic families using name heuristics.
 * Tuned to real RobinWood bases: Swag*, Chalk*, WoodaLisa, BoardFloyd, etc.
 */
export function classifyMemeFamily(base: string): MemeFamily {
  const raw = base.trim();
  const b = raw.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const compact = raw.toLowerCase().replace(/[^a-z0-9]/g, "");

  if (/redact|mystery|unknown|censored|classified/.test(b)) {
    return "Redacted / Mystery";
  }

  // Swag merch line — freebies, hoodies, VIP drip
  if (/swag|freebie|hoodie|classic.?tee|team.?swag|vip/.test(b) || /swag/.test(compact)) {
    return "Swag / Merch";
  }

  // Chalk series
  if (/chalk|chalktor/.test(b)) {
    return "Chalk Crew";
  }

  // Film / music / history parodies (BoardFloyd, ClockWoodOrange, PlankoCorleone…)
  if (
    /boardfloyd|floyd|clockwood|orange|corleone|godfather|fearandwood|vegas|woodalisa|monalisa|lis a|majortom|alexander|tut\b|planktut|viking|sailor|cowboy|pirate|argg|knight|holywood|hollywood|woodyplankelson|thatswoody|dickhardwood|planji|jugger|burnie|winterwonder/.test(
      compact,
    ) ||
    /floyd|corleone|clock.?wood|fear and|vegas|lisa|major tom|alexander|tut|viking|sailor|cowboy|argg|knight|holy.?wood|woody baby|hardwood|jugger|wonderland/.test(
      b,
    )
  ) {
    return "Pop Culture Parody";
  }

  if (
    /robinwood|robin wood|woodlist|free mint|plank.?love|bravewood|allthefreebie/.test(compact) ||
    /robin.?wood|brave.?wood|classic$/.test(b)
  ) {
    return "Robinhood Lore";
  }

  if (
    /shitcoin|millionaire|rekt|hackoor|ape.?wood|degen|nft|crypto|wagmi|ngmi|hodl/.test(compact) ||
    /shitcoin|millionaire|rekt|hackoor|ape|crypto|degen/.test(b)
  ) {
    return "Finance / Crypto";
  }

  if (
    /thomas|engine|train|plankrboard|board$/.test(compact) ||
    /thomas|engine|train/.test(b)
  ) {
    return "Trains & Vehicles";
  }

  if (
    /is this art|this is art|woodalisa|meta.?art|gallery/.test(b) ||
    /isthisart|woodalisa/.test(compact)
  ) {
    return "Art / Meta";
  }

  if (
    /kakashi|hinoki|plankychan|agent|docwood|dralder|grandpa|vacation|chipper|woodman|woodby|woood y|wooody|eddy|edd\b|masterplank|streetwood|vibe|miami|superwood|slice|drift/.test(
      compact,
    ) ||
    /kakashi|hinoki|chan|agent|doc |dr |grandpa|vacation|chipper|wizard|dapper|stash|persona|man\b|woodman|master|street|vibe|miami|super|slice/.test(
      b,
    )
  ) {
    return "Personas / Characters";
  }

  if (
    /is this|pepe|wojak|doge|meme|viral|npc|chad/.test(b)
  ) {
    return "Internet Classics";
  }

  if (
    /wood|plank|timber|oak|pine|alder|hinoki|log|board|drift|splinter|bark|tree|chip|stick/.test(
      b,
    )
  ) {
    return "Wood Puns";
  }

  return "Other Wood";
}

export const MEME_FAMILY_ORDER: MemeFamily[] = [
  "Swag / Merch",
  "Chalk Crew",
  "Pop Culture Parody",
  "Personas / Characters",
  "Wood Puns",
  "Art / Meta",
  "Finance / Crypto",
  "Robinhood Lore",
  "Internet Classics",
  "Trains & Vehicles",
  "Redacted / Mystery",
  "Other Wood",
];

export const MEME_FAMILY_COLOR: Record<MemeFamily, string> = {
  "Swag / Merch": "#f8d98a",
  "Chalk Crew": "#e7e5e4",
  "Pop Culture Parody": "#f0abfc",
  "Personas / Characters": "#fdba74",
  "Wood Puns": "#d9a441",
  "Art / Meta": "#c4b5fd",
  "Finance / Crypto": "#67e8f9",
  "Robinhood Lore": "#86efac",
  "Internet Classics": "#fca5a5",
  "Trains & Vehicles": "#93c5fd",
  "Redacted / Mystery": "#a8a29e",
  "Other Wood": "#a3a3a3",
};

export type EnrichedToken = AnalyticToken & {
  traits: TraitMap;
  family: MemeFamily;
  graded: boolean;
  bgTier: string;
  rarity?: TokenRarity;
};

export function enrichTokens(
  items: AnalyticToken[],
  snapshot?: RaritySnapshot,
): EnrichedToken[] {
  const snap = snapshot ?? computeRaritySnapshot(items);
  return items
    .filter((i) => i.loaded && i.attributes.length > 0)
    .map((item) => {
      const traits = parseTraits(item.attributes);
      return {
        ...item,
        traits,
        family: classifyMemeFamily(traits.Base || item.name),
        graded: isGradedBackground(traits.Background),
        bgTier: backgroundTierLabel(traits.Background),
        rarity: snap.byTokenId.get(item.tokenId),
      };
    });
}

export function applyFilters(
  tokens: EnrichedToken[],
  filters: FilterState,
): EnrichedToken[] {
  const q = filters.search.trim().toLowerCase();
  return tokens.filter((t) => {
    if (filters.bases.size && !filters.bases.has(t.traits.Base)) return false;
    if (filters.backgrounds.size && !filters.backgrounds.has(t.traits.Background))
      return false;
    if (filters.holos.size && !filters.holos.has(t.traits.Holographic)) return false;
    if (filters.tiers.size) {
      if (!t.rarity || !filters.tiers.has(t.rarity.tier)) return false;
    }
    if (filters.families.size && !filters.families.has(t.family)) return false;
    if (filters.gradedOnly === true && !t.graded) return false;
    if (filters.gradedOnly === false && t.graded) return false;
    if (t.rarity) {
      if (t.rarity.normalizedScore < filters.minScore) return false;
      if (t.rarity.normalizedScore > filters.maxScore) return false;
    } else if (filters.minScore > 0 || filters.maxScore < 100) {
      return false;
    }
    if (q) {
      const hay = [
        t.name,
        String(t.tokenId),
        t.traits.Base,
        t.traits.Background,
        t.traits.Holographic,
        t.family,
        t.owner || "",
      ]
        .join(" ")
        .toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

function toSlices(
  counts: Map<string, number>,
  total: number,
  sort: "count" | "label" = "count",
): Slice[] {
  const entries = Array.from(counts.entries());
  if (sort === "count") entries.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  else entries.sort((a, b) => a[0].localeCompare(b[0]));
  return entries.map(([key, count], i) => ({
    key,
    label: key || "—",
    count,
    pct: total > 0 ? (count / total) * 100 : 0,
    color: colorAt(i),
  }));
}

export function countBy(
  tokens: EnrichedToken[],
  keyFn: (t: EnrichedToken) => string,
): Slice[] {
  const counts = new Map<string, number>();
  for (const t of tokens) {
    const k = keyFn(t) || "—";
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  return toSlices(counts, tokens.length);
}

export function crossTab(
  tokens: EnrichedToken[],
  rowFn: (t: EnrichedToken) => string,
  colFn: (t: EnrichedToken) => string,
): { rows: string[]; cols: string[]; cells: CrossCell[]; max: number } {
  const matrix = new Map<string, number>();
  const rowSet = new Map<string, number>();
  const colSet = new Map<string, number>();
  for (const t of tokens) {
    const r = rowFn(t) || "—";
    const c = colFn(t) || "—";
    const k = `${r}\0${c}`;
    matrix.set(k, (matrix.get(k) || 0) + 1);
    rowSet.set(r, (rowSet.get(r) || 0) + 1);
    colSet.set(c, (colSet.get(c) || 0) + 1);
  }
  const rows = Array.from(rowSet.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([k]) => k);
  const cols = Array.from(colSet.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([k]) => k);
  const cells: CrossCell[] = [];
  let max = 1;
  const n = tokens.length || 1;
  for (const row of rows) {
    for (const col of cols) {
      const count = matrix.get(`${row}\0${col}`) || 0;
      if (count > max) max = count;
      cells.push({ row, col, count, pct: (count / n) * 100 });
    }
  }
  return { rows, cols, cells, max };
}

export function holoLift(tokens: EnrichedToken[]): {
  overallHoloPct: number;
  byBase: Array<{ base: string; total: number; holo: number; lift: number }>;
  byBackground: Array<{ bg: string; total: number; holo: number; lift: number }>;
} {
  const holoN = tokens.filter((t) => /yes/i.test(t.traits.Holographic)).length;
  const overall = tokens.length ? holoN / tokens.length : 0;

  function group(keyFn: (t: EnrichedToken) => string) {
    const map = new Map<string, { total: number; holo: number }>();
    for (const t of tokens) {
      const k = keyFn(t) || "—";
      const cur = map.get(k) || { total: 0, holo: 0 };
      cur.total += 1;
      if (/yes/i.test(t.traits.Holographic)) cur.holo += 1;
      map.set(k, cur);
    }
    return Array.from(map.entries())
      .map(([key, v]) => ({
        key,
        total: v.total,
        holo: v.holo,
        rate: v.total ? v.holo / v.total : 0,
        lift: overall > 0 ? v.holo / v.total / overall : 0,
      }))
      .filter((r) => r.total >= 2)
      .sort((a, b) => b.lift - a.lift || b.total - a.total);
  }

  const bases = group((t) => t.traits.Base);
  const bgs = group((t) => t.traits.Background);

  return {
    overallHoloPct: overall * 100,
    byBase: bases.slice(0, 15).map((r) => ({
      base: r.key,
      total: r.total,
      holo: r.holo,
      lift: r.lift,
    })),
    byBackground: bgs.slice(0, 12).map((r) => ({
      bg: r.key,
      total: r.total,
      holo: r.holo,
      lift: r.lift,
    })),
  };
}

export function gradedSplit(tokens: EnrichedToken[]): {
  graded: number;
  plain: number;
  gradedPct: number;
  byBgTier: Slice[];
} {
  let graded = 0;
  let plain = 0;
  const byTier = new Map<string, number>();
  for (const t of tokens) {
    if (t.graded) graded += 1;
    else plain += 1;
    const label = t.graded ? `${t.bgTier} Graded` : t.bgTier || t.traits.Background;
    byTier.set(label, (byTier.get(label) || 0) + 1);
  }
  const total = tokens.length;
  return {
    graded,
    plain,
    gradedPct: total ? (graded / total) * 100 : 0,
    byBgTier: toSlices(byTier, total),
  };
}

export function scoreByDimension(
  tokens: EnrichedToken[],
  keyFn: (t: EnrichedToken) => string,
): Array<{ key: string; n: number; avg: number; median: number; max: number }> {
  const buckets = new Map<string, number[]>();
  for (const t of tokens) {
    if (!t.rarity) continue;
    const k = keyFn(t) || "—";
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k)!.push(t.rarity.normalizedScore);
  }
  return Array.from(buckets.entries())
    .map(([key, scores]) => {
      const sorted = [...scores].sort((a, b) => a - b);
      const n = sorted.length;
      const avg = scores.reduce((s, x) => s + x, 0) / n;
      const median =
        n % 2 ? sorted[Math.floor(n / 2)] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
      return { key, n, avg, median, max: sorted[n - 1] };
    })
    .filter((r) => r.n >= 1)
    .sort((a, b) => b.avg - a.avg);
}

export function mintWaveBuckets(
  tokens: EnrichedToken[],
  bucketSize = 100,
): Array<{ label: string; from: number; to: number; count: number; avgScore: number; holoPct: number }> {
  if (!tokens.length) return [];
  const maxId = Math.max(...tokens.map((t) => t.tokenId));
  const out = [];
  for (let from = 1; from <= maxId; from += bucketSize) {
    const to = Math.min(maxId, from + bucketSize - 1);
    const slice = tokens.filter((t) => t.tokenId >= from && t.tokenId <= to);
    if (!slice.length) continue;
    const scores = slice.map((t) => t.rarity?.normalizedScore).filter((x): x is number => x != null);
    const holo = slice.filter((t) => /yes/i.test(t.traits.Holographic)).length;
    out.push({
      label: `#${from}–${to}`,
      from,
      to,
      count: slice.length,
      avgScore: scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : 0,
      holoPct: (holo / slice.length) * 100,
    });
  }
  return out;
}

export function diversityStats(tokens: EnrichedToken[]): {
  uniqueBases: number;
  uniqueBackgrounds: number;
  uniqueCombos: number;
  simpsonBase: number;
  topBaseShare: number;
  entropyBase: number;
} {
  const bases = new Map<string, number>();
  const bgs = new Map<string, number>();
  const combos = new Set<string>();
  for (const t of tokens) {
    bases.set(t.traits.Base, (bases.get(t.traits.Base) || 0) + 1);
    bgs.set(t.traits.Background, (bgs.get(t.traits.Background) || 0) + 1);
    combos.add(`${t.traits.Base}|${t.traits.Background}|${t.traits.Holographic}`);
  }
  const n = tokens.length || 1;
  let simpson = 0;
  let entropy = 0;
  let top = 0;
  for (const c of bases.values()) {
    const p = c / n;
    simpson += p * p;
    if (p > 0) entropy -= p * Math.log2(p);
    if (c > top) top = c;
  }
  return {
    uniqueBases: bases.size,
    uniqueBackgrounds: bgs.size,
    uniqueCombos: combos.size,
    simpsonBase: 1 - simpson,
    topBaseShare: (top / n) * 100,
    entropyBase: entropy,
  };
}

/** SVG donut path helpers */
export function donutSegments(
  slices: Slice[],
  cx: number,
  cy: number,
  rOuter: number,
  rInner: number,
): Array<Slice & { d: string; midAngle: number }> {
  const total = slices.reduce((s, x) => s + x.count, 0) || 1;
  let angle = -Math.PI / 2;
  return slices.map((slice) => {
    const sweep = (slice.count / total) * Math.PI * 2;
    const a0 = angle;
    const a1 = angle + sweep;
    angle = a1;
    const large = sweep > Math.PI ? 1 : 0;
    const x0o = cx + rOuter * Math.cos(a0);
    const y0o = cy + rOuter * Math.sin(a0);
    const x1o = cx + rOuter * Math.cos(a1);
    const y1o = cy + rOuter * Math.sin(a1);
    const x0i = cx + rInner * Math.cos(a1);
    const y0i = cy + rInner * Math.sin(a1);
    const x1i = cx + rInner * Math.cos(a0);
    const y1i = cy + rInner * Math.sin(a0);
    const d =
      sweep <= 0.0001
        ? ""
        : [
            `M ${x0o} ${y0o}`,
            `A ${rOuter} ${rOuter} 0 ${large} 1 ${x1o} ${y1o}`,
            `L ${x0i} ${y0i}`,
            `A ${rInner} ${rInner} 0 ${large} 0 ${x1i} ${y1i}`,
            "Z",
          ].join(" ");
    return { ...slice, d, midAngle: a0 + sweep / 2 };
  });
}

export function topNWithOther(slices: Slice[], n: number): Slice[] {
  if (slices.length <= n) return slices;
  const head = slices.slice(0, n - 1);
  const rest = slices.slice(n - 1);
  const count = rest.reduce((s, x) => s + x.count, 0);
  const pct = rest.reduce((s, x) => s + x.pct, 0);
  return [
    ...head,
    {
      key: "__other__",
      label: `Other (${rest.length})`,
      count,
      pct,
      color: "#78716c",
    },
  ];
}
