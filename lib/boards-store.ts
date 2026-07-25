import { promises as fs } from "node:fs";
import path from "node:path";
import {
  cooldownEndsAt,
  isListingWindowActive,
  isOffWidgetCaptureActive,
  isSniperCaptureActive,
  normalizeAddress,
  WALLET_COOLDOWN_MS,
} from "@/lib/boards";
import type {
  BadBoardEntry,
  BadVenue,
  BoardsState,
  NiceLedgerEntry,
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

export function venueLabelFor(venue: BadVenue): string {
  if (venue === "death_trap") return "Death trap · Uniswap / external";
  return "Off-site · not plank.love";
}

/**
 * Mark a wallet Bad Boards — off-widget / Uniswap-UI path (never plank.love).
 * Good Wood offenders become "fallen".
 * Official widget sessions (server quote/swap) are never marked in off_widget mode.
 */
export async function markBadBoard(opts: {
  address: string;
  reason: string;
  source: string;
  txHash?: string;
  ethSpentWeiDelta?: string | bigint;
  at?: Date;
  venue?: BadVenue;
  /**
   * sniper     — death trap only (widget locked; all chain = off-site)
   * off_widget — death trap or cooldown; skips plank.love widget sessions
   * manual     — ops / full listing window
   */
  captureMode?: "sniper" | "off_widget" | "manual";
}): Promise<BadBoardEntry | null> {
  const atMs = opts.at?.getTime() ?? Date.now();
  const mode = opts.captureMode ?? "sniper";

  if (mode === "sniper" && !isSniperCaptureActive(atMs)) {
    return null;
  }
  if (mode === "off_widget" && !isOffWidgetCaptureActive(atMs)) {
    return null;
  }
  if (mode === "manual" && !isListingWindowActive(atMs)) {
    return null;
  }

  const state = await ensureLoaded();
  const a = normalizeAddress(opts.address);
  if (!/^0x[a-f0-9]{40}$/.test(a)) return null;

  // plank.love widget buyers (server quote/swap session) never go on Bad Boards
  // once the widget is open. During pure death trap, widget cannot buy anyway.
  if (mode === "off_widget" || mode === "manual") {
    if (await wasWidgetVerified(a)) {
      return null;
    }
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

  const venue: BadVenue =
    opts.venue ||
    prev?.venue ||
    (isSniperCaptureActive(atMs) ? "death_trap" : "off_site");

  const entry: BadBoardEntry = {
    address: a,
    firstSeenAt: prev?.firstSeenAt ?? at.toISOString(),
    lastSeenAt: at.toISOString(),
    reason: opts.reason,
    wasGoodWood: good || Boolean(prev?.wasGoodWood),
    sources,
    txHashes,
    ethSpentWei: ethSpentWei.toString(),
    venue,
    venueLabel: venueLabelFor(venue),
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
  /** Sample of Good Wood with plank.love vs wood_list labels */
  niceLedger: NiceLedgerEntry[];
  /** Flat addresses for legacy consumers */
  niceLedgerAddresses: string[];
  totalEthSpentWei: string;
}> {
  const state = await ensureLoaded();
  recomputeTotalEth(state);
  const good = await loadGoodWoodSet();
  const badList = Object.values(state.badBoards)
    .map((b) => ({
      ...b,
      venue: b.venue || ("death_trap" as BadVenue),
      venueLabel: b.venueLabel || venueLabelFor(b.venue || "death_trap"),
    }))
    .sort((a, b) => Date.parse(b.lastSeenAt) - Date.parse(a.lastSeenAt));
  const fallenCount = badList.filter((b) => b.wasGoodWood).length;

  // Nice column: plank.love widget first, then Wood List
  const niceLedger: NiceLedgerEntry[] = [];
  const seen = new Set<string>();
  const widgetAddrs = Object.keys(state.widgetSessions).sort(
    (a, b) =>
      Date.parse(state.widgetSessions[b].lastSeenAt) -
      Date.parse(state.widgetSessions[a].lastSeenAt)
  );
  for (const a of widgetAddrs) {
    if (state.badBoards[a]) continue;
    niceLedger.push({ address: a, label: "plank.love" });
    seen.add(a);
    if (niceLedger.length >= 48) break;
  }
  if (niceLedger.length < 48) {
    for (const a of good) {
      if (state.badBoards[a] || seen.has(a)) continue;
      niceLedger.push({ address: a, label: "wood_list" });
      seen.add(a);
      if (niceLedger.length >= 48) break;
    }
  }

  return {
    state,
    goodWoodCount: good.size,
    recentBad: badList.slice(0, 200),
    fallenCount,
    niceLedger,
    niceLedgerAddresses: niceLedger.map((n) => n.address),
    totalEthSpentWei: state.totalEthSpentWei || "0",
  };
}

/** All bad board rows for CSV export (full set). */
export async function listAllBadBoards(): Promise<BadBoardEntry[]> {
  const state = await ensureLoaded();
  return Object.values(state.badBoards)
    .map((b) => ({
      ...b,
      venue: b.venue || ("death_trap" as BadVenue),
      venueLabel: b.venueLabel || venueLabelFor(b.venue || "death_trap"),
    }))
    .sort((a, b) => Date.parse(b.lastSeenAt) - Date.parse(a.lastSeenAt));
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
