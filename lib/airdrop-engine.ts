/**
 * Airdrop allocation engine.
 *
 * Source of truth:
 *  - Total supply: on-chain $PLANK totalSupply (fallback: airdrop.json / env)
 *  - Pool: official holder share 4.2069% of supply (or explicit airdropPoolTokens)
 *  - Wallets: Wood List (proofs.json) + airdrop.json extras / weights
 *
 * Official: NFT holders get 4.2069% of token supply (@RobinWoodPlank).
 */

import { CONTRACT_ADDRESS, CHAIN } from "@/lib/constants";
import { ROBINHOOD_RPC_URLS } from "@/lib/mint-contract";
import { readPublicJson } from "@/lib/public-json";

export type AirdropSource = "wood_list" | "airdrop" | "both";

export type AirdropConfigFile = {
  description?: string;
  notes?: string[];
  /** Human token units of total $PLANK supply (fallback if RPC fails) */
  totalSupply?: string | number;
  /**
   * % of total supply in the airdrop pool.
   * Official holder allocation: 4.2069
   */
  airdropPercentOfSupply?: number;
  /**
   * Absolute pool size in human PLANK (overrides percent when set & > 0).
   */
  airdropPoolTokens?: string | number | null;
  decimals?: number;
  includeWoodList?: boolean;
  addresses?: string[];
  weights?: Record<string, number>;
  exclude?: string[];
};

export type AllocationRow = {
  address: string;
  source: AirdropSource;
  weight: number;
  shareOfAirdrop: number;
  pctOfAirdrop: number;
  pctOfSupply: number;
  expectedTokens: string;
  expectedTokensRaw: string;
  /** Current NFT balance */
  nfts?: number;
  /** Free mints claimed (max 2) */
  freeMinted?: number;
  /** Wood List / allowlist mints claimed (max 2) */
  woodMinted?: number;
  /** Paid / public mints claimed (max 33) */
  paidMinted?: number;
};

export type AirdropSnapshot = {
  updatedAt: string;
  config: {
    totalSupply: string;
    airdropPercentOfSupply: number;
    airdropPoolTokens: string;
    decimals: number;
    includeWoodList: boolean;
    supplySource: "chain" | "config" | "env";
    poolSource: "percent" | "absolute";
  };
  counts: {
    approved: number;
    woodList: number;
    airdropOnly: number;
    both: number;
    totalWeight: number;
  };
  equalWeight: boolean;
  equalPctOfAirdrop: number | null;
  equalPctOfSupply: number | null;
  equalExpectedTokens: string | null;
  allocations: AllocationRow[];
  woodListRoot: string | null;
  woodListCount: number;
};

/** On-chain totalSupply human units (888420069420888) — last known good fallback */
export const PLANK_TOTAL_SUPPLY_FALLBACK = "888420069420888";

/** Official holder airdrop: 4.2069% of total supply */
export const OFFICIAL_AIRDROP_PERCENT = 4.2069;

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

function parseSupplyString(v: unknown): string | null {
  if (typeof v === "number" && Number.isFinite(v) && v > 0) {
    return Math.floor(v).toString();
  }
  if (typeof v === "string" && /^\d+(\.\d+)?$/.test(v.trim())) {
    const [w] = v.trim().split(".");
    if (w && w !== "0") return w;
  }
  return null;
}

