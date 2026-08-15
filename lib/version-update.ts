/**
 * "A new version is ready — refresh" detection.
 *
 * A deploy replaces the bundle under anyone already on the site. Next's
 * `deploymentId` (next.config.ts) makes a skewed client fail its chunk
 * fetches rather than run half-old code, which prevents corruption — but it
 * does nothing to TELL the person, so they see a page that mysteriously stops
 * working. This module is the telling half.
 *
 * All logic lives here, pure and dependency-free, so the rules are testable
 * without a browser: the component around it only wires timers and state.
 *
 * DELIBERATELY NOT A SERVICE WORKER. plank.love registers one already
 * (components/ArtServiceWorker.tsx) but it is scoped to caching art, and
 * hanging version detection off it would couple two unrelated concerns and
 * make a bad art-cache release able to break update prompts. Polling a
 * no-store endpoint is dumber, and dumber is right here.
 */

/** How long after mount before the first check. Long enough that a fresh
 * page load never races its own marker into a prompt. */
export const INITIAL_CHECK_DELAY_MS = 1_500;

/** Poll cadence. One request per open tab per interval — trivial against a
 * route that reads no database. */
export const POLL_INTERVAL_MS = 5 * 60 * 1000;

/**
 * After the user clicks Refresh, ignore this same marker for a while.
 *
 * Matters more here than on a CDN host: a Passenger restart can briefly keep
 * serving the old process, so a reload can land back on the OLD bundle. With
 * no guard that is an instant re-prompt, and the user is in a loop they
 * cannot escape by doing what we asked.
 */
export const REFRESH_GUARD_MS = 2 * 60 * 1000;

export const DISMISSED_KEY = "plank.version-update.dismissed";
export const REFRESH_GUARD_KEY = "plank.version-update.refresh-guard";

export type VersionManifest = { version?: unknown; buildId?: unknown; commit?: unknown };

/** A marker recorded with when it was recorded. */
export type MarkerRecord = { marker: string; timestamp: number };

function cleanMarker(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed === "unknown") return null;
  return trimmed;
}

/**
 * Every build marker a manifest offers.
 *
 * Accepts several field names because the endpoint this talks to may be a
 * purpose-built /version.json or the existing /api/health, which calls the
 * same value `version`. Rejecting one shape would make the feature silently
 * inert against the other.
 */
export function manifestMarkers(manifest: VersionManifest | null | undefined): string[] {
  if (!manifest || typeof manifest !== "object") return [];
  return [manifest.version, manifest.buildId, manifest.commit]
    .map(cleanMarker)
    .filter((m): m is string => m !== null);
}

/**
 * Is the server running something this page is not?
 *
 * FAILS TOWARD SILENCE, on purpose, in three ways: no current marker (local
 * dev, where DEPLOYMENT_VERSION is unset) never prompts; a manifest we could
 * not read never prompts; and a manifest that matches never prompts. A false
 * negative costs someone a stale tab until their next navigation. A false
 * positive interrupts them with a modal that is simply wrong, and does it on
 * every poll — so silence is the correct failure.
 */
export function isNewerBuild(
  currentMarker: string | null | undefined,
  manifest: VersionManifest | null | undefined
): boolean {
  const current = cleanMarker(currentMarker);
  if (!current) return false;
  const markers = manifestMarkers(manifest);
  if (markers.length === 0) return false;
  return !markers.includes(current);
}

function readRecord(storage: Storage | null, key: string): MarkerRecord | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<MarkerRecord>;
    const marker = cleanMarker(parsed?.marker);
    if (!marker || typeof parsed?.timestamp !== "number") return null;
    return { marker, timestamp: parsed.timestamp };
  } catch {
    // Storage can be unavailable (private mode, quota, blocked) or hold
    // something we did not write. Neither is a reason to fail.
    return null;
  }
}

export function writeRecord(storage: Storage | null, key: string, marker: string): void {
  if (!storage) return;
  try {
    storage.setItem(key, JSON.stringify({ marker, timestamp: Date.now() }));
  } catch {
    /* storage is optional — worst case the user sees the prompt again */
  }
}

/**
 * Should we stay quiet about this specific build?
 *
 * Two independent reasons:
 *  - DISMISSED ("Not now"), stored per-build and permanently. There is no
 *    timed re-nag: someone who declined this version has answered, and asking
 *    again in an hour is nagging, not helping. The NEXT build has a different
 *    marker and so prompts fresh.
 *  - REFRESH GUARD, short-lived, covering the window where a reload can land
 *    back on the old bundle (see REFRESH_GUARD_MS).
 */
export function shouldSuppressVersionPrompt(
  marker: string,
  opts: { local?: Storage | null; session?: Storage | null; now?: number } = {}
): boolean {
  const now = opts.now ?? Date.now();

  const dismissed = readRecord(opts.local ?? null, DISMISSED_KEY);
  if (dismissed && dismissed.marker === marker) return true;

  const guard = readRecord(opts.session ?? null, REFRESH_GUARD_KEY);
  if (guard && guard.marker === marker && now - guard.timestamp < REFRESH_GUARD_MS) {
    return true;
  }

  return false;
}
