import {
  getTrapWindow,
  isListingWindowActive,
  isOfficialWidgetOpen,
  isOffWidgetCaptureActive,
  isSniperCaptureActive,
  SNIPER_TRAP_MINUTES,
  WALLET_COOLDOWN_MINUTES,
} from "@/lib/boards";
import {
  getLastScanAgeMs,
  publicBoardsSnapshot,
  withVolumeDecorators,
} from "@/lib/boards-store";
import { scanPlankTransfers } from "@/lib/boards-scanner";
import { publicError, publicJson, rateLimit } from "@/lib/security";
import type { BoardsPublicView } from "@/lib/boards-types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Re-scan chain if listing is active and last scan is older than this. */
const AUTO_SCAN_EVERY_MS = 12_000;

export async function GET(req: Request) {
  try {
    const limited = rateLimit(req, { key: "boards", limit: 90, windowMs: 60_000 });
    if (limited) return limited;

    // Live path: auto-scan during death trap + cooldown (off-widget capture)
    let autoScan: { ran: boolean; newBad?: number; notes?: string[] } = { ran: false };
    if (isOffWidgetCaptureActive()) {
      const age = await getLastScanAgeMs();
      if (age >= AUTO_SCAN_EVERY_MS) {
        try {
          const result = await scanPlankTransfers({ maxBlocks: 2_000 });
          autoScan = { ran: true, newBad: result.newBad, notes: result.notes };
        } catch (e) {
          autoScan = {
            ran: false,
            notes: [e instanceof Error ? e.message : "auto-scan failed"],
          };
        }
      }
    }

    const trap = getTrapWindow();
    const snap = await publicBoardsSnapshot();
    const decorated = await withVolumeDecorators(snap);

    const view: BoardsPublicView = {
      trap: {
        active: isListingWindowActive(),
        phase: trap.phase,
        trapStartsAt: trap.trapStartsAt.toISOString(),
        tradeOpensAt: trap.tradeOpensAt.toISOString(),
        cooldownsEndAt: trap.cooldownsEndAt.toISOString(),
        sniperTrapMinutes: SNIPER_TRAP_MINUTES,
        walletCooldownMinutes: WALLET_COOLDOWN_MINUTES,
        serverNow: trap.now.toISOString(),
      },
      counts: {
        goodWood: snap.goodWoodCount,
        badBoards: Object.keys(snap.state.badBoards).length,
        widgetVerified: Object.keys(snap.state.widgetSessions).length,
        fallen: snap.fallenCount,
      },
      recentBadBoards: decorated.recentBad,
      volume: decorated.volume,
      legend: {
        goodWood:
          "Wood List (mint) + live plank.love widget buyers. Labeled so you can tell them apart.",
        badBoards:
          "Off-site / Uniswap UI (or bots) — never the official plank.love widget. Death trap = widget locked; Off-site = post-open without a widget session.",
        fallen:
          "Were Good Wood (mint/airdrop) then bought off-site during the trap — now Bad Boards.",
        cooldown: `Each wallet that touches $PLANK starts a ${WALLET_COOLDOWN_MINUTES}-minute cooldown so ops can list snipers before free trade.`,
        plankLove:
          "Bought or quoted through the official plank.love Trade widget (server session).",
        offSite:
          "Chain activity without a plank.love widget session — Uniswap app or other frontend.",
      },
    };

    return publicJson({
      ...view,
      niceLedger: snap.niceLedger,
      niceLedgerAddresses: snap.niceLedgerAddresses,
      naughtyLedger: decorated.recentBad,
      export: {
        blacklistCsv: "/api/boards/export?format=csv",
        addressesOnly: "/api/boards/export?format=addresses",
      },
      live: {
        autoScanEveryMs: AUTO_SCAN_EVERY_MS,
        listingActive: isListingWindowActive(),
        sniperCapture: isSniperCaptureActive(),
        offWidgetCapture: isOffWidgetCaptureActive(),
        widgetOpen: isOfficialWidgetOpen(),
        lastAutoScan: autoScan,
        stream: "/api/boards/stream",
      },
      scan: {
        lastScannedBlock: snap.state.lastScannedBlock,
        lastScanAt: snap.state.lastScanAt ?? null,
        notes: snap.state.scanNotes,
        updatedAt: snap.state.updatedAt,
      },
    });
  } catch (err) {
    return publicError(err, "Failed to load boards.");
  }
}
