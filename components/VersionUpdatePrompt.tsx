"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { RefreshCw } from "lucide-react";
import {
  DISMISSED_KEY,
  INITIAL_CHECK_DELAY_MS,
  POLL_INTERVAL_MS,
  REFRESH_GUARD_KEY,
  isNewerBuild,
  manifestMarkers,
  shouldSuppressVersionPrompt,
  writeRecord,
  type VersionManifest,
} from "@/lib/version-update";

/**
 * Tells someone on a stale build that a new one shipped.
 *
 * A deploy swaps the bundle under anyone already browsing. Next's
 * `deploymentId` makes a skewed client fail its chunk loads rather than run
 * half-old code — so the failure is safe, but silent: the page just stops
 * working. This closes that gap by asking, once per build, whether to reload.
 *
 * All the rules live in lib/version-update.ts so they are testable without a
 * browser. This component only owns timers, fetch and presentation.
 *
 * INERT WITHOUT A MARKER. `currentBuild` comes from DEPLOYMENT_VERSION, which
 * is unset locally — so in dev this mounts, checks nothing, and renders
 * nothing.
 */
export default function VersionUpdatePrompt({ currentBuild }: { currentBuild: string | null }) {
  const [pendingMarker, setPendingMarker] = useState<string | null>(null);
  const inFlight = useRef<AbortController | null>(null);

  // Abort an in-flight poll on unmount. No mounted flag is needed to make the
  // portal SSR-safe: pendingMarker can only become non-null inside an async
  // fetch callback, which never runs on the server, so the server render
  // always returns null before reaching createPortal.
  useEffect(() => () => inFlight.current?.abort(), []);

  const check = useCallback(async () => {
    if (!currentBuild) return;

    // One request at a time. A slow poll must never stack behind the next
    // interval tick and turn a 5-minute cadence into a pile-up.
    inFlight.current?.abort();
    const controller = new AbortController();
    inFlight.current = controller;

    let manifest: VersionManifest | null = null;
    try {
      // Cache-buster as well as the route's no-store headers: LiteSpeed sits
      // in front of Passenger on this host and may cache regardless. A cached
      // version endpoint can never report a new version, which would make
      // this feature fail silently and permanently.
      const res = await fetch(`/version.json?v=${Date.now()}`, {
        cache: "no-store",
        signal: controller.signal,
      });
      if (!res.ok) return;
      manifest = (await res.json()) as VersionManifest;
    } catch {
      // Offline, aborted, or malformed. Stay quiet — see isNewerBuild's note
      // on why silence is the correct failure here.
      return;
    }

    if (!isNewerBuild(currentBuild, manifest)) return;
    const marker = manifestMarkers(manifest)[0];
    if (!marker) return;

    if (
      shouldSuppressVersionPrompt(marker, {
        local: typeof window === "undefined" ? null : window.localStorage,
        session: typeof window === "undefined" ? null : window.sessionStorage,
      })
    ) {
      return;
    }

    setPendingMarker(marker);
  }, [currentBuild]);

  useEffect(() => {
    if (!currentBuild) return;
    // Delayed first check: a page that just loaded is already running the
    // newest build, and checking instantly only risks racing its own marker.
    const first = window.setTimeout(() => void check(), INITIAL_CHECK_DELAY_MS);
    const interval = window.setInterval(() => void check(), POLL_INTERVAL_MS);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(interval);
    };
  }, [check, currentBuild]);

  const dismiss = useCallback(() => {
    if (pendingMarker) {
      // Permanent for THIS build. No timed re-nag: someone who declined has
      // answered. The next release has a different marker and asks again.
      writeRecord(window.localStorage, DISMISSED_KEY, pendingMarker);
    }
    setPendingMarker(null);
  }, [pendingMarker]);

  const refresh = useCallback(() => {
    if (pendingMarker) {
      // Guard BEFORE reloading: a Passenger restart can briefly serve the old
      // process, so the reload can land back on the old bundle. Without this
      // the user is in a prompt loop they cannot escape by complying.
      writeRecord(window.sessionStorage, REFRESH_GUARD_KEY, pendingMarker);
    }
    window.location.reload();
  }, [pendingMarker]);

  useEffect(() => {
    if (!pendingMarker) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") dismiss();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pendingMarker, dismiss]);

  if (!pendingMarker) return null;

  // Portals to body like every other modal here: the homepage's reveal
  // sections carry transforms, and an ancestor transform makes position:fixed
  // resolve against that ancestor instead of the viewport.
  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-end justify-center bg-black/70 p-4 sm:items-center"
      role="dialog"
      aria-modal="true"
      aria-labelledby="version-update-title"
    >
      <div className="w-full max-w-md rounded-2xl border border-gold-500/40 bg-panel-strong p-5 shadow-2xl">
        <p className="text-[0.65rem] font-extrabold uppercase tracking-[0.16em] text-gold-400/80">
          RobinWood
        </p>
        <h2 id="version-update-title" className="mt-1 font-display text-xl text-gold-300">
          New version available
        </h2>
        <p className="mt-2 text-sm leading-snug text-cream-muted">
          A newer build of plank.love is live. Refreshing loads it — anything you have typed on
          this page will be lost.
        </p>

        {/* Focus lands on "Not now", not on "Refresh now". A dialog should
            move focus into itself, but the primary action here reloads the
            page and this modal's own copy warns that costs whatever you have
            typed — so a stray Enter must not be able to trigger it. The safe
            choice takes the focus; the destructive one has to be chosen. */}
        <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row">
          <button
            type="button"
            onClick={dismiss}
            autoFocus
            className="min-h-11 flex-1 rounded-md border border-line-strong text-sm font-bold text-cream-muted transition hover:border-gold-400 hover:text-cream"
          >
            Not now
          </button>
          <button
            type="button"
            onClick={refresh}
            className="flex min-h-11 flex-1 items-center justify-center gap-2 rounded-md bg-gold-500 text-sm font-bold text-on-gold transition hover:bg-gold-400"
          >
            <RefreshCw className="h-4 w-4 shrink-0" aria-hidden="true" />
            Refresh now
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
