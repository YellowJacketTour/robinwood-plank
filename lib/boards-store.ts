import { promises as fs } from "node:fs";
import path from "node:path";
import {
  cooldownEndsAt,
  isListingWindowActive,
  isSniperCaptureActive,
  normalizeAddress,
  WALLET_COOLDOWN_MS,
} from "@/lib/boards";
import type {
  BadBoardEntry,
  BoardsState,
  WidgetSession,
} from "@/lib/boards-types";

type GlobalBoards = {
  __plankBoardsState?: BoardsState;
  __plankGoodWood?: Set<string>;
  __plankGoodWoodAt?: number;
};

function g(): GlobalBoards {
  return globalThis as GlobalBoards;
}

function emptyState(): BoardsState {
  return {
    updatedAt: new Date().toISOString(),
    widgetSessions: {},
    badBoards: {},
    cooldowns: {},
    lastScannedBlock: 0,
    lastScanAt: undefined,
    scanNotes: [],
    totalEthSpentWei: "0",
  };
}

function recomputeTotalEth(state: BoardsState): void {
  let total = BigInt(0);
  for (const e of Object.values(state.badBoards)) {
    try {
      total += BigInt(e.ethSpentWei || "0");
    } catch {
      // skip bad wei
    }
  }
  state.totalEthSpentWei = total.toString();
}

const TMP_PATH =
  process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME
    ? path.join("/tmp", "plank-boards-state.json")
    : path.join(process.cwd(), "data", "boards-state.json");

async function ensureLoaded(): Promise<BoardsState> {
  const glob = g();
  if (glob.__plankBoardsState) return glob.__plankBoardsState;

  try {
    const raw = await fs.readFile(TMP_PATH, "utf8");
    const parsed = JSON.parse(raw) as BoardsState;
    const badBoards: BoardsState["badBoards"] = {};
    for (const [k, v] of Object.entries(parsed.badBoards || {})) {
      badBoards[k] = {
        ...v,
        ethSpentWei: v.ethSpentWei || "0",
        txHashes: v.txHashes || [],
        sources: v.sources || [],
      };
    }
    glob.__plankBoardsState = {
      ...emptyState(),
      ...parsed,
      widgetSessions: parsed.widgetSessions || {},
      badBoards,
      cooldowns: parsed.cooldowns || {},
      scanNotes: parsed.scanNotes || [],
      totalEthSpentWei: parsed.totalEthSpentWei || "0",
    };
    recomputeTotalEth(glob.__plankBoardsState);
  } catch {
    glob.__plankBoardsState = emptyState();
  }
  return glob.__plankBoardsState;
}

async function persist(state: BoardsState): Promise<void> {
  state.updatedAt = new Date().toISOString();
  g().__plankBoardsState = state;
  try {
    if (!process.env.VERCEL && !process.env.AWS_LAMBDA_FUNCTION_NAME) {
      await fs.mkdir(path.dirname(TMP_PATH), { recursive: true });
    }
    await fs.writeFile(TMP_PATH, JSON.stringify(state), "utf8");
  } catch {
    // /tmp or data write failed — memory still holds state for this instance
  }
}

/** Load Good Wood: Wood List proofs + optional airdrop list. */
export async function loadGoodWoodSet(): Promise<Set<string>> {
  const glob = g();
  const now = Date.now();
  if (glob.__plankGoodWood && glob.__plankGoodWoodAt && now - glob.__plankGoodWoodAt < 5 * 60_000) {
    return glob.__plankGoodWood;
  }

  const set = new Set<string>();

  try {
    const proofsPath = path.join(process.cwd(), "public", "proofs.json");
    const raw = await fs.readFile(proofsPath, "utf8");
    const data = JSON.parse(raw) as { proofs?: Record<string, unknown> };
    if (data.proofs) {
      for (const addr of Object.keys(data.proofs)) {
        if (/^0x[a-fA-F0-9]{40}$/i.test(addr)) set.add(normalizeAddress(addr));
      }
    }
  } catch {
    // proofs missing
  }

  try {
    const airdropPath = path.join(process.cwd(), "public", "airdrop.json");
    const raw = await fs.readFile(airdropPath, "utf8");
    const data = JSON.parse(raw) as { addresses?: string[] } | string[];
    const list = Array.isArray(data) ? data : data.addresses || [];
    for (const addr of list) {
      if (typeof addr === "string" && /^0x[a-fA-F0-9]{40}$/i.test(addr)) {
        set.add(normalizeAddress(addr));
      }
    }
  } catch {
    // optional
  }

  // Env comma-separated extras
  const extra = process.env.GOOD_WOOD_EXTRA?.split(",") || [];
  for (const addr of extra) {
    if (/^0x[a-fA-F0-9]{40}$/i.test(addr.trim())) {
      set.add(normalizeAddress(addr));
    }
  }

  glob.__plankGoodWood = set;
  glob.__plankGoodWoodAt = now;
  return set;
}

export async function isGoodWood(address: string): Promise<boolean> {
  const set = await loadGoodWoodSet();
  return set.has(normalizeAddress(address));
}

