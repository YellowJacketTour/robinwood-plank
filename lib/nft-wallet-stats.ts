/**
 * Per-wallet NFT holdings + free / wood-list / paid mint counts.
 *
 * Holdings: full collection ownerOf scan (authoritative).
 * Mint types: remaining* caps (free≤2, wood≤2, paid≤33).
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
  totalSupply: id("totalSupply()").slice(0, 10),
  ownerOf: id("ownerOf(uint256)").slice(0, 10),
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
  /** All current holders from ownerOf scan */
  holders: string[];
  totalNfts: number;
  uniqueHolders: number;
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

function encodeOwnerOf(tokenId: number): string {
  return SEL.ownerOf + tokenId.toString(16).padStart(64, "0");
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

function decodeAddress(hex: string | null | undefined): string | null {
  if (!hex || hex.length < 66) return null;
  const a = normalize(`0x${hex.slice(-40)}`);
  if (a === ZERO) return null;
  return a;
}

function claimed(cap: number, remaining: number): number {
  const r = Math.max(0, Math.min(cap, remaining));
  return Math.max(0, cap - r);
}

function emptyStats(): WalletNftStats {
  return { nfts: 0, free: 0, wood: 0, paid: 0 };
}

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

async function rpcCall(method: string, params: unknown[]): Promise<string | null> {
  const [r] = await rpcBatch([{ method, params }]);
  return r;
}

const OWNER_BATCH = 40;
const MINT_CHUNK = 10; // 10 wallets × 3 remaining calls
const CACHE_MS = 90_000;

/**
 * Build authoritative NFT holdings via ownerOf(1..totalSupply), then mint-type
 * remaining for every holder (+ any extra addresses requested).
 */
export async function buildNftWalletStats(
  extraAddresses: string[] = [],
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
    const byAddress: Record<string, WalletNftStats> = {};

    // ── 1) totalSupply
    let supply = 0;
    try {
      const hex = await rpcCall("eth_call", [
        { to: NFT_CONTRACT_ADDRESS, data: SEL.totalSupply },
        "latest",
      ]);
      supply = Math.min(decodeUint(hex), 5000);
    } catch {
      supply = 0;
    }

    // ── 2) ownerOf scan — true holdings for every token
    for (let start = 1; start <= supply; start += OWNER_BATCH) {
      const end = Math.min(supply, start + OWNER_BATCH - 1);
      const calls = [];
      for (let id = start; id <= end; id++) {
        calls.push({
          method: "eth_call",
          params: [
            { to: NFT_CONTRACT_ADDRESS, data: encodeOwnerOf(id) },
            "latest",
          ],
        });
      }
      try {
        const results = await rpcBatch(calls);
        for (const raw of results) {
          const owner = decodeAddress(raw);
          if (!owner) continue;
          if (!byAddress[owner]) byAddress[owner] = emptyStats();
          byAddress[owner].nfts += 1;
        }
      } catch {
        // retry token-by-token for this window
        for (let id = start; id <= end; id++) {
          try {
            const raw = await rpcCall("eth_call", [
              { to: NFT_CONTRACT_ADDRESS, data: encodeOwnerOf(id) },
              "latest",
            ]);
            const owner = decodeAddress(raw);
            if (!owner) continue;
            if (!byAddress[owner]) byAddress[owner] = emptyStats();
            byAddress[owner].nfts += 1;
          } catch {
            /* skip token */
          }
        }
      }
    }

    // Seed extras (wood list with 0 NFTs still listed)
    for (const raw of extraAddresses) {
      const a = normalize(raw);
      if (!/^0x[a-f0-9]{40}$/.test(a) || a === ZERO) continue;
      if (!byAddress[a]) byAddress[a] = emptyStats();
    }

    // ── 3) Verify top holders with balanceOf (catch scan drift)
    const holders = Object.keys(byAddress).filter((a) => byAddress[a].nfts > 0);
    holders.sort((a, b) => byAddress[b].nfts - byAddress[a].nfts);
    const verifyList = holders.slice(0, 40);
    for (let i = 0; i < verifyList.length; i += MINT_CHUNK) {
      const chunk = verifyList.slice(i, i + MINT_CHUNK);
      const calls = chunk.map((a) => ({
        method: "eth_call",
        params: [
          {
            to: NFT_CONTRACT_ADDRESS,
            data: encodeAddrCall(SEL.balanceOf, a),
          },
          "latest",
        ],
      }));
      try {
        const results = await rpcBatch(calls);
        chunk.forEach((a, idx) => {
          const bal = decodeUint(results[idx]);
          if (bal > 0) byAddress[a].nfts = bal;
        });
      } catch {
        /* keep scan counts */
      }
    }

    // ── 4) free / wood / paid remaining for every current holder
    //    (not all 2k wood list — only people who hold or held via remaining)
    const mintTargets = [
      ...new Set([
        ...holders,
        ...extraAddresses
          .map(normalize)
          .filter((a) => byAddress[a] && byAddress[a].nfts > 0),
      ]),
    ];

    for (let i = 0; i < mintTargets.length; i += MINT_CHUNK) {
      const chunk = mintTargets.slice(i, i + MINT_CHUNK);
      const calls: Array<{ method: string; params: unknown[] }> = [];
      for (const a of chunk) {
        for (const selector of [
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
          const base = idx * 3;
          const freeRem = decodeUint(results[base]);
          const woodRem = decodeUint(results[base + 1]);
          const paidRem = decodeUint(results[base + 2]);
          const prev = byAddress[a] || emptyStats();
          byAddress[a] = {
            nfts: prev.nfts,
            free: claimed(NFT_MINT_CAPS.free, freeRem),
            wood: claimed(NFT_MINT_CAPS.wood, woodRem),
            paid: claimed(NFT_MINT_CAPS.paid, paidRem),
          };
        });
      } catch {
        /* leave mint types 0 */
      }
    }

    let totalNfts = 0;
    for (const st of Object.values(byAddress)) totalNfts += st.nfts;

    const bag: CacheBag = {
      at: Date.now(),
      byAddress,
      holders: Object.keys(byAddress)
        .filter((a) => byAddress[a].nfts > 0)
        .sort((a, b) => byAddress[b].nfts - byAddress[a].nfts),
      totalNfts,
      uniqueHolders: holders.length,
      addresses: Object.keys(byAddress).length,
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
  return g().__plankNftWalletStats ?? null;
}

export function statsFor(
  bag: CacheBag | null | undefined,
  address: string
): WalletNftStats {
  if (!bag) return emptyStats();
  return bag.byAddress[normalize(address)] || emptyStats();
}
