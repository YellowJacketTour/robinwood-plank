"use client";

import { useCallback, useEffect, useState } from "react";
import { SkeletonRows, SkeletonStats, SkeletonStatus } from "@/components/Skeleton";
import { ExplorerAddress } from "../ExplorerAddress";
import { BUTTON_PRIMARY, BUTTON_SECONDARY, CARD, LABEL, NOTE_ERR, NOTE_OK } from "../ui";
import { adminMessage, adminPayloadHash } from "@/lib/admin-auth";
import { signMessage } from "@/lib/wallet";

const BACKFILL_ACTION = "backfill-events";

/**
 * System section — the expanded operational picture: durable storage, chain
 * RPC, the drand relayer cron (tail of its structured status log), WoodAmp
 * store counts, and the admin action log. All read-only, from
 * /api/admin/status, plus one mutation: manually fast-forwarding the
 * permanent chain-event ledger's backfill (see
 * app/api/admin/backfill-events/route.ts) instead of waiting on however many
 * 2-minute cron ticks a cold ~9.5M-block walk takes.
 */

type Status = {
  serverNow: string;
  version: string;
  storage: { backend: string | null; ok: boolean };
  chain: { ok: boolean; blockNumber?: number; error?: string };
  relayer:
    | { state: "unconfigured" }
    | { state: "unreadable"; error: string }
    | {
        state: "ok" | "stale" | "fatal";
        lastRun: string | null;
        ageMinutes: number | null;
        vaults: { vault: string; state: string; actionable?: boolean; detail?: string }[];
        lastFatal: { timestamp: string | null; detail: string } | null;
      };
  playlist: { ok: boolean; count: number };
  uploads: { count: number; bytes: number };
  log: { at: string; address: string; action: string; summary: string }[];
};

function Dot({ ok }: { ok: boolean | null }) {
  return (
    <span
      aria-hidden="true"
      className={`inline-block h-2 w-2 rounded-full ${
        ok === null ? "bg-cream-muted/40" : ok ? "bg-emerald-400" : "bg-rose-400"
      }`}
    />
  );
}

type BackfillState =
  | { kind: "idle" }
  | { kind: "signing" }
  | { kind: "running" }
  | { kind: "ok"; message: string }
  | { kind: "error"; message: string };

