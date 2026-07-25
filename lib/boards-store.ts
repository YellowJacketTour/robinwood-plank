import { promises as fs } from "node:fs";
import path from "node:path";
import {
  cooldownEndsAt,
  isListingWindowActive,
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
    scanNotes: [],
  };
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
    glob.__plankBoardsState = {
      ...emptyState(),
      ...parsed,
      widgetSessions: parsed.widgetSessions || {},
      badBoards: parsed.badBoards || {},
      cooldowns: parsed.cooldowns || {},
      scanNotes: parsed.scanNotes || [],
    };
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
 * Mark a wallet Bad Boards — off-widget / funny business during listing window.
 * Good Wood addresses that offend become "fallen" (still counted in bad list).
 */
export async function markBadBoard(opts: {
  address: string;
  reason: string;
  source: string;
  txHash?: string;
  at?: Date;
}): Promise<BadBoardEntry | null> {
  if (!isListingWindowActive(opts.at?.getTime() ?? Date.now())) {
    return null;
  }

  const state = await ensureLoaded();
  const a = normalizeAddress(opts.address);
  if (!/^0x[a-f0-9]{40}$/.test(a)) return null;

  // Official widget users are not auto-bad from chain noise if they only used us —
  // but explicit off-widget reason still applies if they also sniped elsewhere.
  const at = opts.at ?? new Date();
  const good = await isGoodWood(a);
  const prev = state.badBoards[a];
  const txHashes = prev?.txHashes ? [...prev.txHashes] : [];
  if (opts.txHash && !txHashes.includes(opts.txHash)) {
    txHashes.push(opts.txHash);
    if (txHashes.length > 20) txHashes.shift();
  }
  const sources = prev?.sources ? [...prev.sources] : [];
  if (!sources.includes(opts.source)) sources.push(opts.source);

  const entry: BadBoardEntry = {
    address: a,
    firstSeenAt: prev?.firstSeenAt ?? at.toISOString(),
    lastSeenAt: at.toISOString(),
    reason: opts.reason,
    wasGoodWood: good || Boolean(prev?.wasGoodWood),
    sources,
    txHashes,
  };
  state.badBoards[a] = entry;
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
  state.scanNotes = notes.slice(0, 20);
  await persist(state);
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
}> {
  const state = await ensureLoaded();
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
  };
}

export { WALLET_COOLDOWN_MS };
