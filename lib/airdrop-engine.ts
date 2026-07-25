/**
 * Airdrop allocation engine.
 * Builds expected shares for every approved wallet from:
 *  - Wood List (public/proofs.json keys)
 *  - Extra airdrop.json addresses / optional weights
 *
 * Equal weight by default; optional per-wallet weights in airdrop.json.
 * All numbers are deterministic from the on-disk snapshot (live when files update).
 */

import { promises as fs } from "node:fs";
import path from "node:path";

export type AirdropSource = "wood_list" | "airdrop" | "both";

export type AirdropConfigFile = {
  description?: string;
  /** Human token units of total $PLANK supply (e.g. "1000000000") */
  totalSupply?: string | number;
  /** % of total supply reserved for this airdrop pool (e.g. 10 = 10%) */
  airdropPercentOfSupply?: number;
  /** Token decimals for display (default 18) */
  decimals?: number;
  /** Include Wood List (proofs.json) wallets — default true */
  includeWoodList?: boolean;
  /** Extra approved addresses (lowercase preferred) */
  addresses?: string[];
  /** Optional weight multipliers (default 1). Higher weight → larger share. */
  weights?: Record<string, number>;
  /** Addresses to exclude even if on Wood List */
  exclude?: string[];
};

export type AllocationRow = {
  address: string;
  source: AirdropSource;
  weight: number;
  /** Share of airdrop pool 0–1 */
  shareOfAirdrop: number;
  /** % of airdrop pool */
  pctOfAirdrop: number;
  /** % of total token supply */
  pctOfSupply: number;
  /** Expected tokens in human units (string, up to 6 frac digits trimmed) */
  expectedTokens: string;
  /** Expected tokens raw integer string (base units) */
  expectedTokensRaw: string;
};

export type AirdropSnapshot = {
  updatedAt: string;
  config: {
    totalSupply: string;
    airdropPercentOfSupply: number;
    airdropPoolTokens: string;
    decimals: number;
    includeWoodList: boolean;
  };
  counts: {
    approved: number;
    woodList: number;
    airdropOnly: number;
    both: number;
    totalWeight: number;
  };
  /** Equal-weight shortcut for UI when all weights are 1 */
  equalWeight: boolean;
  /** Per-wallet equal % when equalWeight (else null) */
  equalPctOfAirdrop: number | null;
  equalPctOfSupply: number | null;
  allocations: AllocationRow[];
  /** Merkle root from proofs if present (transparency) */
  woodListRoot: string | null;
  woodListCount: number;
};

const DEFAULT_TOTAL_SUPPLY = "1000000000"; // 1B PLANK human units
const DEFAULT_AIRDROP_PCT = 10;
const DEFAULT_DECIMALS = 18;

const ZERO = "0x0000000000000000000000000000000000000000";
const DEAD = "0x000000000000000000000000000000000000dead";

function normalizeAddress(addr: string): string {
  return addr.trim().toLowerCase();
}

function isAddressLike(addr: string): boolean {
  return /^0x[a-f0-9]{40}$/.test(normalizeAddress(addr));
}

function parsePositiveNumber(v: unknown, fallback: number): number {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  if (!Number.isFinite(n) || n < 0) return fallback;
  return n;
}

function parseSupply(v: unknown): string {
  if (typeof v === "number" && Number.isFinite(v) && v > 0) {
    return Math.floor(v).toString();
  }
  if (typeof v === "string" && /^\d+(\.\d+)?$/.test(v.trim())) {
    const [w] = v.trim().split(".");
    return w || DEFAULT_TOTAL_SUPPLY;
  }
  return DEFAULT_TOTAL_SUPPLY;
}

/** Format integer base units → human with up to `maxFrac` digits. */
export function formatTokenUnits(
  raw: bigint,
  decimals: number,
  maxFrac = 6
): string {
  if (raw === BigInt(0)) return "0";
  const base = BigInt(10) ** BigInt(decimals);
  const whole = raw / base;
  const frac = raw % base;
  if (frac === BigInt(0)) return whole.toString();
  let fracStr = frac.toString().padStart(decimals, "0").slice(0, maxFrac);
  fracStr = fracStr.replace(/0+$/, "");
  return fracStr ? `${whole.toString()}.${fracStr}` : whole.toString();
}