export default function SystemSection({ address }: { address: string | null }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [failed, setFailed] = useState(false);
  const [backfill, setBackfill] = useState<BackfillState>({ kind: "idle" });

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/status", { cache: "no-store" });
      if (!res.ok) throw new Error();
      setStatus((await res.json()) as Status);
      setFailed(false);
    } catch {
      setStatus(null);
      setFailed(true);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const runBackfill = useCallback(async () => {
    if (!address) return;
    try {
      setBackfill({ kind: "signing" });
      const timestamp = Date.now();
      const signature = await signMessage(
        address,
        adminMessage(BACKFILL_ACTION, timestamp, adminPayloadHash("{}"))
      );
      setBackfill({ kind: "running" });
      const res = await fetch("/api/admin/backfill-events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ auth: { address, timestamp, signature } }),
      });
      const data = (await res.json()) as {
        ok?: boolean;
        message?: string;
        passes?: number;
        rowsInserted?: number;
        caughtUp?: boolean;
        head?: number | null;
        confirmedHead?: number | null;
        note?: string;
      };
      if (!res.ok || !data.ok) {
        setBackfill({ kind: "error", message: data.message || "The backfill pass failed." });
        return;
      }
      setBackfill({
        kind: "ok",
        message: `${data.passes} pass(es), +${data.rowsInserted} rows, confirmed=${data.confirmedHead}/${data.head}. ${data.note}`,
      });
    } catch (err) {
      setBackfill({
        kind: "error",
        message: err instanceof Error ? err.message : "The backfill pass failed.",
      });
    }
  }, [address]);

  const relayer = status?.relayer;

  return (
    <>
      <section className={CARD}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="font-display text-xl text-gold-300">System</h2>
            <p className={`mt-1 ${LABEL}`}>Deployment, storage, chain, cron</p>
          </div>
          <button type="button" className={BUTTON_SECONDARY} onClick={() => void load()}>
            Re-check
          </button>
        </div>

        <div className="mt-4 rounded-md bg-panel-strong p-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className={LABEL}>Chain event ledger</p>
              <p className="mt-1 text-sm text-cream-muted">
                The permanent Activity/sales ledger backfills on its own every cron
                tick — this fast-forwards it by running several passes right now
                instead of waiting. Safe to click repeatedly; each pass is
                idempotent.
              </p>
            </div>
            <button
              type="button"
              className={BUTTON_PRIMARY}
              disabled={!address || backfill.kind === "signing" || backfill.kind === "running"}
              onClick={() => void runBackfill()}
            >
              {backfill.kind === "signing"
                ? "Sign to confirm…"
                : backfill.kind === "running"
                  ? "Backfilling…"
                  : "Backfill now"}
            </button>
          </div>
          {backfill.kind === "ok" ? (
            <p className={`mt-2 ${NOTE_OK}`}>{backfill.message}</p>
          ) : backfill.kind === "error" ? (
            <p className={`mt-2 ${NOTE_ERR}`}>{backfill.message}</p>
          ) : null}
        </div>

        {failed ? (
          <p className="mt-4 text-sm text-rose-400">Status endpoint unreachable.</p>
        ) : status === null ? (
          <div className="mt-4">
            <SkeletonStatus>Checking deployment, storage, and chain status</SkeletonStatus>
            <SkeletonStats count={6} columns="sm:grid-cols-2 lg:grid-cols-3" />
          </div>
        ) : (
          <dl className="mt-4 grid gap-2 rounded-md bg-panel-strong p-3 text-sm sm:grid-cols-2 lg:grid-cols-3">
            <div>
              <dt className={LABEL}>Database</dt>
              <dd className="mt-1 flex items-center gap-2 text-cream">
                <Dot ok={status.storage.ok} />
                {status.storage.backend ?? "none configured"}
              </dd>
            </div>
            <div>
              <dt className={LABEL}>Chain RPC</dt>
              <dd className="mt-1 flex items-center gap-2 text-cream">
                <Dot ok={status.chain.ok} />
                {status.chain.ok
                  ? `block ${status.chain.blockNumber?.toLocaleString()}`
                  : (status.chain.error ?? "unreachable")}
              </dd>
            </div>
            <div>
              <dt className={LABEL}>Deployed version</dt>
              <dd className="mt-1 break-all font-mono text-xs text-cream">
                {status.version === "unknown"
                  ? "dev server (no release SHA)"
                  : status.version}
              </dd>
            </div>
            <div>
              <dt className={LABEL}>Relayer cron</dt>
              <dd className="mt-1 flex items-center gap-2 text-cream">
                {relayer?.state === "unconfigured" ? (
                  <>
                    <Dot ok={null} />
                    <span className="text-cream-muted">
                      no log here (dev) — production reads RELAYER_LOG_PATH
                    </span>
                  </>
                ) : relayer?.state === "unreadable" ? (
                  <>
                    <Dot ok={false} /> log unreadable
                  </>
                ) : relayer ? (
                  <>
                    <Dot ok={relayer.state === "ok"} />
                    {/* "FATAL logged" with no timing read as an emergency even
                        when the failure was days old and every run since had
                        succeeded. The state now only goes fatal when nothing
                        has run since the error, so say that plainly and give
                        the age — a reader needs to know whether to act now. */}
                    {relayer.state === "fatal"
                      ? relayer.ageMinutes === null
                        ? "failing — no successful run logged"
                        : `failing since last run (${relayer.ageMinutes} min ago)`
                      : relayer.ageMinutes === null
                        ? "no runs found"
                        : `last run ${relayer.ageMinutes} min ago`}
                  </>
                ) : null}
              </dd>
            </div>
            <div>
              <dt className={LABEL}>Planklist</dt>
              <dd className="mt-1 text-cream">
                {status.playlist.count} track
                {status.playlist.count === 1 ? "" : "s"}
              </dd>
            </div>
            <div>
              <dt className={LABEL}>Uploads</dt>
              <dd className="mt-1 text-cream">
                {status.uploads.count} file{status.uploads.count === 1 ? "" : "s"} ·{" "}
                {Math.round(status.uploads.bytes / 1024).toLocaleString()} KB
              </dd>
            </div>
          </dl>
        )}

        {relayer && relayer.state === "fatal" && relayer.lastFatal ? (
          <p className="mt-3 rounded-md border border-rose-400/30 bg-panel-strong px-3 py-2 text-xs text-rose-400">
            {relayer.lastFatal.detail}
            {relayer.lastFatal.timestamp
              ? ` — ${new Date(relayer.lastFatal.timestamp).toLocaleString()}`
              : null}
          </p>
        ) : null}

        {relayer && (relayer.state === "ok" || relayer.state === "stale" || relayer.state === "fatal") && relayer.vaults.length > 0 ? (
          <ul className="mt-3 grid gap-1 sm:grid-cols-2">
            {relayer.vaults.map((v) => (
              <li
                key={v.vault}
                className="flex items-center gap-2 rounded-md bg-panel-strong px-3 py-2 text-xs"
              >
                <Dot ok={v.state !== "error" && !v.actionable} />
                <span className="truncate text-cream-muted">
                  <ExplorerAddress address={v.vault} short />
                </span>
                <span className="ml-auto uppercase tracking-wide text-cream">
                  {v.state}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
      </section>

      <section className={CARD}>
        <h2 className="font-display text-xl text-gold-300">Action log</h2>
        <p className={`mt-1 ${LABEL}`}>Every signed admin save, newest first</p>
        {status === null ? (
          failed ? (
            <p className="mt-4 text-sm text-cream-muted">Unavailable.</p>
          ) : (
            <div className="mt-4 overflow-hidden rounded-md border border-line bg-panel-strong">
              <SkeletonStatus>Loading the admin action log</SkeletonStatus>
              <SkeletonRows rows={5} columns={["w-28", "w-20", "w-40", "w-16"]} />
            </div>
          )
        ) : status.log.length === 0 ? (
          <p className="mt-4 text-sm text-cream-muted">No admin actions yet.</p>
        ) : (
          <ul className="mt-4 divide-y divide-gold-500/10 rounded-md border border-line bg-panel-strong text-sm">
            {status.log.map((entry, i) => (
              <li key={i} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-3 py-2">
                <span className="tabular-nums text-xs text-cream-muted">
                  {new Date(entry.at).toLocaleString()}
                </span>
                <span className="text-xs text-gold-300">
                  <ExplorerAddress address={entry.address} short />
                </span>
                <span className="text-cream">{entry.summary}</span>
                <span className={`ml-auto ${LABEL}`}>{entry.action}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
