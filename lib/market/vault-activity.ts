import { Interface } from "ethers";
import {
  durableKv as kv,
  hasDurableKv,
} from "@/lib/market/durable-kv";
import { MARKET_VAULT_ADDRESS, MARKET_VAULT_ADDRESSES } from "@/lib/constants";
import vaultAbi from "@/lib/market/vault-abi.json";
import { BLOCKSCOUT_BASE, fetchAddressLogs } from "@/lib/market/blockscout";
import { ethBlockNumber, ethGetLogs, rpcCall } from "@/lib/market/fetch-rpc";
import { logScanBudget } from "@/lib/market/rpc-budget";

const IFACE = new Interface(vaultAbi);

export type VaultTradeKind =
  | "buy"
  | "sell"
  | "deposit"
  | "redeem"
  | "add_lp"
  | "remove_lp";

export type VaultTradeEvent = {
  kind: VaultTradeKind;
  address: string;
  ethWei: string | null;
  sharesWei: string | null;
  tokenId: string | null;
  txHash: string;
  blockNumber: number;
  logIndex: number;
  timestamp: string | null;
  /** Which vault emitted this (primary V2 or legacy V1). */
  vaultAddress?: string;
};

const TOPICS = {
  Bought: IFACE.getEvent("Bought")!.topicHash.toLowerCase(),
  Sold: IFACE.getEvent("Sold")!.topicHash.toLowerCase(),
  Deposited: IFACE.getEvent("Deposited")!.topicHash.toLowerCase(),
  Redeemed: IFACE.getEvent("Redeemed")!.topicHash.toLowerCase(),
  LiquidityContributed: IFACE.getEvent("LiquidityContributed")!.topicHash.toLowerCase(),
  LiquidityRemoved: IFACE.getEvent("LiquidityRemoved")!.topicHash.toLowerCase(),
};

const VAULT_TOPIC_SET = new Set(Object.values(TOPICS));
/** v3 = dual-vault + Add/Remove LP (LiquidityContributed / LiquidityRemoved). */
const KV_KEY = "plank:market:vault-activity-v3";
const STORED_HISTORY_LIMIT = 500;

/**
 * Highest block already covered by an eth_getLogs scan, per vault. Without
 * this every refresh re-walked the same 12 x 50k-block windows from the chain
 * head backwards — a fixed 12 eth_getLogs per vault per refresh, forever, on a
 * vault that had not emitted an event in weeks. Recording where the last scan
 * finished turns the steady state into a single forward window.
 */
const SCAN_HEAD_KV_KEY = "plank:market:vault-scan-head-v1";

/**
 * Both the SSE stream (getVaultActivity(40)) and estimateApr inside
 * getVaultStats (getVaultActivity(80)) run on every stream refresh, in the same
 * Promise.all. They were each paying for a full multi-source rebuild. Scanning
 * once at a shared cap and slicing serves both from one pass.
 */
const MEMO_MS = 30_000;
const MEMO_MIN_CAP = 100;

let memo: { at: number; full: boolean; cap: number; events: VaultTradeEvent[] } | null = null;
let memoInflight: { full: boolean; cap: number; promise: Promise<VaultTradeEvent[]> } | null = null;

function hasKv(): boolean {
  return hasDurableKv();
}

function normalizeTopics(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((t): t is string => typeof t === "string" && t.length > 0)
    .map((t) => {
      const s = t.startsWith("0x") ? t : `0x${t}`;
      return s.toLowerCase();
    });
}