/** Format integer human units with full separators (no scientific). */
export function formatTokenUnits(
  raw: bigint,
  decimals: number,
  maxFrac = 4
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

/** Human-readable compact amount for UI (e.g. 16.55B, 37.36T). */
export function formatCompactTokens(human: string | bigint): string {
  try {
    const n = typeof human === "bigint" ? human : BigInt(String(human).split(".")[0] || "0");
    if (n < BigInt(0)) return "0";
    const abs = n;
    const units: Array<{ div: bigint; suf: string }> = [
      { div: BigInt("1000000000000000"), suf: "Q" }, // 1e15
      { div: BigInt("1000000000000"), suf: "T" }, // 1e12
      { div: BigInt("1000000000"), suf: "B" },
      { div: BigInt("1000000"), suf: "M" },
      { div: BigInt("1000"), suf: "K" },
    ];
    for (const u of units) {
      if (abs >= u.div) {
        const whole = abs / u.div;
        const rem = abs % u.div;
        // one decimal when useful
        const tenth = Number((rem * BigInt(10)) / u.div);
        if (whole >= BigInt(100) || tenth === 0) {
          return `${whole.toLocaleString("en-US")}${u.suf}`;
        }
        return `${whole.toLocaleString("en-US")}.${tenth}${u.suf}`;
      }
    }
    return abs.toLocaleString("en-US");
  } catch {
    return String(human);
  }
}

function pctLabel(n: number, digits = 6): number {
  if (!Number.isFinite(n)) return 0;
  return Number(n.toFixed(digits));
}

type GlobalAirdrop = {
  __plankAirdropSnap?: { at: number; data: AirdropSnapshot };
  __plankChainSupply?: { at: number; human: string };
};

function g(): GlobalAirdrop {
  return globalThis as GlobalAirdrop;
}

async function readJsonFile<T>(rel: string): Promise<T | null> {
  return readPublicJson<T>(rel);
}

async function rpcCall(method: string, params: unknown[]): Promise<unknown> {
  let last: unknown;
  for (const url of ROBINHOOD_RPC_URLS) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        cache: "no-store",
      });
      const data = (await res.json()) as { result?: unknown; error?: { message?: string } };
      if (data.error) throw new Error(data.error.message || "RPC error");
      return data.result;
    } catch (e) {
      last = e;
    }
  }
  throw last instanceof Error ? last : new Error("RPC failed");
}

/** Live totalSupply from $PLANK contract (human units). Cached ~60s. */
export async function fetchOnChainTotalSupply(): Promise<string | null> {
  const cache = g().__plankChainSupply;
  if (cache && Date.now() - cache.at < 60_000) return cache.human;
  try {
    // totalSupply() selector 0x18160ddd
    const hex = (await rpcCall("eth_call", [
      { to: CONTRACT_ADDRESS, data: "0x18160ddd" },
      "latest",
    ])) as string;
    if (!hex || hex === "0x") return null;
    const wei = BigInt(hex);
    const human = (wei / BigInt(10) ** BigInt(18)).toString();
    if (human === "0") return null;
    g().__plankChainSupply = { at: Date.now(), human };
    return human;
  } catch {
    return null;
  }
}

