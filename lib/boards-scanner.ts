import { CONTRACT_ADDRESS, CHAIN } from "@/lib/constants";
import {
  getTrapWindow,
  isOffWidgetCaptureActive,
  isSniperCaptureActive,
  normalizeAddress,
} from "@/lib/boards";
import {
  getBoardsState,
  markBadBoard,
  wasWidgetVerified,
} from "@/lib/boards-store";
import { ROBINHOOD_RPC_URLS } from "@/lib/mint-contract";

/** ERC-20 Transfer(address,address,uint256) */
const TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

const ZERO = "0x0000000000000000000000000000000000000000";

/** System / ignore list (not wallet snipers). */
const IGNORE = new Set(
  [
    ZERO,
    CONTRACT_ADDRESS.toLowerCase(),
    "0x000000000000000000000000000000000000dead",
    // Site fee treasury — not a sniper
    "0xfa987d386c4f61b27cb67a1e4e1239866fe8d9ba",
  ].map((a) => a.toLowerCase())
);

function topicToAddress(topic: string): string {
  // topics[1]/[2] are 32-byte left-padded addresses
  return normalizeAddress(`0x${topic.slice(26)}`);
}

async function rpc(method: string, params: unknown[]): Promise<unknown> {
  let lastErr: unknown;
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
      lastErr = e;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("All RPCs failed");
}

type TxMeta = {
  from: string;
  /** Native ETH msg.value in wei */
  valueWei: bigint;
};

const txMetaCache = new Map<string, TxMeta | null>();
const codeCache = new Map<string, boolean>();

/** true if address has contract code (router / pool / etc.) */
async function isContractAddress(address: string): Promise<boolean> {
  const a = normalizeAddress(address);
  if (codeCache.has(a)) return codeCache.get(a)!;
  try {
    const code = (await rpc("eth_getCode", [a, "latest"])) as string;
    const isContract = Boolean(code && code !== "0x" && code !== "0x0");
    codeCache.set(a, isContract);
    if (codeCache.size > 500) {
      const first = codeCache.keys().next().value;
      if (first) codeCache.delete(first);
    }
    return isContract;
  } catch {
    return false;
  }
}

/** Fetch tx.from + value (native ETH spent on the snipe call). */
async function getTxMeta(txHash: string): Promise<TxMeta | null> {
  const key = txHash.toLowerCase();
  if (txMetaCache.has(key)) return txMetaCache.get(key) ?? null;
  try {
    const tx = (await rpc("eth_getTransactionByHash", [txHash])) as {
      from?: string;
      value?: string;
    } | null;
    if (!tx?.from) {
      txMetaCache.set(key, null);
      return null;
    }
    let valueWei = BigInt(0);
    try {
      valueWei = BigInt(tx.value || "0x0");
    } catch {
      valueWei = BigInt(0);
    }
    const meta: TxMeta = {
      from: normalizeAddress(tx.from),
      valueWei,
    };
    txMetaCache.set(key, meta);
    // Bound cache during long scans
    if (txMetaCache.size > 500) {
      const first = txMetaCache.keys().next().value;
      if (first) txMetaCache.delete(first);
    }
    return meta;
  } catch {
    txMetaCache.set(key, null);
    return null;
  }
}

/**
 * Scan recent PLANK Transfer logs. Any wallet that moves $PLANK during the
 * death-trap / cooldown listing window without an official widget session
 * lands on Bad Boards. Good Wood offenders become "fallen".
 *
 * ETH spent: for each unique tx, attribute msg.value (native ETH) to the
 * signing wallet (tx.from) when they are marked Bad Boards — i.e. how much
 * ETH they put into the off-widget snipe call.
 */