function decodeLog(
  log: {
    topics: string[];
    data: string;
    transactionHash: string;
    blockNumber: string | number;
    logIndex: string | number;
    timestamp?: string | null;
  },
  vaultAddress?: string
): VaultTradeEvent | null {
  const topics = normalizeTopics(log.topics);
  const topic0 = topics[0];
  if (!topic0 || !VAULT_TOPIC_SET.has(topic0)) return null;

  const blockNumber = Number(BigInt(log.blockNumber || 0));
  const logIndex = Number(BigInt(log.logIndex || 0));
  const data = log.data && log.data !== "0x" ? log.data : "0x";
  const base = {
    txHash: log.transactionHash,
    blockNumber,
    logIndex,
    timestamp: log.timestamp ?? null,
    ...(vaultAddress ? { vaultAddress } : {}),
  };

  try {
    // Pass original-cased topics to ethers — it accepts lowercase.
    if (topic0 === TOPICS.Bought) {
      const parsed = IFACE.decodeEventLog("Bought", data, topics);
      return {
        ...base,
        kind: "buy",
        address: String(parsed.buyer),
        ethWei: parsed.ethIn.toString(),
        sharesWei: parsed.sharesOut.toString(),
        tokenId: null,
      };
    }
    if (topic0 === TOPICS.Sold) {
      const parsed = IFACE.decodeEventLog("Sold", data, topics);
      return {
        ...base,
        kind: "sell",
        address: String(parsed.seller),
        ethWei: parsed.ethOut.toString(),
        sharesWei: parsed.sharesIn.toString(),
        tokenId: null,
      };
    }
    if (topic0 === TOPICS.Deposited) {
      const parsed = IFACE.decodeEventLog("Deposited", data, topics);
      return {
        ...base,
        kind: "deposit",
        address: String(parsed.from),
        ethWei: null,
        sharesWei: null,
        tokenId: parsed.tokenId.toString(),
      };
    }
    if (topic0 === TOPICS.Redeemed) {
      const parsed = IFACE.decodeEventLog("Redeemed", data, topics);
      return {
        ...base,
        kind: "redeem",
        address: String(parsed.to),
        ethWei: null,
        sharesWei: null,
        tokenId: parsed.tokenId.toString(),
      };
    }
    if (topic0 === TOPICS.LiquidityContributed) {
      const parsed = IFACE.decodeEventLog("LiquidityContributed", data, topics);
      return {
        ...base,
        kind: "add_lp",
        address: String(parsed.from),
        ethWei: parsed.ethIn.toString(),
        sharesWei: parsed.sharesIn.toString(),
        tokenId: null,
      };
    }
    if (topic0 === TOPICS.LiquidityRemoved) {
      const parsed = IFACE.decodeEventLog("LiquidityRemoved", data, topics);
      return {
        ...base,
        kind: "remove_lp",
        address: String(parsed.to),
        ethWei: parsed.ethOut.toString(),
        sharesWei: parsed.sharesOut.toString(),
        tokenId: null,
      };
    }
  } catch {
    return null;
  }
  return null;
}

function sortNewest(events: VaultTradeEvent[]): VaultTradeEvent[] {
  return events.sort(
    (a, b) => b.blockNumber - a.blockNumber || b.logIndex - a.logIndex
  );
}

function dedupeKey(e: VaultTradeEvent): string {
  return `${(e.vaultAddress || "").toLowerCase()}:${e.txHash}:${e.logIndex}:${e.kind}`;
}

export function mergeVaultActivityHistory(
  ...lists: VaultTradeEvent[][]
): VaultTradeEvent[] {
  const map = new Map<string, VaultTradeEvent>();
  for (const list of lists) {
    for (const e of list) {
      if (!e.txHash) continue;
      map.set(dedupeKey(e), e);
    }
  }
  return sortNewest([...map.values()]);
}

async function readKv(): Promise<VaultTradeEvent[]> {
  if (!hasKv()) return [];
  try {
    const v = await kv.get<VaultTradeEvent[] | { events?: VaultTradeEvent[] }>(KV_KEY);
    if (Array.isArray(v)) return v;
    if (v && Array.isArray(v.events)) return v.events;
  } catch {
    /* */
  }
  return [];
}

async function writeKv(events: VaultTradeEvent[]): Promise<void> {
  if (!hasKv() || events.length === 0) return;
  try {
    // Keep the last known-good history indefinitely. A current short scan
    // merges new events into this lineage; upstream outages must not erase
    // the only fast copy or force a full-chain cold walk.
    const trimmed = events.slice(0, STORED_HISTORY_LIMIT);
    await kv.set(KV_KEY, trimmed);
  } catch {
    /* */
  }
}

async function readScanHeads(): Promise<Record<string, number>> {
  if (!hasKv()) return {};
  try {
    const v = await kv.get<Record<string, number>>(SCAN_HEAD_KV_KEY);
    if (v && typeof v === "object") return v;
  } catch {
    /* */
  }
  return {};
}

/**
 * Only ever advances. A lower value would re-scan blocks we already have, and
 * a concurrent Passenger worker holding a staler head must not walk it back.
 */
