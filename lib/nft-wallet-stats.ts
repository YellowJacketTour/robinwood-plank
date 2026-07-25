/**
 * Per-wallet NFT holdings + free / wood-list / paid mint counts.
 *
 * free  claimed = 2 − remainingFreeMintsForWallet
 * wood  claimed = 2 − remainingAllowlistMintsForWallet
 * paid  claimed = 33 − remainingPaidMintsForWallet
 * nfts          = balanceOf
 */

import { id } from "ethers";
import { NFT_CONTRACT_ADDRESS, ROBINHOOD_RPC_URLS } from "@/lib/mint-contract";

export type WalletNftStats = {
  nfts: number;
  free: number;
  wood: number;
  paid: number;
};

export const NFT_MINT_CAPS = {
  free: 2,
  wood: 2,
  paid: 33,
} as const;

const ZERO = "0x0000000000000000000000000000000000000000";

const SEL = {
  balanceOf: id("balanceOf(address)").slice(0, 10),
  remainingFree: id("remainingFreeMintsForWallet(address)").slice(0, 10),
  remainingAllowlist: id("remainingAllowlistMintsForWallet(address)").slice(
    0,
    10
  ),
  remainingPaid: id("remainingPaidMintsForWallet(address)").slice(0, 10),
};

type CacheBag = {
  at: number;
  byAddress: Record<string, WalletNftStats>;
  addresses: number;
  ready: boolean;
};

type GlobalNft = {
  __plankNftWalletStats?: CacheBag;
  __plankNftWalletStatsBuilding?: Promise<CacheBag>;
};

function g(): GlobalNft {
  return globalThis as GlobalNft;
}

function normalize(addr: string): string {
  return addr.trim().toLowerCase();
}

function padAddress(addr: string): string {
  return addr.toLowerCase().replace(/^0x/, "").padStart(64, "0");
}

function encodeAddrCall(selector: string, address: string): string {
  return selector + padAddress(address);
}

function decodeUint(hex: string | null | undefined): number {
  if (!hex || hex === "0x") return 0;
  try {
    const n = BigInt(hex);
    if (n > BigInt(Number.MAX_SAFE_INTEGER)) return Number.MAX_SAFE_INTEGER;
    return Number(n);
  } catch {
    return 0;
  }
}

function claimed(cap: number, remaining: number): number {
  const r = Math.max(0, Math.min(cap, remaining));
  return Math.max(0, cap - r);
}

function emptyStats(): WalletNftStats {
  return { nfts: 0, free: 0, wood: 0, paid: 0 };
}

/** Parallel single-call batch (JSON-RPC array). Falls back per-URL. */
async function rpcBatch(
  calls: Array<{ method: string; params: unknown[] }>
): Promise<(string | null)[]> {
  let lastErr: unknown;
  const body = calls.map((c, i) => ({
    jsonrpc: "2.0",
    id: i + 1,
    method: c.method,
    params: c.params,
  }));

  for (const url of ROBINHOOD_RPC_URLS) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        cache: "no-store",
      });
      if (!res.ok) throw new Error(`RPC ${res.status}`);
      const data = (await res.json()) as
        | Array<{ id: number; result?: string; error?: unknown }>
        | { error?: unknown };
      if (!Array.isArray(data)) throw new Error("RPC batch not array");
      const byId = new Map(data.map((r) => [r.id, r]));
      return calls.map((_, i) => {
        const row = byId.get(i + 1);
        if (!row || row.error) return null;
        return (row.result as string) ?? null;
      });
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("RPC batch failed");
}

const ADDR_CHUNK = 8; // 8 wallets × 4 calls = 32 eth_calls per HTTP batch
const CACHE_MS = 120_000;

/**
 * Build stats for the given wallets. Cached ~2 min process-wide.
 */
export async function buildNftWalletStats(
  addresses: string[],
  opts?: { force?: boolean }
): Promise<CacheBag> {
  const glob = g();
  if (
    !opts?.force &&
    glob.__plankNftWalletStats &&
    Date.now() - glob.__plankNftWalletStats.at < CACHE_MS
  ) {
    return glob.__plankNftWalletStats;
  }
  if (!opts?.force && glob.__plankNftWalletStatsBuilding) {
    return glob.__plankNftWalletStatsBuilding;
  }

  const job = (async (): Promise<CacheBag> => {
    const uniq = [
      ...new Set(
        addresses
          .map(normalize)
          .filter((a) => /^0x[a-f0-9]{40}$/.test(a) && a !== ZERO)
      ),
    ];

    const byAddress: Record<string, WalletNftStats> = {};
    for (const a of uniq) byAddress[a] = emptyStats();

    for (let i = 0; i < uniq.length; i += ADDR_CHUNK) {
      const chunk = uniq.slice(i, i + ADDR_CHUNK);
      const calls: Array<{ method: string; params: unknown[] }> = [];
      for (const a of chunk) {
        for (const selector of [
          SEL.balanceOf,
          SEL.remainingFree,
          SEL.remainingAllowlist,
          SEL.remainingPaid,
        ]) {
          calls.push({
            method: "eth_call",
            params: [
              {
                to: NFT_CONTRACT_ADDRESS,
                data: encodeAddrCall(selector, a),
              },
              "latest",
            ],
          });
        }
      }
      try {
        const results = await rpcBatch(calls);
        chunk.forEach((a, idx) => {
          const base = idx * 4;
          const bal = decodeUint(results[base]);
          const freeRem = decodeUint(results[base + 1]);
          const woodRem = decodeUint(results[base + 2]);
          const paidRem = decodeUint(results[base + 3]);
          byAddress[a] = {
            nfts: bal,
            free: claimed(NFT_MINT_CAPS.free, freeRem),
            wood: claimed(NFT_MINT_CAPS.wood, woodRem),
            paid: claimed(NFT_MINT_CAPS.paid, paidRem),
          };
        });
      } catch {
        // leave zeros for this chunk
      }
    }

    const bag: CacheBag = {
      at: Date.now(),
      byAddress,
      addresses: uniq.length,
      ready: true,
    };
    g().__plankNftWalletStats = bag;
    return bag;
  })();

  glob.__plankNftWalletStatsBuilding = job;
  try {
    return await job;
  } finally {
    if (glob.__plankNftWalletStatsBuilding === job) {
      glob.__plankNftWalletStatsBuilding = undefined;
    }
  }
}

export function getCachedNftWalletStats(): CacheBag | null {
  const c = g().__plankNftWalletStats;
  if (!c) return null;
  return c;
}

/** Merge stats into a compact row shape. */
export function statsFor(
  bag: CacheBag | null | undefined,
  address: string
): WalletNftStats {
  if (!bag) return emptyStats();
  return bag.byAddress[normalize(address)] || emptyStats();
}