function touchCooldown(state: BoardsState, address: string, at: Date): void {
  const a = normalizeAddress(address);
  const existing = state.cooldowns[a];
  if (existing) return;
  const started = at.getTime();
  state.cooldowns[a] = {
    address: a,
    startedAt: new Date(started).toISOString(),
    endsAt: new Date(cooldownEndsAt(started)).toISOString(),
  };
}

/** Register official widget activity (quote or swap). */
export async function recordWidgetActivity(
  address: string,
  kind: "quote" | "swap"
): Promise<WidgetSession> {
  const state = await ensureLoaded();
  const a = normalizeAddress(address);
  const now = new Date();
  const prev = state.widgetSessions[a];
  const session: WidgetSession = prev
    ? {
        ...prev,
        lastSeenAt: now.toISOString(),
        quoteCount: prev.quoteCount + (kind === "quote" ? 1 : 0),
        swapCount: prev.swapCount + (kind === "swap" ? 1 : 0),
      }
    : {
        address: a,
        firstSeenAt: now.toISOString(),
        lastSeenAt: now.toISOString(),
        quoteCount: kind === "quote" ? 1 : 0,
        swapCount: kind === "swap" ? 1 : 0,
      };
  state.widgetSessions[a] = session;
  touchCooldown(state, a, now);
  await persist(state);
  return session;
}

export async function wasWidgetVerified(address: string): Promise<boolean> {
  const state = await ensureLoaded();
  return Boolean(state.widgetSessions[normalizeAddress(address)]);
}

/**
 * Mark a wallet Bad Boards — off-widget snipes while the official widget is locked.
 * Good Wood addresses that offend become "fallen" (still counted in bad list).
 * Optional ethSpentWeiDelta accumulates native ETH value from the sniper's txs.
 * Official widget sessions are never marked.
 */
export async function markBadBoard(opts: {
  address: string;
  reason: string;
  source: string;
  txHash?: string;
  /** Additional wei this hit (only applied once per new txHash). */
  ethSpentWeiDelta?: string | bigint;
  at?: Date;
  /**
   * `sniper` (default for chain): only while widget is locked (death trap).
   * `manual` / ops: allowed for full listing window if ever needed.
   */
  captureMode?: "sniper" | "manual";
}): Promise<BadBoardEntry | null> {
  const atMs = opts.at?.getTime() ?? Date.now();
  const mode = opts.captureMode ?? "sniper";
  // Chain sniper capture stops the moment community widget unlocks.
  if (mode === "sniper" && !isSniperCaptureActive(atMs)) {
    return null;
  }
  if (mode === "manual" && !isListingWindowActive(atMs)) {
    return null;
  }

  const state = await ensureLoaded();
  const a = normalizeAddress(opts.address);
  if (!/^0x[a-f0-9]{40}$/.test(a)) return null;

  // Manual mode only: never re-flag wallets already verified via official quote/swap.
  // Sniper mode intentionally ignores widget sessions (ping is unauthenticated).
  if (mode === "manual" && (await wasWidgetVerified(a))) {
    return null;
  }

  const at = opts.at ?? new Date();
  const good = await isGoodWood(a);
  const prev = state.badBoards[a];
  const txHashes = prev?.txHashes ? [...prev.txHashes] : [];
  const isNewTx = Boolean(opts.txHash && !txHashes.includes(opts.txHash));
  if (opts.txHash && isNewTx) {
    txHashes.push(opts.txHash);
    if (txHashes.length > 40) txHashes.shift();
  }
  const sources = prev?.sources ? [...prev.sources] : [];
  if (!sources.includes(opts.source)) sources.push(opts.source);

  let ethSpentWei = BigInt(prev?.ethSpentWei || "0");
  if (isNewTx && opts.ethSpentWeiDelta != null) {
    try {
      const delta =
        typeof opts.ethSpentWeiDelta === "bigint"
          ? opts.ethSpentWeiDelta
          : BigInt(opts.ethSpentWeiDelta || "0");
      if (delta > BigInt(0)) ethSpentWei += delta;
    } catch {
      // ignore bad delta
    }
  }

  const entry: BadBoardEntry = {
    address: a,
    firstSeenAt: prev?.firstSeenAt ?? at.toISOString(),
    lastSeenAt: at.toISOString(),
    reason: opts.reason,
    wasGoodWood: good || Boolean(prev?.wasGoodWood),
    sources,
    txHashes,
    ethSpentWei: ethSpentWei.toString(),
  };
  state.badBoards[a] = entry;
  recomputeTotalEth(state);
  touchCooldown(state, a, at);
  await persist(state);
  return entry;
}

export async function getBoardsState(): Promise<BoardsState> {
  return ensureLoaded();
}

export async function setScanCursor(block: number, notes: string[]): Promise<void> {
  const state = await ensureLoaded();
  state.lastScannedBlock = block;
  state.lastScanAt = new Date().toISOString();
  state.scanNotes = notes.slice(0, 20);
  await persist(state);
}