async function writeScanHead(vault: string, block: number): Promise<void> {
  if (!hasKv() || !Number.isFinite(block) || block <= 0) return;
  try {
    const heads = await readScanHeads();
    const key = vault.toLowerCase();
    if ((heads[key] ?? 0) >= block) return;
    await kv.set(SCAN_HEAD_KV_KEY, { ...heads, [key]: block });
  } catch {
    /* */
  }
}

/**
 * Deep Blockscout walk: vault address logs are dominated by ERC-20 Transfer
 * share mints. We keep paginating until we have enough *decoded* vault
 * events (or pages run out).
 */
async function fromBlockscout(
  vault: string,
  limit: number
): Promise<VaultTradeEvent[]> {
  const events: VaultTradeEvent[] = [];
  const maxPages = Math.max(20, Math.ceil(limit / 5));
  // Use shared paginate helper with higher page budget
  const logs = await fetchAddressLogs(vault, { maxPages });
  for (const log of logs) {
    const ev = decodeLog(
      {
        topics: (log.topics || []) as string[],
        data: log.data || "0x",
        transactionHash: log.transaction_hash || "",
        blockNumber: log.block_number ?? 0,
        logIndex: log.index ?? 0,
        timestamp: log.block_timestamp ?? null,
      },
      vault
    );
    if (ev) events.push(ev);
  }
  return sortNewest(events).slice(0, limit);
}

/**
 * Also walk vault *transactions* (method deposit/redeem/buy/sell) and pull
 * logs from each tx — catches events when address log feed is Transfer-heavy.
 */
async function fromBlockscoutTxMethods(
  vault: string,
  limit: number
): Promise<VaultTradeEvent[]> {
  const events: VaultTradeEvent[] = [];
  const vaultLc = vault.toLowerCase();
  try {
    let path = `/api/v2/addresses/${vault}/transactions`;
    for (let page = 0; page < 12 && events.length < limit; page += 1) {
      const res = await fetch(`${BLOCKSCOUT_BASE}${path}`, {
        headers: { Accept: "application/json", "User-Agent": "plank.love/1.0" },
        cache: "no-store",
        signal: AbortSignal.timeout(12_000),
      });
      if (!res.ok) break;
      const data = (await res.json()) as {
        items?: Array<{ hash?: string; method?: string | null; status?: string }>;
        next_page_params?: Record<string, string | number> | null;
      };
      const items = data.items || [];
      for (const tx of items) {
        if (!tx.hash || tx.status === "error") continue;
        const method = (tx.method || "").toLowerCase();
        if (
          !method.includes("deposit") &&
          !method.includes("redeem") &&
          !method.includes("buy") &&
          !method.includes("sell") &&
          // claimRandomRedeemFor shows up as claim* on explorers
          !method.includes("claim") &&
          !method.includes("liquidity") &&
          !method.includes("contribute") &&
          method !== ""
        ) {
          // empty method still worth checking a few
          if (
            method &&
            !/deposit|redeem|buy|sell|mint|swap|claim|liquidity|contribute/.test(method)
          )
            continue;
        }
        try {
          const logRes = await fetch(`${BLOCKSCOUT_BASE}/api/v2/transactions/${tx.hash}/logs`, {
            headers: { Accept: "application/json" },
            cache: "no-store",
            signal: AbortSignal.timeout(8_000),
          });
          if (!logRes.ok) continue;
          const logData = (await logRes.json()) as {
            items?: Array<{
              topics?: (string | null)[];
              data?: string;
              index?: number;
              block_number?: number;
              block_timestamp?: string | null;
              address?: { hash?: string };
            }>;
          };
          for (const log of logData.items || []) {
            const addr = (log.address?.hash || "").toLowerCase();
            if (addr && addr !== vaultLc) continue;
            const ev = decodeLog(
              {
                topics: (log.topics || []) as string[],
                data: log.data || "0x",
                transactionHash: tx.hash,
                blockNumber: log.block_number ?? 0,
                logIndex: log.index ?? 0,
                timestamp: log.block_timestamp ?? null,
              },
              vault
            );
            if (ev) events.push(ev);
          }
        } catch {
          /* next tx */
        }
        if (events.length >= limit) break;
      }
      const next = data.next_page_params;
      if (!next || Object.keys(next).length === 0) break;
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(next)) qs.set(k, String(v));
      path = `/api/v2/addresses/${vault}/transactions?${qs}`;
    }
  } catch {
    /* */
  }
  return sortNewest(events).slice(0, limit);
}

