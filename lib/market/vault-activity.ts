import { Interface } from "ethers";
import { kv } from "@vercel/kv";
import { MARKET_VAULT_ADDRESS } from "@/lib/constants";
import vaultAbi from "@/lib/market/vault-abi.json";
import { BLOCKSCOUT_BASE, fetchAddressLogs } from "@/lib/market/blockscout";
import { ethBlockNumber, ethGetLogs, rpcCall } from "@/lib/market/fetch-rpc";
import { logScanBudget } from "@/lib/market/rpc-budget";

const IFACE = new Interface(vaultAbi);

export type VaultTradeKind = "buy" | "sell" | "deposit" | "redeem";

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
};

const TOPICS = {
  Bought: IFACE.getEvent("Bought")!.topicHash.toLowerCase(),
  Sold: IFACE.getEvent("Sold")!.topicHash.toLowerCase(),
  Deposited: IFACE.getEvent("Deposited")!.topicHash.toLowerCase(),
  Redeemed: IFACE.getEvent("Redeemed")!.topicHash.toLowerCase(),
};

const VAULT_TOPIC_SET = new Set(Object.values(TOPICS));
const KV_KEY = "plank:market:vault-activity-v1";
const KV_TTL = 6 * 60 * 60;

function hasKv(): boolean {
  return Boolean(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN);
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

function decodeLog(log: {
  topics: string[];
  data: string;
  transactionHash: string;
  blockNumber: string | number;
  logIndex: string | number;
  timestamp?: string | null;
}): VaultTradeEvent | null {
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
  return `${e.txHash}:${e.logIndex}:${e.kind}`;
}

function mergeEvents(...lists: VaultTradeEvent[][]): VaultTradeEvent[] {
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
    // Cap stored history
    const trimmed = events.slice(0, 500);
    await kv.set(KV_KEY, trimmed, { ex: KV_TTL });
  } catch {
    /* */
  }
}

/**
 * Deep Blockscout walk: vault address logs are dominated by ERC-20 Transfer
 * share mints. We keep paginating until we have enough *decoded* vault
 * events (or pages run out).
 */
async function fromBlockscout(limit: number): Promise<VaultTradeEvent[]> {
  if (!MARKET_VAULT_ADDRESS) return [];
  const events: VaultTradeEvent[] = [];
  const maxPages = Math.max(20, Math.ceil(limit / 5));
  // Use shared paginate helper with higher page budget
  const logs = await fetchAddressLogs(MARKET_VAULT_ADDRESS, { maxPages });
  for (const log of logs) {
    const ev = decodeLog({
      topics: (log.topics || []) as string[],
      data: log.data || "0x",
      transactionHash: log.transaction_hash || "",
      blockNumber: log.block_number ?? 0,
      logIndex: log.index ?? 0,
      timestamp: log.block_timestamp ?? null,
    });
    if (ev) events.push(ev);
  }
  return sortNewest(events).slice(0, limit);
}

/**
 * Also walk vault *transactions* (method deposit/redeem/buy/sell) and pull
 * logs from each tx — catches events when address log feed is Transfer-heavy.
 */
async function fromBlockscoutTxMethods(limit: number): Promise<VaultTradeEvent[]> {
  if (!MARKET_VAULT_ADDRESS) return [];
  const events: VaultTradeEvent[] = [];
  try {
    let path = `/api/v2/addresses/${MARKET_VAULT_ADDRESS}/transactions`;
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
          method !== ""
        ) {
          // empty method still worth checking a few
          if (method && !/deposit|redeem|buy|sell|mint|swap/.test(method)) continue;
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
            if (addr && addr !== MARKET_VAULT_ADDRESS.toLowerCase()) continue;
            const ev = decodeLog({
              topics: (log.topics || []) as string[],
              data: log.data || "0x",
              transactionHash: tx.hash,
              blockNumber: log.block_number ?? 0,
              logIndex: log.index ?? 0,
              timestamp: log.block_timestamp ?? null,
            });
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
      path = `/api/v2/addresses/${MARKET_VAULT_ADDRESS}/transactions?${qs}`;
    }
  } catch {
    /* */
  }
  return sortNewest(events).slice(0, limit);
}

async function fromEthRpc(limit: number, full: boolean): Promise<VaultTradeEvent[]> {
  if (!MARKET_VAULT_ADDRESS) return [];
  const vault = MARKET_VAULT_ADDRESS;
  const topics = [TOPICS.Bought, TOPICS.Sold, TOPICS.Deposited, TOPICS.Redeemed];
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
  let toBlock = latest;
  for (
    let chunk = 0;
    chunk < chunks && toBlock >= 0 && (full || rawLogs.length < limit * 3);
    chunk += 1
  ) {
    const fromBlock = Math.max(0, toBlock - chunkBlocks);
    try {
      const found = await ethGetLogs({
        address: vault,
        topics: [topics],
        fromBlock: "0x" + fromBlock.toString(16),
        toBlock: "0x" + toBlock.toString(16),
      });
      rawLogs.push(...found);
    } catch {
      break;
    }
    if (fromBlock === 0) break;
    toBlock = fromBlock - 1;
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
    const ev = decodeLog({
      topics: log.topics,
      data: log.data,
      transactionHash: log.transactionHash,
      blockNumber: log.blockNumber,
      logIndex: log.logIndex,
      timestamp: ts == null ? null : new Date(ts * 1000).toISOString(),
    });
    if (ev) events.push(ev);
  }
  return events;
}

/**
 * Vault buy/sell/deposit/redeem history. Merges Blockscout logs, method-tx
 * deep walk, eth_getLogs, and durable KV so CF never shows an empty book
 * after a partial scan.
 */
export async function getVaultActivity(
  limit = 40,
  opts?: { full?: boolean }
): Promise<VaultTradeEvent[]> {
  if (!MARKET_VAULT_ADDRESS) return [];
  const full = opts?.full ?? false;
  const cap = full ? 400 : limit;

  const kvEvents = await readKv();
  const parts: VaultTradeEvent[][] = [kvEvents];

  // ALWAYS merge a shallow recent Blockscout scan with KV so new
  // deposit/redeem/buy/sell appear within one request — never freeze the
  // ticker on a warm-but-stale KV book for hours.
  try {
    parts.push(await fromBlockscout(full ? cap : Math.min(cap, 60)));
  } catch {
    /* keep KV */
  }

  let merged = mergeEvents(...parts);

  // Deepen only when still thin or full lineage requested.
  if (merged.length < Math.min(cap, 25) || full) {
    try {
      parts.push(await fromBlockscoutTxMethods(full ? cap : 30));
      merged = mergeEvents(...parts);
    } catch {
      /* */
    }
  }

  if (merged.length < Math.min(cap, 15) || full) {
    try {
      parts.push(await fromEthRpc(cap, full));
      merged = mergeEvents(...parts);
    } catch {
      /* */
    }
  }

  // If live scans failed entirely, still serve KV rather than empty.
  if (merged.length === 0 && kvEvents.length > 0) {
    return kvEvents.slice(0, cap);
  }

  const out = merged.slice(0, cap);
  const headKv = kvEvents[0]?.blockNumber ?? 0;
  const headOut = out[0]?.blockNumber ?? 0;
  if (out.length > 0 && (out.length > kvEvents.length || headOut > headKv)) {
    void writeKv(out);
  }
  return out;
}