/** Age of last successful chain scan (uses lastScanAt — not widget ping noise). */
export async function getLastScanAgeMs(): Promise<number> {
  const state = await ensureLoaded();
  if (state.lastScannedBlock <= 0) return Number.POSITIVE_INFINITY;
  const iso = state.lastScanAt || state.updatedAt;
  if (!iso) return Number.POSITIVE_INFINITY;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return Number.POSITIVE_INFINITY;
  return Date.now() - t;
}

export async function getCooldown(address: string): Promise<{
  active: boolean;
  startedAt: string | null;
  endsAt: string | null;
  remainingMs: number;
} | null> {
  const state = await ensureLoaded();
  const a = normalizeAddress(address);
  const cd = state.cooldowns[a];
  if (!cd) {
    return { active: false, startedAt: null, endsAt: null, remainingMs: 0 };
  }
  const ends = Date.parse(cd.endsAt);
  const remainingMs = Math.max(0, ends - Date.now());
  return {
    active: remainingMs > 0 && isListingWindowActive(),
    startedAt: cd.startedAt,
    endsAt: cd.endsAt,
    remainingMs,
  };
}

export async function classifyWallet(address: string): Promise<{
  side: "good_wood" | "bad_boards" | "neutral" | "fallen";
  widgetVerified: boolean;
  cooldown: Awaited<ReturnType<typeof getCooldown>>;
  badEntry: BadBoardEntry | null;
}> {
  const a = normalizeAddress(address);
  const state = await ensureLoaded();
  const good = await isGoodWood(a);
  const bad = state.badBoards[a] || null;
  const widgetVerified = Boolean(state.widgetSessions[a]);
  const cooldown = await getCooldown(a);

  let side: "good_wood" | "bad_boards" | "neutral" | "fallen" = "neutral";
  if (bad && bad.wasGoodWood) side = "fallen";
  else if (bad) side = "bad_boards";
  else if (good) side = "good_wood";

  return { side, widgetVerified, cooldown, badEntry: bad };
}

export async function publicBoardsSnapshot(): Promise<{
  state: BoardsState;
  goodWoodCount: number;
  recentBad: BadBoardEntry[];
  fallenCount: number;
  /** Sample of Good Wood addresses for the wooden ledger (nice column). */
  niceLedger: string[];
  totalEthSpentWei: string;
}> {
  const state = await ensureLoaded();
  recomputeTotalEth(state);
  const good = await loadGoodWoodSet();
  const badList = Object.values(state.badBoards).sort(
    (a, b) => Date.parse(b.lastSeenAt) - Date.parse(a.lastSeenAt)
  );
  const fallenCount = badList.filter((b) => b.wasGoodWood).length;

  // Nice column: widget-verified first (live), then Good Wood samples for ledger density
  const niceSet: string[] = [];
  const widgetAddrs = Object.keys(state.widgetSessions).sort(
    (a, b) =>
      Date.parse(state.widgetSessions[b].lastSeenAt) -
      Date.parse(state.widgetSessions[a].lastSeenAt)
  );
  for (const a of widgetAddrs) {
    if (!state.badBoards[a]) niceSet.push(a);
    if (niceSet.length >= 48) break;
  }
  if (niceSet.length < 48) {
    for (const a of good) {
      if (state.badBoards[a]) continue;
      if (niceSet.includes(a)) continue;
      niceSet.push(a);
      if (niceSet.length >= 48) break;
    }
  }

  return {
    state,
    goodWoodCount: good.size,
    recentBad: badList.slice(0, 100),
    fallenCount,
    niceLedger: niceSet,
    totalEthSpentWei: state.totalEthSpentWei || "0",
  };
}

/** Enrich bad entries + volume tick with live ETH/USD. */
export async function withVolumeDecorators(snap: {
  recentBad: BadBoardEntry[];
  totalEthSpentWei: string;
  fallenCount: number;
  state: BoardsState;
}): Promise<{
  recentBad: BadBoardEntry[];
  volume: import("@/lib/boards-types").BoardsVolumeTick;
}> {
  const { formatEth3, formatUsd, getEthUsdPrice, weiToUsd } = await import("@/lib/eth-price");
  const price = await getEthUsdPrice();
  const totalWei = snap.totalEthSpentWei || "0";
  const totalUsd = weiToUsd(totalWei, price.usd);

  const recentBad = snap.recentBad.map((b) => {
    const wei = b.ethSpentWei || "0";
    const usd = weiToUsd(wei, price.usd);
    return {
      ...b,
      ethSpentWei: wei,
      ethSpent: formatEth3(wei),
      ethSpentUsd: usd,
      ethSpentUsdLabel: formatUsd(usd),
    };
  });

  return {
    recentBad,
    volume: {
      serverNow: new Date().toISOString(),
      ethUsd: price.usd,
      ethUsdSource: price.source,
      totalEthSpent: formatEth3(totalWei),
      totalEthSpentWei: totalWei,
      totalUsd,
      totalUsdLabel: formatUsd(totalUsd),
      badBoards: Object.keys(snap.state.badBoards).length,
      fallen: snap.fallenCount,
    },
  };
}

export { WALLET_COOLDOWN_MS };