async function fromEthRpc(
  vault: string,
  limit: number,
  full: boolean
): Promise<VaultTradeEvent[]> {
  const topics = [
    TOPICS.Bought,
    TOPICS.Sold,
    TOPICS.Deposited,
    TOPICS.Redeemed,
    TOPICS.LiquidityContributed,
    TOPICS.LiquidityRemoved,
  ];
  const latest = await ethBlockNumber();
  const { chunkBlocks, maxChunks } = logScanBudget();
  const chunks = full ? Math.max(maxChunks, 15) : maxChunks;
  const rawLogs: Array<{
    topics: string[];
    data: string;
    blockNumber: string;
    transactionHash: string;
    logIndex: string;
  }> = [];

  const getLogs = (fromBlock: number, toBlock: number) =>
    ethGetLogs({
      address: vault,
      topics: [topics],
      fromBlock: "0x" + fromBlock.toString(16),
      toBlock: "0x" + toBlock.toString(16),
    });

  // A full/backfill request always re-walks from the head; the incremental
  // path is only for the routine live refresh.
  const head = full ? 0 : (await readScanHeads())[vault.toLowerCase()] ?? 0;

  if (head > 0 && head < latest) {
    // Steady state: one forward window covering only new blocks. Advance the
    // stored head to the last block actually covered, so a partial scan (chain
    // moved further than maxChunks allows, or a window threw) resumes rather
    // than silently skipping the gap.
    let from = head + 1;
    let scannedTo = head;
    for (let chunk = 0; chunk < maxChunks && from <= latest; chunk += 1) {
      const to = Math.min(latest, from + chunkBlocks - 1);
      try {
        rawLogs.push(...(await getLogs(from, to)));
      } catch {
        break;
      }
      scannedTo = to;
      from = to + 1;
    }
    // Awaited, not fire-and-forget: a short-lived process (the refresh cron)
    // can exit before a floating write lands, which would silently throw away
    // the head and make the next run repeat the full cold walk.
    if (scannedTo > head) await writeScanHead(vault, scannedTo);
  } else {
    // Cold start (or explicit full backfill): walk backwards from the head.
    let toBlock = latest;
    let completed = true;
    for (
      let chunk = 0;
      chunk < chunks && toBlock >= 0 && (full || rawLogs.length < limit * 3);
      chunk += 1
    ) {
      const fromBlock = Math.max(0, toBlock - chunkBlocks);
      try {
        rawLogs.push(...(await getLogs(fromBlock, toBlock)));
      } catch {
        completed = false;
        break;
      }
      if (fromBlock === 0) break;
      toBlock = fromBlock - 1;
    }
    // Only claim coverage up to `latest` if no window failed — otherwise the
    // next run would skip the blocks this one never actually read.
    if (completed) await writeScanHead(vault, latest);
  }

  if (rawLogs.length === 0) return [];

  rawLogs.sort((a, b) => {
    const bn = Number(BigInt(b.blockNumber) - BigInt(a.blockNumber));
    if (bn !== 0) return bn;
    return Number(BigInt(b.logIndex) - BigInt(a.logIndex));
  });
  const trimmed = full ? rawLogs : rawLogs.slice(0, limit);

  const blockNumbers = [...new Set(trimmed.map((l) => l.blockNumber))];
  const blockTimeByNumber = new Map<string, number>();
  await Promise.all(
    blockNumbers.slice(0, 60).map(async (bn) => {
      try {
        const block = await rpcCall<{ timestamp?: string }>("eth_getBlockByNumber", [bn, false], {
          timeoutMs: 4_000,
        });
        if (block?.timestamp) blockTimeByNumber.set(bn, Number(BigInt(block.timestamp)));
      } catch {
        /* skip */
      }
    })
  );

  const events: VaultTradeEvent[] = [];
  for (const log of trimmed) {
    const ts = blockTimeByNumber.get(log.blockNumber);
    const ev = decodeLog(
      {
        topics: log.topics,
        data: log.data,
        transactionHash: log.transactionHash,
        blockNumber: log.blockNumber,
        logIndex: log.logIndex,
        timestamp: ts == null ? null : new Date(ts * 1000).toISOString(),
      },
      vault
    );
    if (ev) events.push(ev);
  }
  return events;
}