export async function scanPlankTransfers(opts?: {
  fromBlock?: number;
  maxBlocks?: number;
}): Promise<{
  scannedFrom: number;
  scannedTo: number;
  newBad: number;
  ethAddedWei: string;
  notes: string[];
}> {
  const notes: string[] = [];
  // death_trap: flag all EOAs (widget locked → every buy is off-site / Uni)
  // cooldown_window: flag only non–plank.love widget buyers (server sessions)
  if (!isOffWidgetCaptureActive()) {
    const trap = getTrapWindow();
    notes.push(
      trap.phase === "free"
        ? "Free trade — Bad Boards chain capture off."
        : "Off-widget capture inactive — scan skipped."
    );
    return {
      scannedFrom: 0,
      scannedTo: 0,
      newBad: 0,
      ethAddedWei: "0",
      notes,
    };
  }

  const deathTrap = isSniperCaptureActive();

  const latestHex = (await rpc("eth_blockNumber", [])) as string;
  const latest = parseInt(latestHex, 16);
  const maxBlocks = opts?.maxBlocks ?? 4_000;
  const state = await getBoardsState();
  const trap = getTrapWindow();

  let fromBlock =
    opts?.fromBlock ??
    (state.lastScannedBlock > 0 ? state.lastScannedBlock + 1 : Math.max(0, latest - maxBlocks));

  // Never scan more than maxBlocks in one request
  if (latest - fromBlock > maxBlocks) {
    fromBlock = latest - maxBlocks;
    notes.push(`Capped scan to last ${maxBlocks} blocks.`);
  }

  if (fromBlock > latest) {
    notes.push("Already up to date.");
    return {
      scannedFrom: fromBlock,
      scannedTo: latest,
      newBad: 0,
      ethAddedWei: "0",
      notes,
    };
  }

  const logs = (await rpc("eth_getLogs", [
    {
      address: CONTRACT_ADDRESS,
      fromBlock: `0x${fromBlock.toString(16)}`,
      toBlock: `0x${latest.toString(16)}`,
      topics: [TRANSFER_TOPIC],
    },
  ])) as Array<{
    topics: string[];
    transactionHash: string;
    blockNumber: string;
  }>;

  let newBad = 0;
  let ethAdded = BigInt(0);
  const seen = new Set<string>();
  /** txHash → meta (fetch once per unique hash) */
  const uniqueHashes = new Set<string>();
  for (const log of logs || []) {
    if (log.transactionHash) uniqueHashes.add(log.transactionHash);
  }
  // Prefetch tx metas in small parallel batches
  const hashList = [...uniqueHashes];
  for (let i = 0; i < hashList.length; i += 8) {
    const batch = hashList.slice(i, i + 8);
    await Promise.all(batch.map((h) => getTxMeta(h)));
  }

  for (const log of logs || []) {
    if (!log.topics || log.topics.length < 3) continue;
    const from = topicToAddress(log.topics[1]);
    const to = topicToAddress(log.topics[2]);
    const txHash = log.transactionHash;
    const block = parseInt(log.blockNumber, 16);
    const meta = await getTxMeta(txHash);

    // Skip pure mints from zero if any
    const candidates = [from, to].filter((a) => !IGNORE.has(a) && a !== ZERO);
    // Always include tx.from if it's a real wallet (the ETH spender)
    if (meta?.from && !IGNORE.has(meta.from) && meta.from !== ZERO) {
      if (!candidates.includes(meta.from)) candidates.push(meta.from);
    }

    for (const wallet of candidates) {
      if (seen.has(wallet + txHash)) continue;
      seen.add(wallet + txHash);

      // Skip contracts (routers / pools) — only EOAs
      if (await isContractAddress(wallet)) {
        continue;
      }

      // After widget open: only flag the buyer (tx signer) if they never used plank.love
      if (!deathTrap) {
        if (!meta || meta.from !== wallet) continue;
        if (await wasWidgetVerified(wallet)) continue;
      }

      // Native ETH on this tx only counts for the signer
      let ethDelta = BigInt(0);
      if (meta && meta.from === wallet && meta.valueWei > BigInt(0)) {
        ethDelta = meta.valueWei;
      }

      const before = (await getBoardsState()).badBoards[wallet];
      const prevWei = BigInt(before?.ethSpentWei || "0");
      const entry = await markBadBoard({
        address: wallet,
        reason: deathTrap
          ? "Death trap snipe — $PLANK moved while plank.love widget was locked (Uniswap app / bots / external)"
          : "Off-site buy — $PLANK moved without a plank.love widget session (Uniswap UI or other frontend)",
        source: deathTrap ? "death_trap_chain" : "off_site_uniswap",
        venue: deathTrap ? "death_trap" : "off_site",
        txHash,
        ethSpentWeiDelta: ethDelta > BigInt(0) ? ethDelta : undefined,
        at: new Date(),
        captureMode: deathTrap ? "sniper" : "off_widget",
      });
      if (entry && !before) newBad += 1;
      if (entry) {
        const afterWei = BigInt(entry.ethSpentWei || "0");
        if (afterWei > prevWei) ethAdded += afterWei - prevWei;
      }
    }

    void block;
  }

  const finalNotes = [
    `Scanned ${fromBlock}→${latest} on ${CHAIN.name}; logs=${(logs || []).length}; newBad=${newBad}; eth+=${ethAdded.toString()} wei`,
    `Trap phase=${trap.phase}`,
    ...notes,
  ];
  const { setScanCursor } = await import("@/lib/boards-store");
  await setScanCursor(latest, finalNotes);

  notes.push(
    `newBad=${newBad}`,
    `blocks=${fromBlock}-${latest}`,
    `transfers=${(logs || []).length}`,
    `ethAddedWei=${ethAdded.toString()}`
  );
  return {
    scannedFrom: fromBlock,
    scannedTo: latest,
    newBad,
    ethAddedWei: ethAdded.toString(),
    notes,
  };
}