/**
 * Build full allocation snapshot.
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

  // ── Total supply: chain → env → config → known fallback
  let supplySource: AirdropSnapshot["config"]["supplySource"] = "config";
  let totalSupplyHuman =
    parseSupplyString(process.env.AIRDROP_TOTAL_SUPPLY) ||
    parseSupplyString(configFile.totalSupply) ||
    PLANK_TOTAL_SUPPLY_FALLBACK;

  if (process.env.AIRDROP_TOTAL_SUPPLY?.trim()) {
    supplySource = "env";
  }

  const chainSupply = await fetchOnChainTotalSupply();
  if (chainSupply) {
    totalSupplyHuman = chainSupply;
    supplySource = "chain";
  } else if (!process.env.AIRDROP_TOTAL_SUPPLY?.trim() && !configFile.totalSupply) {
    supplySource = "config";
    totalSupplyHuman = PLANK_TOTAL_SUPPLY_FALLBACK;
  }

  // ── Pool: absolute tokens override percent; default official 4.2069%
  const absolutePool = parseSupplyString(
    process.env.AIRDROP_POOL_TOKENS ?? configFile.airdropPoolTokens ?? null
  );
  let airdropPct = parsePositiveNumber(
    process.env.AIRDROP_PERCENT_OF_SUPPLY ?? configFile.airdropPercentOfSupply,
    OFFICIAL_AIRDROP_PERCENT
  );
  // Cap nonsense
  if (airdropPct > 100) airdropPct = 100;

  const decimals = Math.min(
    18,
    Math.max(0, Math.floor(parsePositiveNumber(configFile.decimals, DEFAULT_DECIMALS)))
  );
  const includeWoodList = configFile.includeWoodList !== false;

  const exclude = new Set<string>([ZERO, DEAD]);
  for (const e of configFile.exclude || []) {
    if (isAddressLike(e)) exclude.add(normalizeAddress(e));
  }

  const map = new Map<string, { wood: boolean; air: boolean; weight: number }>();

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
    if (prev) prev.air = true;
    else map.set(a, { wood: false, air: true, weight: 1 });
  }

  if (configFile.weights && typeof configFile.weights === "object") {
    for (const [addr, w] of Object.entries(configFile.weights)) {
      if (!isAddressLike(addr)) continue;
      const a = normalizeAddress(addr);
      if (exclude.has(a)) continue;
      const weight = parsePositiveNumber(w, 1);
      if (weight <= 0) continue;
      const prev = map.get(a);
      if (prev) prev.weight = weight;
      else map.set(a, { wood: false, air: true, weight });
    }
  }

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

  const supplyHuman = BigInt(totalSupplyHuman);
  let poolHuman: bigint;
  let poolSource: "percent" | "absolute" = "percent";

  if (absolutePool) {
    poolHuman = BigInt(absolutePool);
    poolSource = "absolute";
    // Derive effective % for display
    if (supplyHuman > BigInt(0)) {
      // percent * 1e6 = pool * 100 * 1e6 / supply
      const scaled =
        (poolHuman * BigInt(100) * BigInt(1_000_000)) / supplyHuman;
      airdropPct = Number(scaled) / 1_000_000;
    }
  } else {
    // pool = supply * pct / 100 with high precision (pct * 1e6)
    const pctScaled = BigInt(Math.round(airdropPct * 1_000_000));
    poolHuman =
      (supplyHuman * pctScaled) / (BigInt(100) * BigInt(1_000_000));
    poolSource = "percent";
  }

  const scale = BigInt(10) ** BigInt(decimals);
  const poolRaw = poolHuman * scale;

  const equalWeight =
    map.size > 0 && [...map.values()].every((r) => r.weight === 1);

  const allocations: AllocationRow[] = [];
  const sorted = [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));

  for (const [address, meta] of sorted) {
    const source: AirdropSource =
      meta.wood && meta.air ? "both" : meta.wood ? "wood_list" : "airdrop";
    const share = totalWeight > 0 ? meta.weight / totalWeight : 0;
    const expectedRaw =
      totalWeight > 0
        ? (poolRaw * BigInt(meta.weight)) / BigInt(totalWeight)
        : BigInt(0);
    const expectedHuman =
      totalWeight > 0
        ? (poolHuman * BigInt(meta.weight)) / BigInt(totalWeight)
        : BigInt(0);

    allocations.push({
      address,
      source,
      weight: meta.weight,
      shareOfAirdrop: share,
      pctOfAirdrop: pctLabel(share * 100, 8),
      pctOfSupply: pctLabel(airdropPct * share, 10),
      expectedTokens: expectedHuman.toString(),
      expectedTokensRaw: expectedRaw.toString(),
    });
  }

  allocations.sort((a, b) => {
    if (b.weight !== a.weight) return b.weight - a.weight;
    return a.address.localeCompare(b.address);
  });

  const n = allocations.length;
  const equalExpected =
    equalWeight && n > 0
      ? (poolHuman / BigInt(n)).toString()
      : null;

  const snapshot: AirdropSnapshot = {
    updatedAt: new Date().toISOString(),
    config: {
      totalSupply: totalSupplyHuman,
      airdropPercentOfSupply: airdropPct,
      airdropPoolTokens: poolHuman.toString(),
      decimals,
      includeWoodList,
      supplySource,
      poolSource,
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
    equalExpectedTokens: equalExpected,
    allocations,
    woodListRoot: proofs?.root ?? null,
    woodListCount: proofs?.count ?? Object.keys(proofs?.proofs || {}).length,
  };

  // Silence unused CHAIN import warning if any - keep for docs
  void CHAIN;

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

export function compactRows(rows: AllocationRow[]): Array<{
  a: string;
  s: AirdropSource;
  w: number;
  pa: number;
  ps: number;
  t: string;
  n: number;
  f: number;
  wl: number;
  p: number;
}> {
  return rows.map((r) => ({
    a: r.address,
    s: r.source,
    w: r.weight,
    pa: r.pctOfAirdrop,
    ps: r.pctOfSupply,
    t: r.expectedTokens,
    n: r.nfts ?? 0,
    f: r.freeMinted ?? 0,
    wl: r.woodMinted ?? 0,
    p: r.paidMinted ?? 0,
  }));
}

/** Attach NFT mint stats onto allocation rows. */
export function attachNftStats(
  rows: AllocationRow[],
  byAddress: Record<
    string,
    { nfts: number; free: number; wood: number; paid: number }
  >
): AllocationRow[] {
  return rows.map((r) => {
    const st = byAddress[r.address] || {
      nfts: 0,
      free: 0,
      wood: 0,
      paid: 0,
    };
    return {
      ...r,
      nfts: st.nfts,
      freeMinted: st.free,
      woodMinted: st.wood,
      paidMinted: st.paid,
    };
  });
}