async function scanVault(
  vault: string,
  limit: number,
  full: boolean
): Promise<VaultTradeEvent[]> {
  const cap = full ? 400 : limit;
  const parts: VaultTradeEvent[][] = [];
  try {
    parts.push(await fromBlockscout(vault, full ? cap : Math.min(cap, 60)));
  } catch {
    /* */
  }
  let merged = mergeVaultActivityHistory(...parts);
  if (merged.length < Math.min(cap, 25) || full) {
    try {
      parts.push(await fromBlockscoutTxMethods(vault, full ? cap : 30));
      merged = mergeVaultActivityHistory(...parts);
    } catch {
      /* */
    }
  }
  if (merged.length < Math.min(cap, 15) || full) {
    try {
      parts.push(await fromEthRpc(vault, cap, full));
      merged = mergeVaultActivityHistory(...parts);
    } catch {
      /* */
    }
  }
  return merged.slice(0, cap);
}

/**
 * Vault buy/sell/deposit/redeem/add-LP/remove-LP history for primary + legacy vaults.
 * Merges Blockscout logs, method-tx deep walk, eth_getLogs, and durable KV.
 */
export async function getVaultActivity(
  limit = 40,
  opts?: { full?: boolean }
): Promise<VaultTradeEvent[]> {
  if (!MARKET_VAULT_ADDRESS && MARKET_VAULT_ADDRESSES.length === 0) return [];
  const full = opts?.full ?? false;
  const cap = full ? 400 : limit;

  // Scan at a shared cap so the stream's limit=40 and estimateApr's limit=80
  // resolve to the same pass instead of two independent rebuilds.
  const scanCap = full ? 400 : Math.max(cap, MEMO_MIN_CAP);

  if (memo && memo.full === full && memo.cap >= cap && Date.now() - memo.at < MEMO_MS) {
    return memo.events.slice(0, cap);
  }
  if (memoInflight && memoInflight.full === full && memoInflight.cap >= cap) {
    return (await memoInflight.promise).slice(0, cap);
  }

  const run = buildVaultActivity(scanCap, full).then(
    (events) => {
      memo = { at: Date.now(), full, cap: scanCap, events };
      return events;
    },
    (err) => {
      // Don't cache a failure — the next caller should be free to retry.
      throw err;
    }
  );
  memoInflight = { full, cap: scanCap, promise: run };
  try {
    return (await run).slice(0, cap);
  } finally {
    if (memoInflight?.promise === run) memoInflight = null;
  }
}

async function buildVaultActivity(
  cap: number,
  full: boolean
): Promise<VaultTradeEvent[]> {
  const vaults =
    MARKET_VAULT_ADDRESSES.length > 0
      ? [...MARKET_VAULT_ADDRESSES]
      : MARKET_VAULT_ADDRESS
        ? [MARKET_VAULT_ADDRESS]
        : [];

  const kvEvents = await readKv();
  // Full lineage is a read-heavy chart/history request. Once PostgreSQL has a
  // verified lineage, serve it immediately instead of repeating the expensive
  // multi-source full-chain walk in every Passenger process. The normal
  // activity request still performs a bounded live scan and merges new events
  // into this durable history.
  if (full && kvEvents.length > 0) {
    return kvEvents.slice(0, cap);
  }

  // Per-vault budget so dual mode still has room for V1 redeems.
  const perVault = Math.max(20, Math.ceil(cap / Math.max(1, vaults.length)));

  const scanned = await Promise.all(
    vaults.map((v) => scanVault(v, perVault, full).catch(() => [] as VaultTradeEvent[]))
  );

  const merged = mergeVaultActivityHistory(kvEvents, ...scanned);

  if (merged.length === 0 && kvEvents.length > 0) {
    return kvEvents.slice(0, cap);
  }

  const out = merged.slice(0, cap);
  const headKv = kvEvents[0]?.blockNumber ?? 0;
  const headOut = out[0]?.blockNumber ?? 0;
  const durableHistory = merged.slice(0, STORED_HISTORY_LIMIT);
  if (
    durableHistory.length > 0 &&
    (durableHistory.length > kvEvents.length || headOut > headKv)
  ) {
    // Persist the full merged lineage, not the caller's short response. The
    // old behavior truncated a 400-event history back to 80 whenever a new
    // event arrived through the normal live endpoint.
    void writeKv(durableHistory);
  }
  return out;
}