function pctLabel(n: number, digits = 6): number {
  if (!Number.isFinite(n)) return 0;
  // Avoid scientific noise for tiny shares
  const f = Number(n.toFixed(digits));
  return f;
}

type GlobalAirdrop = {
  __plankAirdropSnap?: { at: number; data: AirdropSnapshot };
};

function g(): GlobalAirdrop {
  return globalThis as GlobalAirdrop;
}

async function readJsonFile<T>(rel: string): Promise<T | null> {
  try {
    const full = path.join(process.cwd(), rel);
    const raw = await fs.readFile(full, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/**
 * Build full allocation snapshot from disk.
 * Cached briefly so live poll/SSE stay cheap.
 */
export async function buildAirdropSnapshot(opts?: {
  force?: boolean;
  cacheMs?: number;
}): Promise<AirdropSnapshot> {
  const cacheMs = opts?.cacheMs ?? 8_000;
  const now = Date.now();
  const hit = g().__plankAirdropSnap;
  if (!opts?.force && hit && now - hit.at < cacheMs) {
    return hit.data;
  }

  const configFile =
    (await readJsonFile<AirdropConfigFile>("public/airdrop.json")) || {};
  const proofs = await readJsonFile<{
    root?: string;
    count?: number;
    proofs?: Record<string, unknown>;
  }>("public/proofs.json");

  const totalSupplyHuman = parseSupply(
    process.env.AIRDROP_TOTAL_SUPPLY ?? configFile.totalSupply
  );
  const airdropPct = parsePositiveNumber(
    process.env.AIRDROP_PERCENT_OF_SUPPLY ?? configFile.airdropPercentOfSupply,
    DEFAULT_AIRDROP_PCT
  );
  const decimals = Math.min(
    18,
    Math.max(
      0,
      Math.floor(
        parsePositiveNumber(configFile.decimals, DEFAULT_DECIMALS)
      )
    )
  );
  const includeWoodList = configFile.includeWoodList !== false;

  const exclude = new Set<string>([ZERO, DEAD]);
  for (const e of configFile.exclude || []) {
    if (isAddressLike(e)) exclude.add(normalizeAddress(e));
  }

  // address → { wood, air, weight }
  const map = new Map<
    string,
    { wood: boolean; air: boolean; weight: number }
  >();

  if (includeWoodList && proofs?.proofs) {
    for (const addr of Object.keys(proofs.proofs)) {
      if (!isAddressLike(addr)) continue;
      const a = normalizeAddress(addr);
      if (exclude.has(a)) continue;
      map.set(a, { wood: true, air: false, weight: 1 });
    }
  }

  for (const addr of configFile.addresses || []) {
    if (!isAddressLike(addr)) continue;
    const a = normalizeAddress(addr);
    if (exclude.has(a)) continue;
    const prev = map.get(a);
    if (prev) {
      prev.air = true;
    } else {
      map.set(a, { wood: false, air: true, weight: 1 });
    }
  }

  // Apply weights (multiply base weight)
  if (configFile.weights && typeof configFile.weights === "object") {
    for (const [addr, w] of Object.entries(configFile.weights)) {
      if (!isAddressLike(addr)) continue;
      const a = normalizeAddress(addr);
      if (exclude.has(a)) continue;
      const weight = parsePositiveNumber(w, 1);
      if (weight <= 0) continue;
      const prev = map.get(a);
      if (prev) {
        prev.weight = weight;
      } else {
        // Weight-only entry counts as airdrop-only approved
        map.set(a, { wood: false, air: true, weight });
      }
    }
  }

  // Env extras: AIRDROP_EXTRA=0x...,0x...
  const extraEnv = process.env.AIRDROP_EXTRA?.split(",") || [];
  for (const addr of extraEnv) {
    if (!isAddressLike(addr)) continue;
    const a = normalizeAddress(addr);
    if (exclude.has(a)) continue;
    const prev = map.get(a);
    if (prev) prev.air = true;
    else map.set(a, { wood: false, air: true, weight: 1 });
  }

  let totalWeight = 0;
  let woodList = 0;
  let airdropOnly = 0;
  let both = 0;
  for (const row of map.values()) {
    totalWeight += row.weight;
    if (row.wood && row.air) both += 1;
    else if (row.wood) woodList += 1;
    else airdropOnly += 1;
  }

  // Pool in human units, then scale to raw with decimals via rational math
  const supplyHuman = BigInt(totalSupplyHuman);
  // airdrop pool human = supply * pct / 100 (integer math on milli-percent)
  // use basis points of percent * 1e6 for precision: pool = supply * pct / 100
  const pctScaled = BigInt(Math.round(airdropPct * 1_000_000)); // pct * 1e6
  const poolHuman =
    (supplyHuman * pctScaled) / (BigInt(100) * BigInt(1_000_000));

  const scale = BigInt(10) ** BigInt(decimals);
  const poolRaw = poolHuman * scale;

  const equalWeight =
    map.size > 0 && [...map.values()].every((r) => r.weight === 1);

  const allocations: AllocationRow[] = [];
  const sorted = [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));

  for (const [address, meta] of sorted) {
    const source: AirdropSource =
      meta.wood && meta.air ? "both" : meta.wood ? "wood_list" : "airdrop";
    const share =
      totalWeight > 0 ? meta.weight / totalWeight : 0;
    // expected raw = poolRaw * weight / totalWeight
    const expectedRaw =
      totalWeight > 0
        ? (poolRaw * BigInt(meta.weight)) / BigInt(totalWeight)
        : BigInt(0);
    // % of airdrop = share; % of supply = airdropPct * share (avoid float on huge wei)
    const pctOfAirdrop = share * 100;
    const pctOfSupply = airdropPct * share;

    allocations.push({
      address,
      source,
      weight: meta.weight,
      shareOfAirdrop: share,
      pctOfAirdrop: pctLabel(pctOfAirdrop, 8),
      pctOfSupply: pctLabel(pctOfSupply, 10),
      expectedTokens: formatTokenUnits(expectedRaw, decimals, 6),
      expectedTokensRaw: expectedRaw.toString(),
    });
  }

  // Sort display: highest weight first, then address
  allocations.sort((a, b) => {
    if (b.weight !== a.weight) return b.weight - a.weight;
    return a.address.localeCompare(b.address);
  });

  const n = allocations.length;
  const snapshot: AirdropSnapshot = {
    updatedAt: new Date().toISOString(),
    config: {
      totalSupply: totalSupplyHuman,
      airdropPercentOfSupply: airdropPct,
      airdropPoolTokens: poolHuman.toString(),
      decimals,
      includeWoodList,
    },
    counts: {
      approved: n,
      woodList,
      airdropOnly,
      both,
      totalWeight,
    },
    equalWeight,
    equalPctOfAirdrop: equalWeight && n > 0 ? pctLabel(100 / n, 8) : null,
    equalPctOfSupply:
      equalWeight && n > 0 ? pctLabel(airdropPct / n, 10) : null,
    allocations,
    woodListRoot: proofs?.root ?? null,
    woodListCount: proofs?.count ?? Object.keys(proofs?.proofs || {}).length,
  };

  g().__plankAirdropSnap = { at: now, data: snapshot };
  return snapshot;
}

export function lookupAllocation(
  snap: AirdropSnapshot,
  address: string
): AllocationRow | null {
  if (!isAddressLike(address)) return null;
  const a = normalizeAddress(address);
  return snap.allocations.find((r) => r.address === a) || null;
}

/** Compact public rows for list UI (smaller payload). */
export function compactRows(rows: AllocationRow[]): Array<{
  a: string;
  s: AirdropSource;
  w: number;
  pa: number;
  ps: number;
  t: string;
}> {
  return rows.map((r) => ({
    a: r.address,
    s: r.source,
    w: r.weight,
    pa: r.pctOfAirdrop,
    ps: r.pctOfSupply,
    t: r.expectedTokens,
  }));
}