/**
 * Recompute PLANK shares by NFT holdings (official holder airdrop).
 * weight = nfts held; 0 NFTs → 0 PLANK from the holder pool.
 * Merges any holders present in byAddress that are missing from rows.
 */
export function recomputeByNftHoldings(opts: {
  rows: AllocationRow[];
  byAddress: Record<
    string,
    { nfts: number; free: number; wood: number; paid: number }
  >;
  poolHuman: string;
  airdropPercentOfSupply: number;
  /** When true, also add pure secondary holders not on wood list */
  includeAllHolders?: boolean;
}): {
  rows: AllocationRow[];
  totalNftsWeighted: number;
  holdersWithNfts: number;
} {
  const poolHuman = BigInt(opts.poolHuman || "0");
  const pct = opts.airdropPercentOfSupply;

  const map = new Map<string, AllocationRow>();
  for (const r of opts.rows) {
    const st = opts.byAddress[r.address];
    map.set(r.address, {
      ...r,
      nfts: st?.nfts ?? r.nfts ?? 0,
      freeMinted: st?.free ?? r.freeMinted ?? 0,
      woodMinted: st?.wood ?? r.woodMinted ?? 0,
      paidMinted: st?.paid ?? r.paidMinted ?? 0,
    });
  }

  if (opts.includeAllHolders !== false) {
    for (const [addr, st] of Object.entries(opts.byAddress)) {
      if (st.nfts <= 0) continue;
      if (map.has(addr)) continue;
      map.set(addr, {
        address: addr,
        source: "airdrop",
        weight: st.nfts,
        shareOfAirdrop: 0,
        pctOfAirdrop: 0,
        pctOfSupply: 0,
        expectedTokens: "0",
        expectedTokensRaw: "0",
        nfts: st.nfts,
        freeMinted: st.free,
        woodMinted: st.wood,
        paidMinted: st.paid,
      });
    }
  }

  let totalNfts = 0;
  for (const r of map.values()) totalNfts += r.nfts ?? 0;

  const out: AllocationRow[] = [];
  for (const r of map.values()) {
    const n = r.nfts ?? 0;
    const share = totalNfts > 0 ? n / totalNfts : 0;
    const expectedHuman =
      totalNfts > 0 ? (poolHuman * BigInt(n)) / BigInt(totalNfts) : BigInt(0);
    out.push({
      ...r,
      weight: n > 0 ? n : r.weight,
      shareOfAirdrop: share,
      pctOfAirdrop: Number((share * 100).toFixed(8)),
      pctOfSupply: Number((pct * share).toFixed(10)),
      expectedTokens: expectedHuman.toString(),
      expectedTokensRaw: (expectedHuman * BigInt(10) ** BigInt(18)).toString(),
    });
  }

  out.sort((a, b) => {
    const an = a.nfts ?? 0;
    const bn = b.nfts ?? 0;
    if (bn !== an) return bn - an;
    return a.address.localeCompare(b.address);
  });

  return {
    rows: out,
    totalNftsWeighted: totalNfts,
    holdersWithNfts: out.filter((r) => (r.nfts ?? 0) > 0).length,
  };
}
