import { promises as fs } from "node:fs";
import { getAdminLog } from "@/lib/admin-log";
import { durableKvBackend, durableKv } from "@/lib/market/durable-kv";
import { ethBlockNumber } from "@/lib/market/fetch-rpc";
import { publicError, publicJson, rateLimit } from "@/lib/security";
import { listUploads } from "@/lib/uploads";
import { getPlaylist } from "@/lib/woodamp-playlist-store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Aggregated operational status for /admin's System section. Everything here
 * is either public already (chain head, playlist) or operational metadata
 * with no secrets (backend kind, relayer run states, admin action log —
 * admin addresses are the public treasury wallets).
 *
 * Relayer: the cPanel cron appends the relayer's stdout to a log file
 * (see docs/INMOTION_DEPLOYMENT.md). Point RELAYER_LOG_PATH at it and this
 * route tail-reads the last RELAYER_STATUS / RELAYER_FATAL lines. Unset (dev,
 * Cloudflare) reports "unconfigured" rather than failing.
 */

type RelayerVault = {
  vault: string;
  state: string;
  actionable?: boolean;
  detail?: string;
};

type RelayerStatus =
  | { state: "unconfigured" }
  | { state: "unreadable"; error: string }
  | {
      state: "ok" | "stale" | "fatal";
      lastRun: string | null;
      ageMinutes: number | null;
      vaults: RelayerVault[];
      lastFatal: string | null;
    };

/** Tail-read the log (bounded) and parse the newest status/fatal markers. */
async function readRelayerStatus(): Promise<RelayerStatus> {
  const logPath = process.env.RELAYER_LOG_PATH?.trim();
  if (!logPath) return { state: "unconfigured" };
  const TAIL_BYTES = 256 * 1024;
  let text: string;
  try {
    const handle = await fs.open(logPath, "r");
    try {
      const { size } = await handle.stat();
      const start = Math.max(0, size - TAIL_BYTES);
      const buffer = Buffer.alloc(size - start);
      await handle.read(buffer, 0, buffer.length, start);
      text = buffer.toString("utf8");
    } finally {
      await handle.close();
    }
  } catch (err) {
    return {
      state: "unreadable",
      error: err instanceof Error ? err.message : "read failed",
    };
  }

  let lastStatus: { timestamp?: string; vaults?: RelayerVault[] } | null = null;
  let lastFatal: string | null = null;
  for (const line of text.split("\n")) {
    const statusIdx = line.indexOf("RELAYER_STATUS=");
    if (statusIdx >= 0) {
      try {
        lastStatus = JSON.parse(line.slice(statusIdx + "RELAYER_STATUS=".length));
      } catch {
        // Partial first line of the tail window — skip.
      }
    }
    const fatalIdx = line.indexOf("RELAYER_FATAL=");
    if (fatalIdx >= 0) {
      lastFatal = line.slice(fatalIdx + "RELAYER_FATAL=".length).slice(0, 500);
    }
  }

  const lastRun = lastStatus?.timestamp ?? null;
  const ageMinutes = lastRun
    ? Math.round((Date.now() - new Date(lastRun).getTime()) / 60_000)
    : null;
  const state = lastFatal
    ? "fatal"
    : ageMinutes === null || ageMinutes > 10
      ? "stale"
      : "ok";
  return {
    state,
    lastRun,
    ageMinutes,
    vaults: lastStatus?.vaults ?? [],
    lastFatal,
  };
}

export async function GET(req: Request) {
  const limited = rateLimit(req, {
    key: "admin-status",
    limit: 60,
    windowMs: 60_000,
  });
  if (limited) return limited;
  try {
    const [storage, chain, relayer, playlist, uploads, log] = await Promise.all([
      (async () => {
        const backend = durableKvBackend();
        if (!backend) return { backend: null, ok: false };
        try {
          await durableKv.get("plank:health:read-probe");
          return { backend, ok: true };
        } catch {
          return { backend, ok: false };
        }
      })(),
      (async () => {
        try {
          return { ok: true, blockNumber: await ethBlockNumber() };
        } catch (err) {
          return {
            ok: false,
            error: err instanceof Error ? err.message.slice(0, 200) : "RPC failed",
          };
        }
      })(),
      readRelayerStatus(),
      getPlaylist().then(
        (tracks) => ({ ok: true, count: tracks.length }),
        () => ({ ok: false, count: 0 })
      ),
      listUploads().then(
        (files) => ({
          count: files.length,
          bytes: files.reduce((sum, f) => sum + f.bytes, 0),
        }),
        () => ({ count: 0, bytes: 0 })
      ),
      getAdminLog(30),
    ]);

    return publicJson({
      serverNow: new Date().toISOString(),
      version: process.env.DEPLOYMENT_VERSION || "unknown",
      storage,
      chain,
      relayer,
      playlist,
      uploads,
      log,
    });
  } catch (err) {
    return publicError(err, "Could not aggregate status.");
  }
}
