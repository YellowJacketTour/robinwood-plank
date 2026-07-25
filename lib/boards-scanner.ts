import { CONTRACT_ADDRESS, CHAIN } from "@/lib/constants";
import {
  getTrapWindow,
  isListingWindowActive,
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

/**
 * Scan recent PLANK Transfer logs. Any wallet that moves $PLANK during the
 * death-trap / cooldown listing window without an official widget session
 * lands on Bad Boards. Good Wood offenders become "fallen".
 */
export async function scanPlankTransfers(opts?: {
  fromBlock?: number;
  maxBlocks?: number;
}): Promise<{
  scannedFrom: number;
  scannedTo: number;
  newBad: number;
  notes: string[];
}> {
  const notes: string[] = [];
  if (!isListingWindowActive()) {
    notes.push("Listing window inactive — scan skipped.");
    return { scannedFrom: 0, scannedTo: 0, newBad: 0, notes };
  }

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
    return { scannedFrom: fromBlock, scannedTo: latest, newBad: 0, notes };
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
  const seen = new Set<string>();

  for (const log of logs || []) {
    if (!log.topics || log.topics.length < 3) continue;
    const from = topicToAddress(log.topics[1]);
    const to = topicToAddress(log.topics[2]);
    const txHash = log.transactionHash;
    const block = parseInt(log.blockNumber, 16);

    // Skip pure mints from zero if any
    const candidates = [from, to].filter((a) => !IGNORE.has(a) && a !== ZERO);
    for (const wallet of candidates) {
      if (seen.has(wallet + txHash)) continue;
      seen.add(wallet + txHash);

      const widget = await wasWidgetVerified(wallet);
      if (widget) {
        // Official plank.love path — keep Good / neutral; still starts cooldown via widget ping
        continue;
      }

      // Off-widget PLANK movement during trap → Bad Boards
      const before = (await getBoardsState()).badBoards[wallet];
      const entry = await markBadBoard({
        address: wallet,
        reason: widget
          ? "Off-widget activity after official use"
          : "Transacted $PLANK outside official plank.love widget during death trap / cooldown",
        source: "chain_transfer",
        txHash,
        at: new Date(), // block timestamp optional; now is fine for listing ops
      });
      if (entry && !before) newBad += 1;
    }

    void block;
  }

  const finalNotes = [
    `Scanned ${fromBlock}→${latest} on ${CHAIN.name}; logs=${(logs || []).length}; newBad=${newBad}`,
    `Trap phase=${trap.phase}`,
    ...notes,
  ];
  const { setScanCursor } = await import("@/lib/boards-store");
  await setScanCursor(latest, finalNotes);

  notes.push(`newBad=${newBad}`, `blocks=${fromBlock}-${latest}`, `transfers=${(logs || []).length}`);
  return { scannedFrom: fromBlock, scannedTo: latest, newBad, notes };
}
