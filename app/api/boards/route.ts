import {
  getTrapWindow,
  isListingWindowActive,
  SNIPER_TRAP_MINUTES,
  WALLET_COOLDOWN_MINUTES,
} from "@/lib/boards";
import { getLastScanAgeMs, publicBoardsSnapshot } from "@/lib/boards-store";
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

    // Live path: auto-scan while death trap / cooldown window is open
    let autoScan: { ran: boolean; newBad?: number; notes?: string[] } = { ran: false };
    if (isListingWindowActive()) {
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
      recentBadBoards: snap.recentBad,
      legend: {
        goodWood:
          "Mint Wood List + airdrop wallets. Community that waited and held the real list.",
        badBoards:
          "Wallets that moved $PLANK outside the official plank.love widget during the death trap / 30m cooldown window.",
        fallen:
          "Were Good Wood (mint/airdrop) then got cute off-site during the trap — now Bad Boards.",
        cooldown: `Each wallet that touches $PLANK starts a ${WALLET_COOLDOWN_MINUTES}-minute cooldown so ops can list snipers before free trade.`,
      },
    };

    return publicJson({
      ...view,
      niceLedger: snap.niceLedger,
      naughtyLedger: snap.recentBad,
      live: {
        autoScanEveryMs: AUTO_SCAN_EVERY_MS,
        listingActive: isListingWindowActive(),
        lastAutoScan: autoScan,
      },
      scan: {
        lastScannedBlock: snap.state.lastScannedBlock,
        notes: snap.state.scanNotes,
        updatedAt: snap.state.updatedAt,
      },
    });
  } catch (err) {
    return publicError(err, "Failed to load boards.");
  }
}
